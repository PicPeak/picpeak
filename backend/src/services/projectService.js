/**
 * projectService — the admin-only "Project Overview" grouping layer (Model A).
 *
 * A project groups 1..N events. Money documents stay attached to their EVENT
 * (or, for quotes/contracts which carry no event_id, to the CUSTOMER) and the
 * project rolls them up for the cockpit. Customers never see projects.
 *
 * Rollup scoping (v1):
 *   - invoices / emails / galleries → by the project's EVENTS (event_id).
 *   - hours                         → by customer_hour_entries.project_id.
 *   - quotes / contracts            → by the project's customer_account_id
 *     (they have no event_id; see migration 107). Empty when the project has
 *     no single customer set.
 */

const { db, logActivity } = require('../database/db');
const { AppError } = require('../utils/errors');
const { hasColumnCached } = require('../utils/schemaCache');
const { auditedUpdate } = require('./accountingHistory');
const { redactBearerLinks, hasMaskedRecoveryLink, parseEmailData, MASK } = require('../utils/emailSecretRedaction');
const {
  isEncryptedEmailData, isProtectedEmailType, maskSecretFields, PROTECTED_PENDING_STATUS,
} = require('../utils/emailQueueEncryption');

const PENDING_EMAIL_STATUSES = new Set(['pending', PROTECTED_PENDING_STATUS]);

function pendingStatusFor(row) {
  return isProtectedEmailType(row.email_type) && isEncryptedEmailData(parseEmailData(row.email_data))
    ? PROTECTED_PENDING_STATUS : 'pending';
}

// A sent invitation or password-reset mail no longer holds its link (see
// emailProcessor), so sending that row again would deliver a dead link.
// Any other account-recovery row that is no longer encrypted (a sent admin
// reset keeps only the masked password) cannot go back to pending either:
// the storage guard refuses it, so answer like System Health does.
async function assertResendable(row, { newMail = false } = {}) {
  // No administrative emails (migration 300), decided once, at queue time.
  // Retry / send-now act on THIS row, so only a row that was held back is
  // refused (while the switch is still on); a row queued before the switch
  // went on keeps its decision and goes out like the processor would send
  // it. Resend queues a NEW mail, which is a new decision: it asks the
  // switch as it is now, whatever happened to the old row.
  if ((newMail || row.status === 'suppressed') && await require('./_adminEmailOptOut').isRowHeldBack(row)) {
    throw new AppError('This customer takes no administrative emails, so this email isn\'t sent. Turn the switch off on the customer to send it.', 409, 'NO_ADMIN_EMAILS');
  }
  if (hasMaskedRecoveryLink(parseEmailData(row.email_data))) {
    throw new AppError('This invitation or password-reset email cannot be sent again: its link is not kept after sending. Send a new invitation or password reset instead.', 409);
  }
  if (isProtectedEmailType(row.email_type) && !isEncryptedEmailData(parseEmailData(row.email_data))) {
    throw new AppError('Create a new invitation or password reset; this recovery email cannot be retried.', 409);
  }
}

// `inquiry` → `active` → `completed`, plus `cancelled` (no job came of it).
// `archived` is the value older UIs could set; it stays accepted.
const PROJECT_STATUSES = ['inquiry', 'active', 'completed', 'cancelled', 'archived'];

// Which stages a job has. The stages a flow leaves out read `skipped`; a
// project can skip a further one by hand (skipped_stages). Inquiry and done
// are always there.
const PROJECT_FLOWS = {
  full: [],
  no_contract: ['contract'],
  no_quote: ['quote', 'contract'],
};
const SKIPPABLE_STAGES = ['quote', 'contract', 'gallery', 'invoice'];

function parseSkippedStages(value) {
  if (!value) return [];
  return String(value).split(',').map((x) => x.trim()).filter((x) => SKIPPABLE_STAGES.includes(x));
}

// The inquiry a project starts from (migration 315). API key → column.
const INQUIRY_FIELDS = {
  eventType: 'event_type',
  eventDate: 'event_date',
  eventEndDate: 'event_end_date',
  location: 'location',
  guestCount: 'guest_count',
  budgetMinor: 'budget_minor',
  currency: 'currency',
  source: 'source',
  notes: 'notes',
  flow: 'flow',
};
const DATE_FIELDS = new Set(['event_date', 'event_end_date']);
const INT_FIELDS = new Set(['guest_count', 'budget_minor']);

// PostgreSQL hands a `date` column back as a Date at local midnight, SQLite as
// the stored text. Both leave here as YYYY-MM-DD, so the editor and the
// document defaults see one shape.
function toDateOnly(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const pad = (n) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  return String(value).slice(0, 10);
}

