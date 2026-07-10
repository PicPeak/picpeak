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

function transformProject(p) {
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    customerAccountId: p.customer_account_id || null,
    customerEmail: p.customer_email || null,
    status: p.status,
    eventCount: p.event_count != null ? Number(p.event_count) : undefined,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

/** List projects with customer email + event count + rolled-up value.
 *  `perms` gates which document types feed the value (matches the cockpit):
 *  invoices need bills.view, quotes need quotes.view. */
async function listProjects({ search = '', status = null, perms = {} } = {}) {
  let q = db('projects')
    .leftJoin('customer_accounts', 'customer_accounts.id', 'projects.customer_account_id')
    .select(
      'projects.*',
      'customer_accounts.email as customer_email',
      db('events').count('* as c').whereRaw('events.project_id = projects.id').as('event_count'),
    )
    .orderBy('projects.updated_at', 'desc');
  if (status) q = q.where('projects.status', status);
  if (search) {
    q = q.where(function () {
      this.where('projects.name', 'like', `%${search}%`)
        .orWhere('customer_accounts.email', 'like', `%${search}%`);
    });
  }
  const rows = await q;
  const projects = rows.map(transformProject);
  await attachValuations(projects, perms);
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

  // Invoices roll up by event → project_id; quotes by quotes.project_id.
  let invoices = [];
  if (perms.bills !== false) {
    invoices = await db('invoices as inv')
      .join('events as e', 'e.id', 'inv.event_id')
      .whereIn('e.project_id', projectIds)
      .select('e.project_id as project_id', 'inv.id', 'inv.deal_uuid',
        'inv.total_amount_minor', 'inv.paid_amount_minor', 'inv.currency');
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
    .select('projects.*', 'customer_accounts.email as customer_email')
    .where('projects.id', id)
    .first();
  return transformProject(row);
}

async function createProject({ name, customerAccountId = null }, adminId) {
  if (!name || !String(name).trim()) throw new AppError('Project name is required', 400);
  const inserted = await db('projects').insert({
    name: String(name).trim(),
    customer_account_id: customerAccountId || null,
    status: 'active',
    created_at: new Date(),
    updated_at: new Date(),
  }).returning('id');
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
  for (const tbl of ['quotes', 'contracts']) {
    if (await hasColumnCached(tbl, 'project_id') && await hasColumnCached(tbl, 'customer_account_id')) {
      for (const r of await conn(tbl).where({ project_id: id }).whereNotNull('customer_account_id').distinct('customer_account_id as cid')) {
        if (r.cid != null) ids.add(Number(r.cid));
      }
    }
  }
  return ids;
}

async function updateProject(id, { name, customerAccountId, status }) {
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
  if (status !== undefined) patch.status = status;
  await db('projects').where({ id }).update(patch);
  return getProjectById(id);
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
  return { projectId, eventId };
}

/**
 * Cascade a project link across a whole deal's lineage. Given a deal_uuid, link
 * every quote + contract in that deal to the project, re-point every event the
 * deal produced (so its invoices / emails / gallery roll up automatically), and
 * adopt the deal's customer onto the project when it has none. This is what
 * makes "drop a quote on an empty project" fill the cockpit with the linked
 * contract, event and invoices. Idempotent; pass a trx to run inside a txn.
 */
async function linkDealToProject(dealUuid, projectId, conn = db) {
  if (!dealUuid || !projectId) return;

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

  // Cleared to write: link the deal's quotes/contracts, re-point its events so
  // invoices/emails/gallery roll up automatically.
  if (quotesHaveDeal && await hasColumnCached('quotes', 'project_id')) {
    await conn('quotes').where({ deal_uuid: dealUuid }).update({ project_id: projectId });
  }
  if (contractsHaveDeal && await hasColumnCached('contracts', 'project_id')) {
    await conn('contracts').where({ deal_uuid: dealUuid }).update({ project_id: projectId });
  }
  if (eventIds.size && await hasColumnCached('events', 'project_id')) {
    await conn('events').whereIn('id', Array.from(eventIds)).update({ project_id: projectId });
  }

  // Adopt the deal's customer onto a still-unassigned project (first deal wins).
  if (dealCustomerIds.size && project.customer_account_id == null) {
    const adopt = [...dealCustomerIds][0];
    await conn('projects').where({ id: projectId }).update({ customer_account_id: adopt, updated_at: new Date() });
  }
}

/** Attach (or, with projectId=null, detach) a quote/contract to a project.
 *  Attaching cascades the link across the deal lineage (see linkDealToProject). */
async function assignDocument(table, projectId, documentId) {
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
  await db(table).where({ id: documentId }).update({ project_id: projectId || null });
  if (projectId && doc.deal_uuid) {
    await linkDealToProject(doc.deal_uuid, projectId);
  }
  return { projectId: projectId || null, documentId };
}

const assignQuote = (projectId, quoteId) => assignDocument('quotes', projectId, quoteId);
const assignContract = (projectId, contractId) => assignDocument('contracts', projectId, contractId);

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

/**
 * Full overview aggregation for the cockpit. Returns the project, its events,
 * and the rolled-up emails / quotes / contracts / invoices / hours + a
 * timeline of milestones. `perms` gates which doc types are included.
 */
async function getProjectOverview(id, perms = {}) {
  const project = await getProjectById(id);
  if (!project) throw new AppError('Project not found', 404);

  const events = await db('events')
    .where({ project_id: id })
    .select('id', 'event_name', 'event_date', 'slug', 'is_active', 'is_draft', 'expires_at', 'is_archived');
  const eventIds = events.map((e) => e.id);

  const out = { project, events, emails: [], quotes: [], contracts: [], invoices: [], hours: { entries: [], totalMinutes: 0 } };

  // Invoices (by event) incl. storno.
  if (eventIds.length && perms.bills !== false) {
    out.invoices = await db('invoices')
      .whereIn('event_id', eventIds)
      .select('id', 'invoice_number', 'status', 'kind', 'issue_date', 'due_date',
        'total_amount_minor', 'paid_amount_minor', 'paid_at', 'currency', 'event_id', 'deal_uuid')
      .orderBy('issue_date', 'desc');
  }

  // Quotes / contracts. These tables carry no event_id (migration 107), so
  // they're linked to the project explicitly via project_id (migration 121).
  // Where that column doesn't exist yet (pre-121 DB) we fall back to the
  // project's customer — the original, less precise scoping.
  const quotesHaveProjectId = await hasColumnCached('quotes', 'project_id');
  const contractsHaveProjectId = await hasColumnCached('contracts', 'project_id');

  if (perms.quotes !== false && (quotesHaveProjectId || project.customerAccountId)) {
    let q = db('quotes')
      .select('id', 'quote_number', 'status', 'issue_date', 'valid_until', 'total_amount_minor', 'currency', 'deal_uuid')
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
    return { id: row.id, recipient: row.recipient_email, type: row.email_type, status: row.status, available: true, exact: true, html: row.rendered_html };
  }

  // Fallback: re-render from the current template + stored variables.
  let html = null;
  try {
    let variables = row.email_data;
    if (typeof variables === 'string') variables = JSON.parse(variables);
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
    html,
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
    status: 'pending',
    retry_count: 0,
    created_at: new Date(),
  }).returning('id');
  const id = (insert[0] && typeof insert[0] === 'object') ? insert[0].id : insert[0];
  await logEmailAction('project_email_resent', id, row, adminId);
  return { id, status: 'pending' };
}

async function cancelEmail(emailId, adminId = null) {
  const row = await db('email_queue').where({ id: emailId }).first();
  if (!row) throw new AppError('Email not found', 404);
  if (row.status !== 'pending') throw new AppError('Only pending emails can be cancelled', 409);
  await db('email_queue').where({ id: emailId }).update({ status: 'cancelled' });
  await logEmailAction('project_email_cancelled', emailId, row, adminId);
  return { id: emailId, status: 'cancelled' };
}

async function retryEmail(emailId, adminId = null) {
  const row = await db('email_queue').where({ id: emailId }).first();
  if (!row) throw new AppError('Email not found', 404);
  await db('email_queue').where({ id: emailId })
    .update({ status: 'pending', retry_count: 0, error_message: null, scheduled_at: null });
  await logEmailAction('project_email_retried', emailId, row, adminId);
  return { id: emailId, status: 'pending' };
}

async function sendEmailNow(emailId, adminId = null) {
  const row = await db('email_queue').where({ id: emailId }).first();
  if (!row) throw new AppError('Email not found', 404);
  await db('email_queue').where({ id: emailId }).update({ status: 'pending', scheduled_at: null });
  // Flush ONLY this email — passing onlyId scopes processEmailQueue to a single
  // row so a forced "send now" never force-retries OTHER dead-lettered emails
  // (those that already exceeded the retry cap) just because we bypass it here.
  const { processEmailQueue } = require('./emailProcessor');
  const result = await processEmailQueue({ ignoreSchedule: true, onlyId: emailId });
  await logEmailAction('project_email_sent_now', emailId, row, adminId);
  return result;
}

module.exports = {
  listProjects,
  getProjectById,
  createProject,
  updateProject,
  assignEvent,
  assignQuote,
  assignContract,
  linkDealToProject,
  computeValuation,
  getProjectOverview,
  getEmailPreview,
  resendEmail,
  cancelEmail,
  retryEmail,
  sendEmailNow,
};