function transformProject(p) {
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    customerAccountId: p.customer_account_id || null,
    customerEmail: p.customer_email || null,
    // How the customer is billed: a monthly or manual customer's invoices go
    // into one collected draft, so the page offers no project invoice for them.
    customerBillingCadence: p.customer_billing_cadence ?? undefined,
    status: p.status,
    eventCount: p.event_count != null ? Number(p.event_count) : undefined,
    eventType: p.event_type ?? null,
    eventDate: toDateOnly(p.event_date),
    eventEndDate: toDateOnly(p.event_end_date),
    location: p.location ?? null,
    guestCount: p.guest_count != null ? Number(p.guest_count) : null,
    budgetMinor: p.budget_minor != null ? Number(p.budget_minor) : null,
    currency: p.currency ?? null,
    source: p.source ?? null,
    notes: p.notes ?? null,
    flow: p.flow || 'full',
    skippedStages: parseSkippedStages(p.skipped_stages),
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

/** The project's end date may not come before its start date, whichever of
 *  the two an edit changes. */
function assertDateRange(row) {
  const start = toDateOnly(row.event_date);
  const end = toDateOnly(row.event_end_date);
  if (start && end && end < start) throw new AppError('The end date is before the start date', 400);
}

/** The inquiry columns `payload` sets, as a row patch. Keys left undefined are
 *  not touched; an empty value clears the column. Nothing is written on an
 *  instance that has not run migration 315. */
async function inquiryPatch(payload = {}) {
  const patch = {};
  if (!(await hasColumnCached('projects', 'notes'))) return patch;
  for (const [key, column] of Object.entries(INQUIRY_FIELDS)) {
    if (payload[key] === undefined) continue;
    let value = payload[key];
    if (value === '' || value === null) value = null;
    else if (DATE_FIELDS.has(column)) value = toDateOnly(value);
    else if (INT_FIELDS.has(column)) value = Math.trunc(Number(value));
    else value = String(value).trim() || null;
    if (column === 'currency' && value) value = value.toUpperCase();
    patch[column] = value;
  }
  if (payload.skippedStages !== undefined && await hasColumnCached('projects', 'skipped_stages')) {
    const list = Array.from(new Set((payload.skippedStages || []).filter((x) => SKIPPABLE_STAGES.includes(x))));
    patch.skipped_stages = list.length ? list.join(',') : null;
  }
  return patch;
}

const CHUNK = 500;

/**
 * The invoices that belong to each of `projectIds`, attributed to one project
 * each. An invoice belongs to a project through any of:
 *   - its gallery (events.project_id), the original rollup;
 *   - its own invoices.project_id (migration 315), set when it is created from
 *     the project, e.g. a deposit before any gallery exists;
 *   - its deal: the deal_uuid of a quote or contract linked to the project;
 *   - its original: a Storno or reissued invoice of one found above.
 * `columns` are invoice columns, selected unqualified.
 */
async function invoicesForProjects(projectIds, columns) {
  const found = new Map();
  if (!projectIds.length) return [];
  const keep = (rows) => {
    for (const r of rows) if (!found.has(r.id)) found.set(r.id, r);
  };
  // event_id always: the gallery decides which project an invoice belongs to.
  const cols = Array.from(new Set([...columns, 'event_id'])).map((c) => `inv.${c}`);

  keep(await db('invoices as inv')
    .join('events as e', 'e.id', 'inv.event_id')
    .whereIn('e.project_id', projectIds)
    .select('e.project_id as project_id', ...cols));

  if (await hasColumnCached('invoices', 'project_id')) {
    keep(await db('invoices as inv')
      .whereIn('inv.project_id', projectIds)
      .select('inv.project_id as project_id', ...cols.filter((c) => c !== 'inv.project_id')));
  }

  if (await hasColumnCached('invoices', 'deal_uuid')) {
    const dealToProject = new Map();
    for (const tbl of ['quotes', 'contracts']) {
      if (!(await hasColumnCached(tbl, 'project_id')) || !(await hasColumnCached(tbl, 'deal_uuid'))) continue;
      const rows = await db(tbl).whereIn('project_id', projectIds).whereNotNull('deal_uuid')
        .distinct('deal_uuid', 'project_id');
      for (const r of rows) if (!dealToProject.has(r.deal_uuid)) dealToProject.set(r.deal_uuid, r.project_id);
    }
    const deals = Array.from(dealToProject.keys());
    const ownColumn = await hasColumnCached('invoices', 'project_id');
    for (let i = 0; i < deals.length; i += CHUNK) {
      const rows = await db('invoices as inv').whereIn('inv.deal_uuid', deals.slice(i, i + CHUNK))
        .select(...cols, ...(ownColumn ? ['inv.project_id as __own_project'] : []));
      // An invoice tied to a project of its own belongs there, not to the
      // project its deal's quote or contract was attached to later.
      keep(rows
        .filter((r) => r.__own_project == null || Number(r.__own_project) === Number(dealToProject.get(r.deal_uuid)))
        .map(({ __own_project: _own, ...r }) => ({ ...r, project_id: dealToProject.get(r.deal_uuid) })));
    }
  }

  // An invoice whose gallery is in a project belongs to that project, whether
  // or not that project is among `projectIds`: its own project_id or deal
  // pointing elsewhere does not count it twice. One rule for the list, the
  // dashboard and the overview, whatever the status filter.
  const eventIds = Array.from(new Set(Array.from(found.values()).map((r) => r.event_id).filter((e) => e != null)));
  if (eventIds.length && await hasColumnCached('events', 'project_id')) {
    const eventProject = new Map();
    for (let i = 0; i < eventIds.length; i += CHUNK) {
      const evs = await db('events').whereIn('id', eventIds.slice(i, i + CHUNK)).whereNotNull('project_id').select('id', 'project_id');
      for (const e of evs) eventProject.set(e.id, e.project_id);
    }
    for (const [id, r] of found) {
      const owner = eventProject.get(r.event_id);
      if (owner != null && Number(owner) !== Number(r.project_id)) found.delete(id);
    }
  }

  // The Storno of a project's invoice and the invoice reissued for it follow
  // their original (cancels_invoice_id / replaces_invoice_id), whichever path
  // brought the original in: neither copies event, project or always the deal.
  const lineage = [];
  for (const column of ['cancels_invoice_id', 'replaces_invoice_id']) {
    if (await hasColumnCached('invoices', column)) lineage.push(column);
  }
  let frontier = Array.from(found.values());
  for (let depth = 0; lineage.length && frontier.length && depth < 5; depth += 1) {
    const projectOf = new Map(frontier.map((r) => [r.id, r.project_id]));
    const parents = Array.from(projectOf.keys());
    const next = [];
    for (let i = 0; i < parents.length; i += CHUNK) {
      const slice = parents.slice(i, i + CHUNK);
      const rows = await db('invoices as inv')
        .where((w) => { for (const column of lineage) w.orWhereIn(`inv.${column}`, slice); })
        .select(...cols, ...lineage.map((c) => `inv.${c} as __${c}`));
      for (const r of rows) {
        if (found.has(r.id)) continue;
        const parent = lineage.map((c) => r[`__${c}`]).find((v) => v != null && projectOf.has(v));
        const row = { ...r, project_id: projectOf.get(parent) };
        for (const c of lineage) delete row[`__${c}`];
        found.set(row.id, row);
        next.push(row);
      }
    }
    frontier = next;
  }
  return Array.from(found.values());
}

/** List projects with customer email + event count + rolled-up value.
 *  `perms` gates which document types feed the value (matches the cockpit):
 *  invoices need bills.view, quotes need quotes.view. */
async function listProjects({ search = '', status = null, perms = {}, projectIds = null, withStages = false } = {}) {
  let q = db('projects')
    .leftJoin('customer_accounts', 'customer_accounts.id', 'projects.customer_account_id')
    .select(
      'projects.*',
      'customer_accounts.email as customer_email',
      db('events').count('* as c').whereRaw('events.project_id = projects.id').as('event_count'),
    )
    .orderBy('projects.updated_at', 'desc');
  // Ownership allowlist (GHSA-wrg5). `null` = unrestricted; otherwise a knex
  // SUBQUERY of allowed ids (a plain array also works). The subquery keeps a
  // large project count off the driver's bind-parameter limit, and correctly
  // yields no rows for an admin who owns nothing.
  if (projectIds !== null) q = q.whereIn('projects.id', projectIds);
  if (Array.isArray(status) && status.length) q = q.whereIn('projects.status', status);
  else if (status && !Array.isArray(status)) q = q.where('projects.status', status);
  if (search) {
    q = q.where(function () {
      this.where('projects.name', 'like', `%${search}%`)
        .orWhere('customer_accounts.email', 'like', `%${search}%`);
    });
  }
  const rows = await q;
  const projects = rows.map(transformProject);
  await attachValuations(projects, perms);
  if (withStages) await attachStages(projects, perms);
  return projects;
}

/**
 * Compute + attach `valuation` to each listed project in two bulk queries
 * (not per-project), then run the shared newest-wins-per-deal helper. Mutates
 * the passed array. Documents the admin can't see (per perms) are excluded,
 * so the value never leaks figures the admin lacks permission for.
 */
async function attachValuations(projects, perms = {}) {
  if (!projects.length) return;
  const projectIds = projects.map((p) => p.id);

  // Invoices roll up by event, own project_id or deal; quotes by quotes.project_id.
  let invoices = [];
  if (perms.bills !== false) {
    invoices = await invoicesForProjects(projectIds,
      ['id', 'deal_uuid', 'total_amount_minor', 'paid_amount_minor', 'currency']);
  }
  let quotes = [];
  if (perms.quotes !== false && await hasColumnCached('quotes', 'project_id')) {
    quotes = await db('quotes')
      .whereIn('project_id', projectIds)
      .select('project_id', 'id', 'deal_uuid', 'total_amount_minor', 'currency', 'issue_date');
  } else if (perms.quotes !== false && await hasColumnCached('quotes', 'customer_account_id')) {
    // Pre-121 fallback: no quotes.project_id column yet. Scope quotes by the
    // project's customer (mirrors the detail page) so the list isn't all-zero
    // during the upgrade window. Imprecise when one customer owns several
    // projects — each then shows the customer's full quote total — but never
    // zero. Goes away the moment migration 121 lands.
    const custToProjects = new Map();
    for (const p of projects) {
      if (p.customerAccountId == null) continue;
      const list = custToProjects.get(p.customerAccountId) || [];
      list.push(p.id); custToProjects.set(p.customerAccountId, list);
    }
    if (custToProjects.size) {
      const rows = await db('quotes')
        .whereIn('customer_account_id', Array.from(custToProjects.keys()))
        .select('customer_account_id', 'id', 'deal_uuid', 'total_amount_minor', 'currency', 'issue_date');
      for (const r of rows) {
        for (const pid of (custToProjects.get(r.customer_account_id) || [])) {
          quotes.push({ ...r, project_id: pid });
        }
      }
    }
  }

  const invByProject = new Map();
  for (const inv of invoices) {
    const list = invByProject.get(inv.project_id) || [];
    list.push(inv); invByProject.set(inv.project_id, list);
  }
  const quoteByProject = new Map();
  for (const qt of quotes) {
    const list = quoteByProject.get(qt.project_id) || [];
    list.push(qt); quoteByProject.set(qt.project_id, list);
  }
  for (const p of projects) {
    p.valuation = computeValuation(invByProject.get(p.id) || [], quoteByProject.get(p.id) || []);
  }
}

async function getProjectById(id) {
  const row = await db('projects')
    .leftJoin('customer_accounts', 'customer_accounts.id', 'projects.customer_account_id')
    .select('projects.*', 'customer_accounts.email as customer_email',
      'customer_accounts.billing_cadence as customer_billing_cadence')
    .where('projects.id', id)
    .first();
  return transformProject(row);
}

async function createProject({ name, customerAccountId = null, status = 'active', ...fields }, adminId) {
  if (!name || !String(name).trim()) throw new AppError('Project name is required', 400);
  if (!PROJECT_STATUSES.includes(status)) throw new AppError('Unknown project status', 400, 'PROJECT_STATUS_UNKNOWN');
  const row = {
    name: String(name).trim(),
    customer_account_id: customerAccountId || null,
    status,
    ...(await inquiryPatch(fields)),
    created_at: new Date(),
    updated_at: new Date(),
  };
  assertDateRange(row);
  // Record the owner (GHSA-wrg5). adminId was already passed in and silently
  // discarded, which left a brand-new empty project with no derivable owner —
  // it has no linked events to infer one from yet. Guarded so an instance that
  // has not run migration 167 still creates projects.
  if (adminId && await hasColumnCached('projects', 'created_by')) {
    row.created_by = adminId;
  }
  const inserted = await db('projects').insert(row).returning('id');
  const id = (inserted[0] && typeof inserted[0] === 'object') ? inserted[0].id : inserted[0];
  return getProjectById(id);
}

/** Distinct customer_account_ids referenced by a project's linked content
 *  (its events, quotes and contracts). Used to keep a project single-customer:
 *  re-labelling it to a customer that conflicts with existing content is
 *  rejected. */
async function projectLinkedCustomerIds(id, conn = db) {
  const ids = new Set();
  if (await hasColumnCached('events', 'project_id') && await conn.schema.hasTable('event_customer_assignments')) {
    const rows = await conn('event_customer_assignments as eca')
      .join('events as e', 'e.id', 'eca.event_id')
      .where('e.project_id', id)
      .distinct('eca.customer_account_id as cid');
    for (const r of rows) if (r.cid != null) ids.add(Number(r.cid));
  }
  // Every linked document counts, not only the caller's: the rule is about the
  // project, and the CRM access layer would otherwise hide another admin's
  // quote from this read. Only customer ids leave this function.
  const { withTrustedCrmAccess } = require('../database/crmAccess');
  for (const tbl of ['quotes', 'contracts', 'invoices']) {
    if (await hasColumnCached(tbl, 'project_id') && await hasColumnCached(tbl, 'customer_account_id')) {
      const rows = await withTrustedCrmAccess('project single-customer rule',
        () => conn(tbl).where({ project_id: id }).whereNotNull('customer_account_id').distinct('customer_account_id as cid'));
      for (const r of rows) if (r.cid != null) ids.add(Number(r.cid));
    }
  }
  return ids;
}

/** Hold a project to `customerAccountId` for a new document: a project with no
 *  customer adopts it (first content wins, as assignEvent does), but only when
 *  nothing it already holds belongs to someone else. Atomic: the adoption is a
 *  conditional UPDATE, so two documents for different customers racing on an
 *  empty project cannot both win. Returns false when the project is another
 *  customer's, 'kept' when it already was this one's, 'adopted' when it became
 *  so now (undo with releaseAdoptedCustomer if the document is not created). */
async function holdProjectToCustomer(projectId, customerAccountId) {
  const cid = Number(customerAccountId);
  const project = await db('projects').where({ id: projectId }).first('customer_account_id');
  if (!project) return false;
  if (project.customer_account_id != null) return Number(project.customer_account_id) === cid ? 'kept' : false;
  for (const linked of await projectLinkedCustomerIds(projectId)) if (linked !== cid) return false;
  const changed = await db('projects').where({ id: projectId }).whereNull('customer_account_id')
    .update({ customer_account_id: cid, updated_at: new Date() });
  const after = await db('projects').where({ id: projectId }).first('customer_account_id');
  if (Number(after?.customer_account_id) !== cid) return false;
  return changed ? 'adopted' : 'kept';
}

/** Whether the project holds a gallery or a quote, contract or invoice
 *  (anyone's: the status describes the project, not the caller's view of it). */
async function projectHoldsAnything(id) {
  if (await hasColumnCached('events', 'project_id') && await db('events').where({ project_id: id }).first('id')) return true;
  const { withTrustedCrmAccess } = require('../database/crmAccess');
  for (const tbl of ['quotes', 'contracts', 'invoices']) {
    if (!(await hasColumnCached(tbl, 'project_id'))) continue;
    const row = await withTrustedCrmAccess('project status rule', () => db(tbl).where({ project_id: id }).first('id'));
    if (row) return true;
  }
  return false;
}

/** Undo an adoption by holdProjectToCustomer when the document it was for was
 *  not created, unless the project has meanwhile got something of that
 *  customer's to hold it. */
async function releaseAdoptedCustomer(projectId, customerAccountId) {
  if ((await projectLinkedCustomerIds(projectId)).size) return;
  await db('projects').where({ id: projectId, customer_account_id: Number(customerAccountId) })
    .update({ customer_account_id: null, updated_at: new Date() });
}

async function updateProject(id, { name, customerAccountId, status, ...fields }) {
  const existing = await db('projects').where({ id }).first();
  if (!existing) throw new AppError('Project not found', 404);
  const patch = { updated_at: new Date() };
  if (name !== undefined) patch.name = String(name).trim();
  if (customerAccountId !== undefined) {
    const next = customerAccountId || null;
    // Single-customer invariant: don't re-label a project to a customer that
    // conflicts with documents/events it already holds. Clearing (null) is fine.
    if (next != null) {
      const linked = await projectLinkedCustomerIds(id);
      for (const cid of linked) {
        if (cid !== Number(next)) {
          throw new AppError('This project already contains another customer’s content — clear or move it before reassigning the customer', 422, 'PROJECT_CUSTOMER_MISMATCH');
        }
      }
    }
    patch.customer_account_id = next;
  }
  if (status === 'reopen') {
    // Back to where it was before it closed: an inquiry while it holds
    // nothing, active otherwise. Decided here, on every linked record, not
    // from the caller's overview, which leaves out what they may not see.
    status = (await projectHoldsAnything(id)) ? 'active' : 'inquiry';
  }
  if (status !== undefined) {
    if (!PROJECT_STATUSES.includes(status)) throw new AppError('Unknown project status', 400, 'PROJECT_STATUS_UNKNOWN');
    // An inquiry is a project with nothing attached yet (promoteInquiry turns
    // it active on the first document); it cannot be set back on one that holds
    // galleries or documents.
    if (status === 'inquiry' && existing.status !== 'inquiry' && await projectHoldsAnything(id)) {
      throw new AppError('A project that holds galleries or documents cannot go back to an inquiry', 422, 'PROJECT_NOT_EMPTY');
    }
    patch.status = status;
  }
  Object.assign(patch, await inquiryPatch(fields));
  assertDateRange({ ...existing, ...patch });
  await db('projects').where({ id }).update(patch);
  // A document attached between the check above and this write found the
  // project closed, so nothing promoted it: an inquiry that holds something
  // turns active now.
  if (patch.status === 'inquiry' && await projectHoldsAnything(id)) await promoteInquiry(id);
  return getProjectById(id);
}

/** Delete a project. Its galleries, documents and hours stay and only lose the
 *  link: done explicitly, because SQLite runs without PRAGMA foreign_keys and
 *  the audited tables have to record the change (accountingHistoryReferences).
 *  `checked` is what the caller vetted (DELETE /projects/:id: the ids of the
 *  linked records per table, and of the galleries); the transaction reads
 *  them again and refuses when anything differs. On SQLite nothing can write
 *  in between (one writer); on PostgreSQL the window shrinks to the few
 *  statements after the re-read, since the attach paths take no lock on the
 *  project. */
async function deleteProject(id, actor = null, { checked = null } = {}) {
  const existing = await db('projects').where({ id }).first('id');
  if (!existing) throw new AppError('Project not found', 404);
  const { deleteWithAccountingHistory } = require('./accountingHistory');
  const { withTrustedCrmAccess } = require('../database/crmAccess');
  // Resolved before the transaction: on SQLite a query on the global
  // connection waits for the one the transaction holds.
  const eventsLinked = await hasColumnCached('events', 'project_id');
  const documentsLinked = await hasColumnCached('customer_documents', 'project_id');
  const tables = checked ? Object.keys(checked.ids) : [];
  await db.transaction(async (trx) => {
    if (checked) {
      const changed = () => new AppError('Something was added to the project meanwhile. Check it and delete again.', 409, 'PROJECT_CHANGED');
      const same = (a, b) => {
        const x = a.map(Number).sort((m, n) => m - n);
        const y = b.map(Number).sort((m, n) => m - n);
        return x.length === y.length && x.every((v, i) => v === y[i]);
      };
      for (const table of tables) {
        const now = await withTrustedCrmAccess('project delete: re-read in the transaction',
          () => trx(table).where({ project_id: id }).pluck('id'));
        if (!same(now, checked.ids[table])) throw changed();
      }
      if (eventsLinked && !same(await trx('events').where({ project_id: id }).pluck('id'), checked.eventIds)) throw changed();
    }
    if (eventsLinked) {
      await trx('events').where({ project_id: id }).update({ project_id: null });
    }
    if (documentsLinked) {
      await trx('customer_documents').where({ project_id: id }).update({ project_id: null });
    }
    await deleteWithAccountingHistory(trx, 'projects', { id },
      { actor: actor?.id ?? null, source: 'project.delete' });
  });
  return { id };
}

/** An inquiry becomes an active project the moment something is attached to
 *  it: a quote, contract, gallery or invoice. Any other status is left alone. */
async function promoteInquiry(projectId, conn = db) {
  await conn('projects').where({ id: projectId, status: 'inquiry' })
    .update({ status: 'active', updated_at: new Date() });
}

/** Distinct customer_account_ids an event is assigned to (event_customer_assignments
 *  is many-to-many, but a gallery normally belongs to exactly one account). */
async function eventCustomerIds(eventId, conn = db) {
  if (!(await conn.schema.hasTable('event_customer_assignments'))) return [];
  const rows = await conn('event_customer_assignments')
    .where({ event_id: eventId })
    .distinct('customer_account_id');
  return rows.map((r) => r.customer_account_id).filter((x) => x != null).map(Number);
}

/** Attach an event to a project (re-points events.project_id).
 *  Projects are single-customer: an event may only join a project that shares
 *  its customer. When the project has no customer yet it ADOPTS the event's
 *  (single) customer — keeping the whole project tied to one customer. */
async function assignEvent(projectId, eventId) {
  const project = await db('projects').where({ id: projectId }).first();
  if (!project) throw new AppError('Project not found', 404);
  const event = await db('events').where({ id: eventId }).first();
  if (!event) throw new AppError('Event not found', 404);

  const evCustomers = await eventCustomerIds(eventId);
  if (project.customer_account_id != null) {
    if (evCustomers.length && !evCustomers.includes(Number(project.customer_account_id))) {
      throw new AppError('That event belongs to a different customer than this project', 422, 'PROJECT_CUSTOMER_MISMATCH');
    }
  } else if (evCustomers.length === 1) {
    // Empty project adopts the event's single customer (first content wins).
    await db('projects').where({ id: projectId }).update({ customer_account_id: evCustomers[0], updated_at: new Date() });
  }

  await db('events').where({ id: eventId }).update({ project_id: projectId });
  await promoteInquiry(projectId);
  return { projectId, eventId };
}

/**
 * Resolve `actor.roleName`, looking it up when the caller only had an admin id
 * to hand (the quote/contract create+update paths thread `adminId`, not the
 * full req.admin). Fails CLOSED — an unresolvable role is treated as scoped,
 * never as super_admin.
 */
async function isSuperAdmin(actor, conn = db) {
  if (!actor) return false;
  if (actor.roleName !== undefined) return actor.roleName === 'super_admin';
  try {
    const row = await conn('admin_users')
      .leftJoin('roles', 'roles.id', 'admin_users.role_id')
      .where('admin_users.id', actor.id)
      .first('roles.name as role_name');
    return row?.role_name === 'super_admin';
  } catch (err) {
    return false;
  }
}

/**
 * The project a document made by `adminId` from another document may keep
 * (quote → contract, quote/contract → gallery), or null. Resolve it before
 * opening the conversion's transaction (global db reads).
 *  - With the projects feature off, none: nothing changes for such installs.
 *  - A super admin keeps any.
 *  - `target: 'documents'` (a contract, an invoice): a project the caller
 *    created. That is the rule the CRM access layer applies to project_id on
 *    a quote, contract or invoice write (crmAccess validateWrite), so a
 *    carried link never fails the write.
 *  - `target: 'events'`: a project the converter owns as the project routes
 *    see it (ownedProjectsSubquery, legacy ownerless projects included), so a
 *    gallery never lands in another admin's project. An unattended workflow
 *    step (no admin) keeps the source document's own project: no person is
 *    acting, so there is no one to leak it to.
 */
async function carriedProjectId(projectId, adminId, { target = 'documents' } = {}) {
  if (!projectId) return null;
  const { isFeatureEnabled } = require('../middleware/requireFeatureFlag');
  if (!(await isFeatureEnabled('projects'))) return null;
  if (!adminId) return target === 'events' ? projectId : null;
  if (await isSuperAdmin({ id: adminId })) return projectId;
  let q = db('projects').where('projects.id', projectId);
  if (target === 'events') {
    const owned = require('../middleware/ownership').ownedProjectsSubquery({ id: adminId });
    if (owned !== null) q = q.whereIn('projects.id', owned);
  } else {
    q = q.where('projects.created_by', adminId);
  }
  const row = await q.first('projects.id');
  return row ? row.id : null;
}

/**
 * Cascade a project link across a whole deal's lineage. Given a deal_uuid, link
 * every quote + contract in that deal to the project, re-point every event the
 * deal produced (so its invoices / emails / gallery roll up automatically), and
 * adopt the deal's customer onto the project when it has none. This is what
 * makes "drop a quote on an empty project" fill the cockpit with the linked
 * contract, event and invoices. Idempotent; pass a trx to run inside a txn.
 *
 * `actor` (req.admin) enables the ownership guard below and MUST be supplied by
 * any admin-facing caller — route-level project ownership only vets the
 * destination, while this function re-points the deal's events into it.
 */
async function linkDealToProject(dealUuid, projectId, conn = db, actor = null) {
  if (!projectId) return;

  // Ownership of the DESTINATION. `attachDocumentToProject` reaches here behind
  // requireProjectOwnership, but the quote/contract create+update paths do not:
  // adminQuotes.js / adminContracts.js take `projectId` straight from the body
  // behind `quotes.manage` / `contracts.manage`, which are permissions, not
  // ownership. So the destination has to be vetted here, at the one choke point
  // every caller shares, rather than relying on a route guard three of the four
  // callers never had.
  //
  // Without it a scoped admin could point a new quote at a project they do not
  // own: the lineage check below is skipped when the deal has produced no event
  // yet (`eventIds.size` is 0), and an unassigned project ADOPTS the deal's
  // customer instead of rejecting it. That writes their document into another
  // admin's cockpit, and on an OWNERLESS project (created_by IS NULL — legacy
  // rows migration 167's backfill could not attribute) it escalates: once the
  // quote converts to an event, that event becomes the project's only linked
  // event, which is exactly the condition ownedProjectsSubquery's second branch
  // grants ownership on — handing the caller read access to whatever documents
  // were already attached there.
  //
  // Mirrors ownedProjectsSubquery (middleware/ownership.js) rather than calling
  // it, because that helper binds the module-level `db` and this runs inside the
  // caller's transaction.
  if (actor?.id && !(await isSuperAdmin(actor, conn))) {
    const owned = await conn('projects')
      .where({ id: projectId })
      .where((w) => {
        w.where('created_by', actor.id)
          .orWhere((noOwner) => {
            noOwner
              .where((c) => c
                .whereNull('created_by')
                .orWhereNotIn('created_by', conn('admin_users').select('id')))
              .whereExists(
                conn('events').select(conn.raw('1')).whereRaw('events.project_id = projects.id'),
              )
              .whereNotExists(
                conn('events').select(conn.raw('1')).whereRaw('events.project_id = projects.id')
                  .whereNotNull('events.created_by').whereNot('events.created_by', actor.id),
              );
          });
      })
      .first('id');
    if (!owned) {
      throw new AppError('Project not found', 404, 'PROJECT_NOT_FOUND');
    }
  }

  // Nothing to cascade without a deal, but the destination above still had
  // to be vetted: every caller writes `project_id` onto its own row BEFORE
  // calling us, and `deal_uuid` is nullable (migration 107). A legacy quote
  // with no deal would otherwise return here having bypassed the check while
  // its foreign project link stood. The caller linked a document, so an
  // inquiry turns active, here and after the last check below.
  if (!dealUuid) { await promoteInquiry(projectId, conn); return; }

  // Collect ALL the deal's customers across its quote/contract/invoice lineage
  // AND every event it converted into — BEFORE mutating anything, so a link
  // with no matching customer is rejected before we re-point data across tenants.
  const eventIds = new Set();
  const dealCustomerIds = new Set();
  const quotesHaveDeal = await hasColumnCached('quotes', 'deal_uuid');
  if (quotesHaveDeal) {
    for (const q of await conn('quotes').where({ deal_uuid: dealUuid }).select('converted_event_id', 'customer_account_id')) {
      if (q.converted_event_id) eventIds.add(q.converted_event_id);
      if (q.customer_account_id != null) dealCustomerIds.add(Number(q.customer_account_id));
    }
  }
  const contractsHaveDeal = await hasColumnCached('contracts', 'deal_uuid');
  if (contractsHaveDeal && await hasColumnCached('contracts', 'converted_event_id')) {
    for (const c of await conn('contracts').where({ deal_uuid: dealUuid }).select('converted_event_id', 'customer_account_id')) {
      if (c.converted_event_id) eventIds.add(c.converted_event_id);
      if (c.customer_account_id != null) dealCustomerIds.add(Number(c.customer_account_id));
    }
  }
  if (await hasColumnCached('invoices', 'deal_uuid')) {
    for (const inv of await conn('invoices').where({ deal_uuid: dealUuid }).select('event_id', 'customer_account_id')) {
      if (inv.event_id) eventIds.add(inv.event_id);
      if (inv.customer_account_id != null) dealCustomerIds.add(Number(inv.customer_account_id));
    }
  }

  // Single-customer projects, "one customer matches" rule: a customer-assigned
  // project rejects the deal only when NONE of the deal's customers is the
  // project's customer. An *unassigned* project (customer_account_id null)
  // ADOPTS the deal's customer below — "drop the first deal on an empty project".
  const project = await conn('projects').where({ id: projectId }).select('customer_account_id').first();
  if (!project) throw new AppError('Project not found', 404, 'PROJECT_NOT_FOUND');
  if (
    project.customer_account_id != null &&
    dealCustomerIds.size &&
    !dealCustomerIds.has(Number(project.customer_account_id))
  ) {
    throw new AppError('That belongs to a different customer than this project', 422, 'PROJECT_CUSTOMER_MISMATCH');
  }

  // Ownership of the LINEAGE, not just the destination (GHSA-wrg5). The writes
  // below re-point every event this deal produced into it. Without this check an
  // editor could create an empty project, attach another admin's quote, and
  // pull that admin's events — plus the invoices, emails and gallery that roll
  // up with them — into a project they own and can read via /:id/overview.
  // An unassigned project offers no resistance either, since it ADOPTS the
  // deal's customer below rather than rejecting it.
  //
  // Events are the only ownership signal a deal carries: quotes/contracts have
  // no created_by in this schema, so a deal whose lineage produced no event
  // still cannot be attributed to an admin — a pre-existing property of the CRM
  // model, not something this guard can close.
  if (actor?.id && eventIds.size && !(await isSuperAdmin(actor, conn))) {
    const ownable = await conn('events')
      .whereIn('id', Array.from(eventIds))
      .andWhere((q) => q.whereNull('created_by').orWhere('created_by', actor.id))
      .pluck('id');
    if (ownable.length !== eventIds.size) {
      throw new AppError(
        'That deal includes events that are not yours to move', 403, 'DEAL_EVENT_FORBIDDEN',
      );
    }
  }

  // Cleared to write: link the deal's quotes/contracts, re-point its events so
  // invoices/emails/gallery roll up automatically.
  const history = { actor: actor?.id ?? null, source: 'project.link_deal' };
  if (quotesHaveDeal && await hasColumnCached('quotes', 'project_id')) {
    await auditedUpdate(conn, 'quotes', { deal_uuid: dealUuid }, { project_id: projectId }, history);
  }
  if (contractsHaveDeal && await hasColumnCached('contracts', 'project_id')) {
    await auditedUpdate(conn, 'contracts', { deal_uuid: dealUuid }, { project_id: projectId }, history);
  }
  // A deal lives in one project: its invoices tied to a project of their own
  // (created in or attached to one, migration 315) move with it, or the deal
  // would count in two projects. Invoices without one follow the deal anyway.
  if (await hasColumnCached('invoices', 'deal_uuid') && await hasColumnCached('invoices', 'project_id')) {
    await auditedUpdate(conn, 'invoices',
      (q) => q.where({ deal_uuid: dealUuid }).whereNotNull('project_id').whereNot('project_id', projectId),
      { project_id: projectId }, history);
  }
  if (eventIds.size && await hasColumnCached('events', 'project_id')) {
    await conn('events').whereIn('id', Array.from(eventIds)).update({ project_id: projectId });
  }

  // Adopt the deal's customer onto a still-unassigned project (first deal wins).
  if (dealCustomerIds.size && project.customer_account_id == null) {
    const adopt = [...dealCustomerIds][0];
    await conn('projects').where({ id: projectId }).update({ customer_account_id: adopt, updated_at: new Date() });
  }

  // Every check has passed and the document is linked: an inquiry turns active.
  await promoteInquiry(projectId, conn);
}

/** Attach (or, with projectId=null, detach) a quote/contract to a project.
 *  Attaching cascades the link across the deal lineage (see linkDealToProject). */
async function assignDocument(table, projectId, documentId, actor = null) {
  if (!(await hasColumnCached(table, 'project_id'))) {
    throw new AppError('This instance has no project_id column yet — run migrations', 409);
  }
  let project = null;
  if (projectId != null) {
    project = await db('projects').where({ id: projectId }).first();
    if (!project) throw new AppError('Project not found', 404);
  }
  const doc = await db(table).where({ id: documentId }).first();
  if (!doc) throw new AppError('Document not found', 404);
  // Single-customer guard: a document carries exactly one customer, so it may
  // only attach to a project that shares it. linkDealToProject re-checks the
  // wider deal lineage ("one customer matches"); this is the boundary check
  // that also covers the (unassigned-project) detach and standalone-doc cases.
  if (
    project &&
    project.customer_account_id != null &&
    doc.customer_account_id != null &&
    project.customer_account_id !== doc.customer_account_id
  ) {
    throw new AppError('That belongs to a different customer than this project', 422, 'PROJECT_CUSTOMER_MISMATCH');
  }
  // Cascade FIRST, then stamp this document. linkDealToProject runs the
  // lineage-ownership guard and throws before it writes anything, so a refused
  // attach leaves no half-applied link behind — the other order committed the
  // foreign document into the caller's project and only then refused the
  // cascade. It already stamps this row's project_id via the deal_uuid sweep;
  // the update below covers the standalone (no-deal) document.
  if (projectId && doc.deal_uuid) {
    await linkDealToProject(doc.deal_uuid, projectId, db, actor);
  }
  await auditedUpdate(db, table, { id: documentId }, { project_id: projectId || null },
    { actor: actor?.id ?? null, source: 'project.assign_document' });
  if (projectId) await promoteInquiry(projectId);
  return { projectId: projectId || null, documentId };
}

const assignQuote = (projectId, quoteId, actor) => assignDocument('quotes', projectId, quoteId, actor);
const assignContract = (projectId, contractId, actor) => assignDocument('contracts', projectId, contractId, actor);

/**
 * Whether any record of deal `dealUuid` is linked to a project other than
 * `projectId`: a quote, contract or invoice of it, a gallery one of its quotes
 * or contracts was converted into, or the gallery of one of its invoices.
 * linkDealToProject moves every one of those. Unscoped: another admin's
 * records count. `conn` is a transaction when re-checking inside one.
 */
async function dealProjectElsewhere(dealUuid, projectId, conn = db) {
  const { withTrustedCrmAccess } = require('../database/crmAccess');
  return withTrustedCrmAccess('project attach: deal lineage elsewhere', async () => {
    const galleries = [];
    for (const tbl of ['quotes', 'contracts', 'invoices']) {
      if (!(await hasColumnCached(tbl, 'deal_uuid')) || !(await hasColumnCached(tbl, 'project_id'))) continue;
      const elsewhere = await conn(tbl).where({ deal_uuid: dealUuid })
        .whereNotNull('project_id').whereNot('project_id', projectId).first('id');
      if (elsewhere) return true;
      const galleryColumn = tbl === 'invoices' ? 'event_id' : 'converted_event_id';
      if (await hasColumnCached(tbl, galleryColumn)) {
        galleries.push(...await conn(tbl).where({ deal_uuid: dealUuid }).whereNotNull(galleryColumn).pluck(galleryColumn));
      }
    }
    if (galleries.length && await hasColumnCached('events', 'project_id')) {
      const moved = await conn('events').whereIn('id', Array.from(new Set(galleries)))
        .whereNotNull('project_id').whereNot('project_id', projectId).first('id');
      if (moved) return true;
    }
    return false;
  });
}

/**
 * For the add window: whether attaching quote or contract `doc` to project
 * `projectId` takes anything out of another project. linkDealToProject moves
 * the whole deal, so this is the document itself or any record of its deal
 * (dealProjectElsewhere), including an invoice tied to another project.
 */
async function documentAttachMoves(doc, projectId, dealCache = null) {
  if (doc.project_id != null && Number(doc.project_id) !== Number(projectId)) return true;
  if (!doc.deal_uuid) return false;
  if (dealCache?.has(doc.deal_uuid)) return dealCache.get(doc.deal_uuid);
  const elsewhere = !!(await dealProjectElsewhere(doc.deal_uuid, projectId));
  dealCache?.set(doc.deal_uuid, elsewhere);
  return elsewhere;
}

/**
 * documentAttachMoves for each listed quote or contract (GET /quotes or
 * /contracts ?attachTo=), or null when the projects feature is off or the
 * caller may not work on that project: the rule reads other projects
 * unscoped.
 */
async function attachMovesFor(admin, rows, projectId) {
  if (!projectId) return null;
  const { isFeatureEnabled } = require('../middleware/requireFeatureFlag');
  const { ownsProject } = require('../middleware/ownership');
  if (!(await isFeatureEnabled('projects')) || !(await ownsProject(admin, projectId))) return null;
  // A deal's lineage is read once, however many listed rows share it.
  const dealCache = new Map();
  const moves = [];
  for (const row of rows) moves.push(await documentAttachMoves(row, projectId, dealCache));
  return moves;
}

/**
 * Why invoice `inv` may not join project `projectId`, or null when it may.
 * One rule for the attach (before and inside its transaction) and for the
 * add window (GET /invoices?attachTo=), so the window never offers what the
 * attach refuses. `inv` needs id, project_id, deal_uuid, event_id and, where
 * the columns exist, is_monthly_draft and monthly_period_start.
 */
async function invoiceAttachRefusal(inv, projectId, conn = db) {
  // A monthly or manual customer's collected invoice spans their galleries,
  // so it cannot belong to one project (as POST /invoices refuses it).
  if (truthyFlag(inv.is_monthly_draft) || inv.monthly_period_start != null) {
    return { status: 422, code: 'PROJECT_INVOICE_COLLECTED_BILLING', message: 'A collected monthly or manual invoice cannot belong to one project' };
  }
  if (inv.project_id != null && Number(inv.project_id) !== Number(projectId)) {
    return { status: 422, code: 'PROJECT_INVOICE_ELSEWHERE', message: 'This invoice belongs to another project' };
  }
  if (inv.deal_uuid && await dealProjectElsewhere(inv.deal_uuid, projectId, conn)) {
    return { status: 422, code: 'PROJECT_DEAL_ELSEWHERE', message: 'Its quote, contract or another invoice of the same deal belongs to another project' };
  }
  if (inv.event_id && await hasColumnCached('events', 'project_id')) {
    const event = await conn('events').where({ id: inv.event_id }).first('project_id');
    if (event?.project_id != null && Number(event.project_id) !== Number(projectId)) {
      return { status: 422, code: 'PROJECT_EVENT_MISMATCH', message: 'This invoice’s gallery belongs to another project' };
    }
  }
  return null;
}

const truthyFlag = (v) => v === true || v === 1 || v === '1' || v === 't';
const INVOICE_ATTACH_COLUMNS = ['id', 'event_id', 'deal_uuid', 'customer_account_id', 'project_id'];

/**
 * Attach an existing invoice, e.g. to set up a project for a job that is
 * already finished. Only `project_id` changes, never the issued invoice
 * itself. Its deal comes along (linkDealToProject: quotes, contracts, sibling
 * invoices and the galleries they made), and so does its gallery when that is
 * in no project yet. Its Storno and reissue follow through the lineage rollup.
 *
 * Refused before anything is written when the caller may not tie documents to
 * this project (the CRM write rule, the same carriedProjectId the cockpit's
 * documentsLinkable reports), for any reason invoiceAttachRefusal gives, or
 * when it or its gallery is another customer's. The transaction locks the
 * invoice row and checks invoiceAttachRefusal again, so two attaches (or an
 * attach and a quote attach moving the deal) cannot both pass; a refusal
 * leaves nothing behind, and a customer the empty project adopted is given
 * back. The caller's route vets the gallery owner.
 */
async function assignInvoice(projectId, invoiceId, actor = null) {
  if (!(await hasColumnCached('invoices', 'project_id'))) {
    throw new AppError('This instance has no invoices.project_id column yet — run migrations', 409);
  }
  const project = await db('projects').where({ id: projectId }).first('id');
  if (!project) throw new AppError('Project not found', 404);
  if (actor?.id && !(await carriedProjectId(projectId, actor.id))) {
    throw new AppError('Documents can join only a project you created', 403, 'PROJECT_NOT_LINKABLE');
  }
  const columns = [...INVOICE_ATTACH_COLUMNS];
  for (const c of ['is_monthly_draft', 'monthly_period_start']) if (await hasColumnCached('invoices', c)) columns.push(c);
  const inv = await db('invoices').where({ id: invoiceId }).first(columns);
  if (!inv) throw new AppError('Invoice not found', 404);
  const refusal = await invoiceAttachRefusal(inv, projectId);
  if (refusal) throw new AppError(refusal.message, refusal.status, refusal.code);

  const eventsLinked = await hasColumnCached('events', 'project_id');
  const event = inv.event_id && eventsLinked ? await db('events').where({ id: inv.event_id }).first('id', 'project_id') : null;

  // Projects hold one customer: the invoice's, and its gallery's (as
  // assignEvent checks it). An empty project adopts the first.
  const adopted = [];
  const hold = async (customerAccountId) => {
    const held = await holdProjectToCustomer(projectId, customerAccountId);
    if (!held) throw new AppError('That belongs to a different customer than this project', 422, 'PROJECT_CUSTOMER_MISMATCH');
    if (held === 'adopted') adopted.push(customerAccountId);
  };
  const release = async () => {
    for (const cid of adopted) await releaseAdoptedCustomer(projectId, cid);
  };
  try {
    if (inv.customer_account_id != null) await hold(inv.customer_account_id);
    if (event && event.project_id == null) {
      const evCustomers = await eventCustomerIds(event.id);
      const current = (await db('projects').where({ id: projectId }).first('customer_account_id'))?.customer_account_id;
      if (current != null && evCustomers.length && !evCustomers.includes(Number(current))) {
        throw new AppError('That belongs to a different customer than this project', 422, 'PROJECT_CUSTOMER_MISMATCH');
      }
      if (current == null && evCustomers.length === 1) await hold(evCustomers[0]);
    }
  } catch (err) {
    await release();
    throw err;
  }

  // Resolved before the transaction: on SQLite a query on the global
  // connection waits for the one the transaction holds.
  for (const [table, column] of [['quotes', 'deal_uuid'], ['quotes', 'project_id'], ['quotes', 'converted_event_id'],
    ['contracts', 'deal_uuid'], ['contracts', 'project_id'], ['contracts', 'converted_event_id'], ['invoices', 'deal_uuid'],
    ['invoices', 'event_id']]) {
    await hasColumnCached(table, column);
  }
  try {
    await db.transaction(async (trx) => {
      // Lock the invoice and check again: what was read above may have
      // changed by now (another attach, a quote attach moving the deal).
      const lock = trx('invoices').where({ id: invoiceId }).first(columns);
      if (trx.client.config.client === 'pg') lock.forUpdate();
      const locked = await lock;
      if (!locked) throw new AppError('Invoice not found', 404);
      const late = await invoiceAttachRefusal(locked, projectId, trx);
      if (late) throw new AppError(late.message, late.status, late.code);
      if (inv.deal_uuid) await linkDealToProject(inv.deal_uuid, projectId, trx, actor);
      if (event && event.project_id == null) {
        // Conditional: a gallery moved into another project meanwhile is refused.
        const moved = await trx('events').where({ id: event.id })
          .where((w) => w.whereNull('project_id').orWhere('project_id', projectId))
          .update({ project_id: projectId });
        if (!moved) throw new AppError('This invoice’s gallery belongs to another project', 422, 'PROJECT_EVENT_MISMATCH');
      }
      await auditedUpdate(trx, 'invoices', { id: invoiceId }, { project_id: projectId },
        { actor: actor?.id ?? null, source: 'project.assign_invoice' });
      await promoteInquiry(projectId, trx);
    });
  } catch (err) {
    await release();
    throw err;
  }
  return { projectId, invoiceId };
}

/**
 * Take an invoice out of the project it was created in or attached to
 * (clears invoices.project_id, audited). Only an invoice tied to this project
 * by its own project_id: one that rolls up through its gallery or deal leaves
 * with that gallery or document. The same write rule as attaching.
 */
async function unassignInvoice(projectId, invoiceId, actor = null) {
  if (!(await hasColumnCached('invoices', 'project_id'))) {
    throw new AppError('This instance has no invoices.project_id column yet — run migrations', 409);
  }
  if (actor?.id && !(await carriedProjectId(projectId, actor.id))) {
    throw new AppError('Documents can join only a project you created', 403, 'PROJECT_NOT_LINKABLE');
  }
  const inv = await db('invoices').where({ id: invoiceId }).first('id', 'project_id');
  if (!inv) throw new AppError('Invoice not found', 404);
  if (Number(inv.project_id) !== Number(projectId)) {
    throw new AppError('This invoice is in the project through its gallery or deal; move that instead', 422, 'PROJECT_INVOICE_NOT_DIRECT');
  }
  await auditedUpdate(db, 'invoices', { id: invoiceId, project_id: projectId }, { project_id: null },
    { actor: actor?.id ?? null, source: 'project.unassign_invoice' });
  return { projectId, invoiceId };
}

/**
 * Project valuation — "newest stage wins per deal, cumulative across events".
 *
 * Each deal (deal_uuid lineage: quote → contract → invoice) contributes ONE
 * figure: the invoice total when the deal has reached invoicing (installments
 * summed; storno rows net out a cancelled invoice via their negative totals),
 * otherwise the newest quote's total. Contracts carry no monetary total in
 * picpeak, so they never contribute a number — the "newest" of the three is
 * therefore always the invoice when present, else the quote. Documents with
 * no deal_uuid each count as their own standalone deal. Totals are kept per
 * currency so a mixed-currency project stays correct.
 *
 * @param {Array} invoices  rows with deal_uuid, total_amount_minor, paid_amount_minor, currency
 * @param {Array} quotes    rows with deal_uuid, total_amount_minor, currency, issue_date
 * @returns {{ byCurrency: Array<{currency:string,totalMinor:number,paidMinor:number}> }}
 */
function computeValuation(invoices = [], quotes = []) {
  const deals = new Map();
  const get = (key, currency) => {
    let d = deals.get(key);
    if (!d) { d = { currency, invoiceMinor: 0, paidMinor: 0, hasInvoice: false, quoteMinor: 0, quoteDate: null }; deals.set(key, d); }
    return d;
  };
  for (const inv of invoices) {
    const d = get(inv.deal_uuid || `i-${inv.id}`, inv.currency || 'CHF');
    d.hasInvoice = true;
    d.invoiceMinor += Number(inv.total_amount_minor || 0);
    d.paidMinor += Number(inv.paid_amount_minor || 0);
    d.currency = inv.currency || d.currency;
  }
  for (const q of quotes) {
    const d = get(q.deal_uuid || `q-${q.id}`, q.currency || 'CHF');
    const qd = q.issue_date ? new Date(q.issue_date).getTime() : 0;
    if (d.quoteDate === null || qd >= d.quoteDate) {
      d.quoteMinor = Number(q.total_amount_minor || 0);
      d.quoteDate = qd;
      if (!d.hasInvoice) d.currency = q.currency || d.currency;
    }
  }
  const byCurrency = new Map();
  for (const d of deals.values()) {
    const value = d.hasInvoice ? d.invoiceMinor : d.quoteMinor;
    const cur = d.currency || 'CHF';
    const b = byCurrency.get(cur) || { totalMinor: 0, paidMinor: 0 };
    b.totalMinor += value;
    b.paidMinor += d.paidMinor;
    byCurrency.set(cur, b);
  }
  return {
    byCurrency: Array.from(byCurrency.entries()).map(([currency, v]) => ({
      currency, totalMinor: v.totalMinor, paidMinor: v.paidMinor,
    })),
  };
}

// ── Stages ──────────────────────────────────────────────────────────────
//
// Where a project stands, derived from what it holds rather than set by hand,
// so a quote created outside the project flow still moves it forward:
//   inquiry  — always done once the project exists;
//   quote    — a quote was accepted (or already converted);
//   contract — a contract is fully signed;
//   gallery  — a gallery was published (expiry does not undo it);
//   invoice  — it has invoices and every one that still counts is paid;
//   done     — the admin completed the project.
// A stage that is not done while a later one is reads `skipped`. The first
// stage after the last done one is `current`; on a cancelled project it reads
// `cancelled` instead (where the job stopped) and the rest stay `todo`; a
// completed project has no current stage either. A stage whose documents the
// admin may not see reads `hidden`.
const STAGES = ['inquiry', 'quote', 'contract', 'gallery', 'invoice', 'done'];
const QUOTE_DONE = new Set(['accepted', 'converted']);
const CONTRACT_DONE = new Set(['fully_signed']);
const INVOICE_IGNORED = new Set(['cancelled', 'skipped', 'draft']);

const truthy = (v) => v === true || v === 1 || v === '1';

function deriveStages({ status, flow, skippedStages = [], quotes = [], contracts = [], events = [], invoices = [] }, perms = {}) {
  const counting = invoices.filter((inv) => inv.kind !== 'storno' && !INVOICE_IGNORED.has(inv.status));
  const done = {
    inquiry: true,
    quote: quotes.some((q) => QUOTE_DONE.has(q.status)),
    contract: contracts.some((c) => CONTRACT_DONE.has(c.status)),
    // Published once is done: an expired gallery (is_active off) stays done.
    gallery: events.some((e) => !truthy(e.is_draft)),
    invoice: counting.length > 0 && counting.every((inv) => inv.status === 'paid'),
    done: status === 'completed',
  };
  const hidden = { quote: perms.quotes === false, contract: perms.contracts === false, invoice: perms.bills === false };
  // Left out by the project's flow or skipped by hand. A stage that is done
  // anyway (a contract signed after all) still reads done.
  const leftOut = new Set([...(PROJECT_FLOWS[flow] || []), ...(skippedStages || [])]);
  let lastDone = -1;
  STAGES.forEach((key, i) => { if (done[key] && !hidden[key]) lastDone = i; });
  const completed = status === 'completed';
  const cancelled = status === 'cancelled';
  let current = null;
  let stoppedAt = null;
  const stages = STAGES.map((key, i) => {
    let state;
    // Where a cancelled job stopped is the first stage after the last done one,
    // whether or not this admin may see it: a hidden stage stays hidden, and the
    // cross is not moved onto a later stage it never reached.
    const left = leftOut.has(key) && !done[key];
    if (cancelled && stoppedAt === null && !done[key] && !left && i > lastDone) {
      stoppedAt = key;
      state = hidden[key] ? 'hidden' : 'cancelled';
    } else if (hidden[key]) state = 'hidden';
    else if (done[key]) state = 'done';
    else if (left) state = 'skipped';
    else if (i < lastDone || (completed && key !== 'done')) state = 'skipped';
    else if (!completed && !cancelled && current === null) { state = 'current'; current = key; }
    else state = 'todo';
    return { key, state };
  });
  return { stages, current };
}

/** Attach `stage` ({ stages, current }) to each listed project, in bulk. */
async function attachStages(projects, perms = {}) {
  if (!projects.length) return;
  const ids = projects.map((p) => p.id);
  const group = (rows) => {
    const m = new Map();
    for (const r of rows) { const l = m.get(r.project_id) || []; l.push(r); m.set(r.project_id, l); }
    return m;
  };
  const quotes = perms.quotes !== false && await hasColumnCached('quotes', 'project_id')
    ? group(await db('quotes').whereIn('project_id', ids).select('project_id', 'status')) : new Map();
  const contracts = perms.contracts !== false && await hasColumnCached('contracts', 'project_id')
    ? group(await db('contracts').whereIn('project_id', ids).select('project_id', 'status')) : new Map();
  const events = group(await db('events').whereIn('project_id', ids).select('project_id', 'is_draft'));
  const invoices = perms.bills !== false
    ? group(await invoicesForProjects(ids, ['id', 'status', 'kind', 'deal_uuid'])) : new Map();
  for (const p of projects) {
    p.stage = deriveStages({
      status: p.status,
      flow: p.flow,
      skippedStages: p.skippedStages,
      quotes: quotes.get(p.id), contracts: contracts.get(p.id),
      events: events.get(p.id), invoices: invoices.get(p.id),
    }, perms);
  }
}

/**
 * Full overview aggregation for the cockpit. Returns the project, its events,
 * and the rolled-up emails / quotes / contracts / invoices / hours + a
 * timeline of milestones. `perms` gates which doc types are included.
 *
 * `admin` (optional) is used only to stamp each email with `canAct` — whether
 * the queued-mail routes would actually accept an action on it. See below.
 */
async function getProjectOverview(id, perms = {}, admin = null) {
  const project = await getProjectById(id);
  if (!project) throw new AppError('Project not found', 404);

  // `created_by` is selected for the ownership check below and stripped again
  // before the response — the cockpit has no business learning who owns a
  // sibling event.
  const eventRows = await db('events')
    .where({ project_id: id })
    .select('id', 'event_name', 'event_date', 'slug', 'is_active', 'is_draft', 'expires_at', 'is_archived', 'created_by');
  const events = eventRows.map(({ created_by: _ignored, ...e }) => e);
  const eventIds = events.map((e) => e.id);

  // Which of this project's events would filterOwnedEventIds() let `admin`
  // act on. Mirrors that predicate exactly (ownership.js): super_admin gets
  // everything, otherwise created_by IS NULL OR created_by = admin.id.
  //
  // Project ownership does NOT imply event ownership — ownedProjectsSubquery's
  // `projects.created_by = admin.id` branch places no constraint on who owns
  // the linked events, so a super_admin can attach admin B's event to admin
  // A's project. Deriving actionability from `event_id != null` alone (as the
  // UI first did) would then still render controls that requireOwnedQueuedEmail
  // rejects with a 404.
  // No admin context → nothing is actionable. Without this, an ownerless
  // (legacy/system) event would satisfy `created_by == null` and be marked
  // actionable for a caller we know nothing about.
  const isSuperAdmin = admin?.roleName === 'super_admin';
  let actionableEventIds = new Set();
  if (isSuperAdmin) {
    actionableEventIds = new Set(eventIds);
  } else if (admin?.id != null) {
    actionableEventIds = new Set(
      eventRows
        .filter((e) => e.created_by == null || Number(e.created_by) === Number(admin.id))
        .map((e) => e.id),
    );
  }

  // Whether new quotes, contracts and invoices may join this project: the
  // CRM write rule ties project_id to the project's creator (or a super
  // admin), so a legacy ownerless project can show them but not take new ones.
  project.documentsLinkable = admin?.id != null && (await carriedProjectId(id, admin.id)) != null;

  const out = { project, events, emails: [], quotes: [], contracts: [], invoices: [], hours: { entries: [], totalMinutes: 0 } };

  // Invoices (by event, own project_id or deal) incl. storno; one whose
  // gallery is in another project belongs to that one (invoicesForProjects).
  if (perms.bills !== false) {
    const rows = await invoicesForProjects([id], ['id', 'invoice_number', 'status', 'kind', 'issue_date', 'due_date',
      'total_amount_minor', 'paid_amount_minor', 'paid_at', 'currency', 'event_id', 'deal_uuid']);
    // `direct`: tied by its own project_id, so it can be taken out of the
    // project (DELETE /projects/:id/invoices/:invoiceId); one that rolls up
    // through its gallery or deal leaves with that.
    const direct = new Set();
    if (rows.length && await hasColumnCached('invoices', 'project_id')) {
      const ids = rows.map((r) => r.id);
      for (let i = 0; i < ids.length; i += CHUNK) {
        for (const r of await db('invoices').whereIn('id', ids.slice(i, i + CHUNK)).where({ project_id: id }).select('id')) direct.add(r.id);
      }
    }
    out.invoices = rows
      .map(({ project_id: _p, ...inv }) => ({ ...inv, direct: direct.has(inv.id) }))
      // Newest first, as before. Compared as times: PostgreSQL returns Dates.
      .sort((a, b) => (b.issue_date ? new Date(b.issue_date).getTime() : 0) - (a.issue_date ? new Date(a.issue_date).getTime() : 0));
  }

  // Quotes / contracts. These tables carry no event_id (migration 107), so
  // they're linked to the project explicitly via project_id (migration 121).
  // Where that column doesn't exist yet (pre-121 DB) we fall back to the
  // project's customer — the original, less precise scoping.
  const quotesHaveProjectId = await hasColumnCached('quotes', 'project_id');
  const contractsHaveProjectId = await hasColumnCached('contracts', 'project_id');

  if (perms.quotes !== false && (quotesHaveProjectId || project.customerAccountId)) {
    // source_template_id preselects the contract template when the project
    // page converts an accepted quote (ConvertToContractDialog).
    const quoteCols = ['id', 'quote_number', 'status', 'issue_date', 'valid_until', 'total_amount_minor', 'currency', 'deal_uuid'];
    if (await hasColumnCached('quotes', 'source_template_id')) quoteCols.push('source_template_id');
    let q = db('quotes')
      .select(quoteCols)
      .orderBy('issue_date', 'desc');
    if (quotesHaveProjectId) q = q.where({ project_id: id });
    else q = q.where({ customer_account_id: project.customerAccountId });
    out.quotes = await q;
  }
  if (perms.contracts !== false && (contractsHaveProjectId || project.customerAccountId)) {
    let q = db('contracts')
      .select('id', 'contract_number', 'status', 'issue_date', 'signed_by_customer_at', 'deal_uuid')
      .orderBy('issue_date', 'desc');
    if (contractsHaveProjectId) q = q.where({ project_id: id });
    else q = q.where({ customer_account_id: project.customerAccountId });
    out.contracts = await q;
  }

  // Emails — newest first. rendered_html presence flagged; body fetched lazily
  // by the preview endpoint. Two precisely-scoped sources, never the recipient
  // string alone (a shared family inbox must NOT leak another customer's mail):
  //   1. Gallery/event mails — carry event_id, and the events belong to this
  //      project, so whereIn(eventIds) is already exact.
  //   2. CRM document mails (quote_/contract_/invoice_/storno_) — queued with
  //      event_id=null + recipient=customer email. We use the recipient only as
  //      a cheap candidate filter, then KEEP a row only when its email_data
  //      document number matches one of THIS project's loaded documents. That
  //      both scopes to the right customer and excludes system/admin alerts
  //      (backup_failed, …) sent to the same inbox.
  const selectCols = ['id', 'recipient_email', 'email_type', 'status', 'created_at', 'sent_at', 'error_message', 'event_id',
    // Exact stored preview available? (CASE is cross-DB: SQLite→0/1, PG→int)
    db.raw('CASE WHEN rendered_html IS NOT NULL THEN 1 ELSE 0 END as has_rendered')];
  const mapEmail = (e) => ({
    id: e.id, recipient: e.recipient_email, type: e.email_type, status: e.status,
    queuedAt: e.created_at, sentAt: e.sent_at, error: e.error_message, eventId: e.event_id,
    // false → the cockpit preview will re-render from the current template.
    stored: !!Number(e.has_rendered),
    // Would requireOwnedQueuedEmail accept preview/resend/cancel/retry/send-now
    // on this row? Authoritative here because the client cannot derive it: CRM
    // document mail has no event to own, and event mail additionally requires
    // ownership of THAT event, which the response deliberately does not expose.
    canAct: isSuperAdmin || (e.event_id != null && actionableEventIds.has(e.event_id)),
  });

  const emailRows = [];
  if (eventIds.length) {
    const eventEmails = await db('email_queue')
      .whereIn('event_id', eventIds)
      .select(selectCols)
      .orderBy('created_at', 'desc')
      .limit(200);
    emailRows.push(...eventEmails);
  }
  const customerEmail = project.customerEmail || null;
  // The set of document numbers that belong to this project (across the doc
  // types the admin may see). CRM emails carry their number in email_data.
  const docNumbers = new Set();
  for (const q of out.quotes) if (q.quote_number != null) docNumbers.add(String(q.quote_number));
  for (const c of out.contracts) if (c.contract_number != null) docNumbers.add(String(c.contract_number));
  for (const inv of out.invoices) if (inv.invoice_number != null) docNumbers.add(String(inv.invoice_number));
  if (customerEmail && docNumbers.size) {
    const crmCandidates = await db('email_queue')
      .where('recipient_email', customerEmail)
      .whereNull('event_id')
      .andWhere(function () {
        // LIKE '_' is a single-char wildcard matching the literal underscore in
        // every CRM type; no escape needed and no real type collides with '%'.
        for (const prefix of ['quote_%', 'contract_%', 'invoice_%', 'storno_%']) {
          this.orWhere('email_type', 'like', prefix);
        }
      })
      .select([...selectCols, 'email_data'])
      .orderBy('created_at', 'desc')
      .limit(200);
    for (const r of crmCandidates) {
      let data = r.email_data;
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch (_) { data = {}; } }
      data = data || {};
      // Match on any document-number key a CRM template carries (storno mails
      // use storno_number / original_invoice_number, not invoice_number).
      const candidates = [data.quote_number, data.contract_number, data.invoice_number,
        data.storno_number, data.original_invoice_number];
      if (candidates.some((n) => n != null && docNumbers.has(String(n)))) emailRows.push(r);
    }
  }
  // Merge both sources, newest first, capped.
  emailRows.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  out.emails = emailRows.slice(0, 200).map(mapEmail);

  // Hours (by project_id) — individual entries + total.
  const hours = await db('customer_hour_entries')
    .where({ project_id: id })
    .select('id', 'entry_date', 'duration_minutes', 'description', 'status', 'invoice_id')
    .orderBy('entry_date', 'desc');
  out.hours = {
    entries: hours,
    totalMinutes: hours.reduce((s, h) => s + Number(h.duration_minutes || 0), 0),
  };

  // Timeline milestones (latest of each kind that exists), each dated.
  const milestones = [];
  const firstQuote = out.quotes.at(-1);
  if (firstQuote) milestones.push({ kind: 'quote', id: firstQuote.id, label: firstQuote.quote_number, date: firstQuote.issue_date });
  const firstContract = out.contracts.at(-1);
  if (firstContract) milestones.push({ kind: 'contract', id: firstContract.id, label: firstContract.contract_number, date: firstContract.issue_date });
  const pubEvent = events.find((e) => e.is_active && !e.is_draft);
  if (pubEvent) milestones.push({ kind: 'gallery', id: pubEvent.id, label: pubEvent.event_name, date: pubEvent.event_date });
  const firstInvoice = out.invoices.at(-1);
  if (firstInvoice) milestones.push({ kind: 'invoice', id: firstInvoice.id, label: firstInvoice.invoice_number, date: firstInvoice.issue_date });
  out.milestones = milestones;

  // Rolled-up project value (newest stage wins per deal, cumulative).
  out.valuation = computeValuation(out.invoices, out.quotes);

  out.stage = deriveStages({ status: project.status, flow: project.flow, skippedStages: project.skippedStages, ...out }, perms);

  // `date` columns leave as bare days, as on every other document payload
  // (issue 2333): the pg Date would reach the browser as UTC midnight, a day
  // early west of UTC, and sort apart from the same row on SQLite.
  for (const row of [...out.quotes, ...out.contracts, ...out.invoices]) {
    for (const col of ['issue_date', 'valid_until', 'due_date']) if (col in row) row[col] = toDateOnly(row[col]);
  }
  for (const milestone of milestones) milestone.date = toDateOnly(milestone.date);

  return out;
}

/**
 * HTML preview for an email_queue row (cockpit). Prefers the exact bytes
 * stored at send time (rendered_html). Rows sent before that column existed
 * have none — we then RE-RENDER from the current template + the row's stored
 * variables (email_data) so the admin still sees the email, flagged `exact:
 * false`. Only when even re-rendering fails (template gone / no variables)
 * does `available:false` fall through to the "nothing stored" note.
 */
async function getEmailPreview(emailId) {
  const row = await db('email_queue')
    .where({ id: emailId })
    .select('id', 'recipient_email', 'email_type', 'status', 'rendered_html', 'email_data')
    .first();
  if (!row) throw new AppError('Email not found', 404);

  if (row.rendered_html) {
    // Document links in the body carry the customer's contract or quote token.
    return { id: row.id, recipient: row.recipient_email, type: row.email_type, status: row.status, available: true, exact: true, html: redactBearerLinks(row.rendered_html) };
  }

  // Fallback: re-render from the current template + stored variables.
  let html = null;
  try {
    let variables = row.email_data;
    if (typeof variables === 'string') variables = JSON.parse(variables);
    // A waiting row keeps its passwords sealed; the preview shows the mask.
    variables = maskSecretFields(variables, MASK);
    const { renderQueuedEmail } = require('./emailProcessor');
    const rendered = await renderQueuedEmail(row.email_type, variables || {}, row.recipient_email);
    html = rendered && rendered.html ? rendered.html : null;
  } catch (_) { html = null; }

  return {
    id: row.id,
    recipient: row.recipient_email,
    type: row.email_type,
    status: row.status,
    available: !!html,
    exact: false,
    html: redactBearerLinks(html),
  };
}

// ── Email actions (from the cockpit feed) ───────────────────────────────

/** Audit every admin email action uniformly (mark-paid / cancel / reissue in
 *  the CRM services all log; these were the gap). Best-effort — never blocks. */
async function logEmailAction(activityType, emailId, row, adminId) {
  try {
    await logActivity(
      activityType,
      { queueId: emailId, emailType: row && row.email_type, recipient: row && row.recipient_email },
      (row && row.event_id) || null,
      adminId ? { type: 'admin', id: adminId } : null,
    );
  } catch (_) { /* audit is best-effort */ }
}

async function resendEmail(emailId, adminId = null) {
  const row = await db('email_queue').where({ id: emailId }).first();
  if (!row) throw new AppError('Email not found', 404);
  await assertResendable(row, { newMail: true });
  // Normalise email_data to match the canonical enqueue (emailProcessor.js
  // stores JSON.stringify(...) in the json column). PG returns jsonb as a
  // parsed object, SQLite as a string — re-stringify the object form so the
  // resent row is never double-encoded.
  let emailData = row.email_data;
  if (emailData != null && typeof emailData !== 'string') emailData = JSON.stringify(emailData);
  const insert = await db('email_queue').insert({
    recipient_email: row.recipient_email,
    email_type: row.email_type,
    email_data: emailData,
    event_id: row.event_id,
    status: pendingStatusFor(row),
    retry_count: 0,
    created_at: new Date(),
    // The queue time of the mail this copy repeats (migration 307): erasure
    // attributes mail to an address holder by it, and the address may have
    // changed hands since. A copy of a copy keeps the first mail's time.
    original_created_at: row.original_created_at ?? row.created_at,
    // Explicit NULL: the column default is text on SQLite and never comes
    // due (issue 1670) — see queueEmail.
    scheduled_at: null,
  }).returning('id');
  const id = (insert[0] && typeof insert[0] === 'object') ? insert[0].id : insert[0];
  await logEmailAction('project_email_resent', id, row, adminId);
  return { id, status: 'pending' };
}

async function cancelEmail(emailId, adminId = null) {
  const row = await db('email_queue').where({ id: emailId }).first();
  if (!row) throw new AppError('Email not found', 404);
  if (!PENDING_EMAIL_STATUSES.has(row.status)) throw new AppError('Only pending emails can be cancelled', 409);
  await db('email_queue').where({ id: emailId }).update({ status: 'cancelled' });
  await logEmailAction('project_email_cancelled', emailId, row, adminId);
  return { id: emailId, status: 'cancelled' };
}

async function retryEmail(emailId, adminId = null) {
  const row = await db('email_queue').where({ id: emailId }).first();
  if (!row) throw new AppError('Email not found', 404);
  await assertResendable(row);
  await db('email_queue').where({ id: emailId })
    .update({ status: pendingStatusFor(row), retry_count: 0, error_message: null, scheduled_at: null });
  await logEmailAction('project_email_retried', emailId, row, adminId);
  return { id: emailId, status: 'pending' };
}

async function sendEmailNow(emailId, adminId = null) {
  const row = await db('email_queue').where({ id: emailId }).first();
  if (!row) throw new AppError('Email not found', 404);
  await assertResendable(row);
  await db('email_queue').where({ id: emailId }).update({ status: pendingStatusFor(row), scheduled_at: null });
  // Flush ONLY this email — passing onlyId scopes processEmailQueue to a single
  // row so a forced "send now" never force-retries OTHER dead-lettered emails
  // (those that already exceeded the retry cap) just because we bypass it here.
  const { processEmailQueue } = require('./emailProcessor');
  const result = await processEmailQueue({ ignoreSchedule: true, onlyId: emailId });
  await logEmailAction('project_email_sent_now', emailId, row, adminId);
  return result;
}

module.exports = {
  PROJECT_STATUSES,
  PROJECT_FLOWS,
  SKIPPABLE_STAGES,
  listProjects,
  getProjectById,
  createProject,
  updateProject,
  deleteProject,
  deriveStages,
  promoteInquiry,
  carriedProjectId,
  holdProjectToCustomer,
  releaseAdoptedCustomer,
  assignEvent,
  assignQuote,
  assignContract,
  assignInvoice,
  unassignInvoice,
  invoiceAttachRefusal,
  documentAttachMoves,
  attachMovesFor,
  dealProjectElsewhere,
  linkDealToProject,
  computeValuation,
  getProjectOverview,
  getEmailPreview,
  resendEmail,
  cancelEmail,
  retryEmail,
  sendEmailNow,
};
