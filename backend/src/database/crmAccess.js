'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { ForbiddenError, NotFoundError } = require('../utils/errors');

const execution = new AsyncLocalStorage();
let testFixtureAuthority = false;
const INSTALLED = Symbol.for('picpeak.crmAccess.installed');
const INTERNAL = Symbol('crm policy query');
const clientHandles = new WeakMap();
function connectionHandle(client) {
  if (!clientHandles.has(client)) clientHandles.set(client, require('knex/lib/knex-builder/make-knex')(client));
  return clientHandles.get(client);
}
const ROOTS = { quotes: 'quotes', invoices: 'bills', contracts: 'contracts' };
const CHILDREN = {
  quote_line_items: ['quotes', 'quote_id'], quote_action_tokens: ['quotes', 'quote_id'],
  invoice_line_items: ['invoices', 'invoice_id'], invoice_payment_log: ['invoices', 'invoice_id'],
  invoice_payment_check_tokens: ['invoices', 'invoice_id'],
  contract_block_inclusions: ['contracts', 'contract_id'],
  contract_text_sections: ['contracts', 'contract_id'], contract_attachment_inclusions: ['contracts', 'contract_id'],
  contract_action_tokens: ['contracts', 'contract_id'], contract_signers: ['contracts', 'contract_id'],
  contract_signing_events: ['contracts', 'contract_id'], contract_signing_signals: ['contracts', 'contract_id'],
};
const SIGNER_CHILDREN = new Set(['contract_signer_invitations', 'contract_signing_otps',
  'contract_signing_sessions', 'contract_signer_consents']);
const POLYMORPHIC = {
  generated_documents: ['doc_type', 'doc_id'], accounting_change_history: ['document_type', 'document_id'],
};
const TYPES = { quote: 'quotes', invoice: 'invoices', contract: 'contracts', contract_certificate: 'contracts' };
const PROTECTED = new Set([...Object.keys(ROOTS), ...Object.keys(CHILDREN), ...SIGNER_CHILDREN,
  ...Object.keys(POLYMORPHIC), 'customer_documents']);
// Database FK actions do not construct a Knex query. Fence the CRM records
// they can rewrite, including deletes initiated through event/project/user
// services, before allowing the parent statement to run.
const FK_REFERENCES = require('../services/accountingHistoryReferences');
const CRM_REFERENCES = Object.fromEntries(Object.entries(FK_REFERENCES)
  .map(([parent, references]) => [parent, references.filter(ref => PROTECTED.has(ref.table)).map(ref => [ref.table, ref.column, ref.action])])
  .filter(([, references]) => references.length));
for (const [parent, references] of Object.entries({
  events: [['quotes', 'converted_event_id'], ['contracts', 'converted_event_id'], ['invoices', 'event_id']],
  projects: [['quotes', 'project_id'], ['contracts', 'project_id']],
  admin_users: Object.keys(ROOTS).map(t => [t, 'created_by_admin_id']),
  quotes: [['contracts', 'source_quote_id'], ['invoices', 'source_quote_id'], ['quotes', 'replaces_quote_id']],
  contracts: [['quotes', 'converted_contract_id'], ['invoices', 'source_contract_id'], ['customer_documents', 'contract_id']],
  invoices: [['invoices', 'cancels_invoice_id'], ['invoices', 'replaces_invoice_id'], ['invoices', 'cancellation_storno_id']],
  quote_line_items: [['quote_line_items', 'parent_line_item_id']],
  invoice_line_items: [['invoice_line_items', 'parent_line_item_id']],
})) CRM_REFERENCES[parent] = [...(CRM_REFERENCES[parent] || []), ...references]
  .filter((ref, index, all) => all.findIndex(other => other[0] === ref[0] && other[1] === ref[1]) === index);
// Include transitive cascades such as profile -> bank account -> CRM and
// template -> version -> contract, not only immediate document references.
let expanded;
do {
  expanded = false;
  for (const [parent, references] of Object.entries(FK_REFERENCES)) for (const ref of references) {
    if (ref.action !== 'delete' || !CRM_REFERENCES[ref.table]
      || CRM_REFERENCES[parent]?.some(r => r[0] === ref.table && r[1] === ref.column)) continue;
    (CRM_REFERENCES[parent] ||= []).push([ref.table, ref.column, ref.action]);
    expanded = true;
  }
} while (expanded);

function currentCrmActor() { return execution.getStore()?.actor || null; }

/** Authenticated callers must use a live principal, never a body/token role. */
async function loadCrmActor(admin) {
  const { db } = require('./db');
  const { formatBoolean } = require('../utils/dbCompat');
  // Session/API authentication has just loaded and validated this live DB
  // profile. Resumed jobs pass only an ID and must rehydrate it themselves.
  const row = admin.roleName ? { id: admin.id, roleName: admin.roleName }
    : await db('admin_users').leftJoin('roles', 'roles.id', 'admin_users.role_id')
      .where('admin_users.id', admin.id).where('admin_users.is_active', formatBoolean(true))
      .first('admin_users.id', 'roles.name as roleName');
  if (!row) throw new ForbiddenError('Account unavailable');
  // An active pre-assignment account may still change its own password/MFA.
  // It gets no CRM permissions; absence of a role is never super-admin.
  const roleName = row.roleName || admin.roleName || 'unassigned';
  const { roleHasPermission } = require('../middleware/permissions');
  const permissions = new Set();
  for (const domain of Object.values(ROOTS)) {
    for (const action of ['view', 'manage']) {
      const name = `${domain}.${action}`;
      if (await roleHasPermission(roleName, name)) permissions.add(name);
    }
  }
  return Object.freeze({ id: Number(row.id), roleName, permissions });
}

function withCrmActor(actor, work) {
  if (!actor || !Number.isSafeInteger(Number(actor.id)) || Number(actor.id) <= 0) {
    throw new ForbiddenError('CRM actor required');
  }
  // Resolve Knex's lazy thenables *inside* the context. Returning a builder
  // directly would let its caller's await execute it under a different actor.
  return execution.run({ actor }, async () => await work());
}

// Only owned application entry points call this: migrations/bootstrap, shipped
// scheduled jobs, and routers whose action-token/customer checks remain required.
// Unlike an absent context, this explicitly records why no admin policy applies.
function withTrustedCrmAccess(reason, work) {
  if (!reason) throw new Error('Trusted CRM access requires a reason');
  return execution.run({ trusted: reason }, async () => await work());
}
function crmCapabilityRouter(reason) {
  return (_req, _res, next) => withTrustedCrmAccess(reason, next);
}

// Existing service tests invoke trusted internal methods directly. Their
// fixture authority is explicit, and unavailable in application environments.
function enterTrustedCrmFixtureContext() {
  if (process.env.NODE_ENV !== 'test') throw new Error('CRM fixture context is test-only');
  // Jest may execute hooks/tests in separate async resources after a module
  // reset. Opt-in fixture authority survives that scheduling, but never
  // overrides a real actor or an explicitly denied/missing-context control.
  testFixtureAuthority = true;
  execution.enterWith({ trusted: 'isolated test fixture' });
}
function withoutCrmContext(work) { return execution.run({ denied: true }, async () => await work()); }

function allowed(actor, root, write) {
  const domain = ROOTS[root];
  return actor.roleName === 'super_admin' || (write
    ? actor.permissions.has(`${domain}.manage`)
    : actor.permissions.has(`${domain}.view`) || actor.permissions.has(`${domain}.manage`));
}

function tableName(value) {
  if (typeof value === 'string') {
    const match = /^([A-Za-z_][\w]*)(?:\s+(?:as\s+)?([A-Za-z_][\w]*))?$/i.exec(value.trim());
    return match ? { table: match[1].toLowerCase(), alias: match[2] || match[1] } : null;
  }
  if (value && !value.isRawInstance && typeof value === 'object' && !value.toSQL) {
    const pairs = Object.entries(value);
    if (pairs.length === 1 && /^[A-Za-z_][\w]*$/.test(pairs[0][0])) {
      const parsed = tableName(pairs[0][1]);
      if (parsed) return { table: parsed.table, alias: pairs[0][0] };
    }
  }
  return null;
}
function referencesCrm(sql) {
  return [...PROTECTED].some(t => new RegExp(`\\b${t}\\b`, 'i').test(String(sql)));
}
function rawCrmMutation(sql) {
  return /\b(delete|truncate|drop|alter)\b/i.test(sql)
    && Object.keys(CRM_REFERENCES).some(t => new RegExp(`\\b${t}\\b`, 'i').test(sql));
}
function rawSql(value) { return value?.isRawInstance ? value.toSQL().sql : String(value); }
function containsCrmTable(value, mutation = false) {
  if (value?.toSQL && !value.isRawInstance) return false; // nested builder compiles independently
  if (value && typeof value === 'object' && !value.isRawInstance) return Object.values(value).some(v => containsCrmTable(v, mutation));
  return referencesCrm(rawSql(value)) || (mutation && rawCrmMutation(`delete from ${rawSql(value)}`));
}
function unsafeCrmRaw(value) {
  if (value?.isRawInstance) return referencesCrm(rawSql(value)) && /\b(select|from|join|update|delete|insert|with)\b/i.test(rawSql(value));
  if (Array.isArray(value)) return value.some(unsafeCrmRaw);
  if (value && typeof value === 'object' && !value.toSQL) return Object.values(value).some(unsafeCrmRaw);
  return false;
}
function identifier(name) {
  if (!/^[A-Za-z_][\w]*$/.test(name)) throw new ForbiddenError('Unsupported CRM table alias');
  return `"${name}"`;
}

/** Finite, correlated SQL, never an in-memory/global list of approved IDs. */
function predicate(table, alias, actor, write = false) {
  const bindings = {};
  const param = v => {
    const key = `crmPolicy${Object.keys(bindings).length}`;
    bindings[key] = v;
    return `:${key}`;
  };
  const col = (a, c) => `${identifier(a)}.${identifier(c)}`;
  let serial = 0;
  const fresh = prefix => `__crm_${prefix}_${serial++}`;
  const event = id => {
    const a = fresh('event');
    return `exists (select 1 from events as ${identifier(a)} where ${col(a, 'id')} = ${id} and ${col(a, 'created_by')} = ${param(actor.id)})`;
  };
  const project = id => {
    const a = fresh('project'), e = fresh('project_event'), bad = fresh('bad_event');
    return `exists (select 1 from projects as ${identifier(a)} where ${col(a, 'id')} = ${id} and (${col(a, 'created_by')} = ${param(actor.id)} or (${col(a, 'created_by')} is null and exists (select 1 from events as ${identifier(e)} where ${col(e, 'project_id')} = ${col(a, 'id')} and ${col(e, 'created_by')} = ${param(actor.id)}) and not exists (select 1 from events as ${identifier(bad)} where ${col(bad, 'project_id')} = ${col(a, 'id')} and (${col(bad, 'created_by')} is null or ${col(bad, 'created_by')} <> ${param(actor.id)})))))`;
  };
  const noForeignDeal = a => {
    const foreign = Object.keys(ROOTS).map(root => {
      const b = fresh('foreign_deal');
      return `not exists (select 1 from ${identifier(root)} as ${identifier(b)} where ${col(b, 'deal_uuid')} = ${col(a, 'deal_uuid')} and ${col(b, 'created_by_admin_id')} is not null and ${col(b, 'created_by_admin_id')} <> ${param(actor.id)})`;
    });
    return `(${col(a, 'deal_uuid')} is null or (${foreign.join(' and ')}))`;
  };
  const baseOwner = (root, a) => {
    const anchors = [];
    const constraints = [noForeignDeal(a)];
    if (root !== 'invoices') {
      const owned = project(col(a, 'project_id'));
      anchors.push(owned);
      constraints.push(`(${col(a, 'project_id')} is null or ${project(col(a, 'project_id'))})`);
    }
    const eventColumn = root === 'invoices' ? 'event_id' : 'converted_event_id';
    anchors.push(event(col(a, eventColumn)));
    constraints.push(`(${col(a, eventColumn)} is null or ${event(col(a, eventColumn))})`);
    return `(${col(a, 'created_by_admin_id')} = ${param(actor.id)} or (${col(a, 'created_by_admin_id')} is null and (${anchors.join(' or ')}) and ${constraints.join(' and ')}))`;
  };
  const source = (root, id) => {
    const a = fresh('source');
    let ownership = baseOwner(root, a);
    if (root === 'contracts') {
      const quote = source('quotes', col(a, 'source_quote_id'));
      // The supported conversion chain is finite: quote -> contract ->
      // invoice. Do not lose a legacy contract's originating quote grant,
      // or let it override a conflicting project/event/source anchor.
      ownership = `(${col(a, 'created_by_admin_id')} = ${param(actor.id)} or (${col(a, 'created_by_admin_id')} is null and (${ownership} or ${quote}) and ${noForeignDeal(a)} and (${col(a, 'source_quote_id')} is null or ${quote}) and (${col(a, 'project_id')} is null or ${project(col(a, 'project_id'))}) and (${col(a, 'converted_event_id')} is null or ${event(col(a, 'converted_event_id'))})))`;
    }
    return `exists (select 1 from ${identifier(root)} as ${identifier(a)} where ${col(a, 'id')} = ${id} and ${ownership})`;
  };
  const owner = (root, a) => {
    if (actor.capability) {
      const cap = actor.capability;
      const anchors = [];
      if (root === cap.root) anchors.push(`${col(a, 'id')} = ${param(cap.id)}`);
      if (cap.root === 'quotes' && root !== 'quotes') anchors.push(`${col(a, 'source_quote_id')} = ${param(cap.id)}`);
      if (cap.root === 'contracts' && root === 'invoices') anchors.push(`${col(a, 'source_contract_id')} = ${param(cap.id)}`);
      if (cap.dealUuid) anchors.push(`${col(a, 'deal_uuid')} = ${param(cap.dealUuid)}`);
      if (cap.eventId) anchors.push(`${col(a, root === 'invoices' ? 'event_id' : 'converted_event_id')} = ${param(cap.eventId)}`);
      // An editable built-in graph is not global system authority. Its
      // capability cannot traverse a foreign photographer's stored creator.
      const legacy = actor.roleName === 'crm_system_capability' ? '1 = 1' : noForeignDeal(a);
      return `(${anchors.length ? anchors.join(' or ') : '1 = 0'}) and ((${col(a, 'created_by_admin_id')} is null and ${legacy}) or ${col(a, 'created_by_admin_id')} = ${param(actor.id)})`;
    }
    const fallback = [baseOwner(root, a)];
    const constraints = [noForeignDeal(a)];
    if (root !== 'quotes') {
      fallback.push(source('quotes', col(a, 'source_quote_id')));
      constraints.push(`(${col(a, 'source_quote_id')} is null or ${source('quotes', col(a, 'source_quote_id'))})`);
    }
    if (root === 'invoices') {
      fallback.push(source('contracts', col(a, 'source_contract_id')));
      constraints.push(`(${col(a, 'source_contract_id')} is null or ${source('contracts', col(a, 'source_contract_id'))})`);
    }
    if (root !== 'invoices') constraints.push(`(${col(a, 'project_id')} is null or ${project(col(a, 'project_id'))})`);
    const ec = root === 'invoices' ? 'event_id' : 'converted_event_id';
    constraints.push(`(${col(a, ec)} is null or ${event(col(a, ec))})`);
    // A lineage UUID is not a grant by itself. It needs a stored actor-owned
    // anchor, and any foreign creator makes the creatorless deal ambiguous.
    const dealAnchors = [];
    for (const r of Object.keys(ROOTS)) {
      const d = fresh('deal');
      dealAnchors.push(`exists (select 1 from ${identifier(r)} as ${identifier(d)} where ${col(d, 'deal_uuid')} = ${col(a, 'deal_uuid')} and ${col(d, 'created_by_admin_id')} = ${param(actor.id)})`);
    }
    fallback.push(`(${col(a, 'deal_uuid')} is not null and (${dealAnchors.join(' or ')}))`);
    return `(${col(a, 'created_by_admin_id')} = ${param(actor.id)} or (${col(a, 'created_by_admin_id')} is null and (${fallback.join(' or ')}) and ${constraints.join(' and ')}))`;
  };
  const rootGuard = (root, id) => {
    if (!allowed(actor, root, write)) return '1 = 0';
    const a = fresh('parent');
    return `exists (select 1 from ${identifier(root)} as ${identifier(a)} where ${col(a, 'id')} = ${id} and ${owner(root, a)})`;
  };
  let sql;
  if (ROOTS[table]) sql = allowed(actor, table, write) ? owner(table, alias) : '1 = 0';
  else if (CHILDREN[table]) {
    const [root, fk] = CHILDREN[table];
    sql = rootGuard(root, col(alias, fk));
  } else if (SIGNER_CHILDREN.has(table)) {
    const a = fresh('signer');
    sql = `exists (select 1 from contract_signers as ${identifier(a)} where ${col(a, 'id')} = ${col(alias, 'signer_id')} and ${rootGuard('contracts', col(a, 'contract_id'))})`;
  } else if (POLYMORPHIC[table]) {
    const [type, id] = POLYMORPHIC[table];
    const alternatives = Object.entries(TYPES).map(([kind, root]) => `(${col(alias, type)} = ${param(kind)} and ${rootGuard(root, col(alias, id))})`);
    sql = `(${col(alias, type)} not in (${Object.keys(TYPES).map(param).join(', ')}) or ${alternatives.join(' or ')})`;
  } else if (table === 'customer_documents') {
    sql = `(${col(alias, 'contract_id')} is null or ${rootGuard('contracts', col(alias, 'contract_id'))})`;
  } else sql = '1 = 1';
  return { sql, bindings };
}

function contextForProtected() {
  const context = execution.getStore();
  if (context?.denied) throw new ForbiddenError('CRM execution context required');
  if (!context && process.env.NODE_ENV === 'test' && testFixtureAuthority) return { trusted: 'explicit isolated test fixture' };
  if (!context) throw new ForbiddenError('CRM execution context required');
  return context;
}

function protectBuilder(builder, client) {
  if (builder[INTERNAL]) return builder;
  const root = tableName(builder._single?.table);
  if (root && CRM_REFERENCES[root.table] && builder._method === 'truncate') {
    const context = contextForProtected();
    if (!context.trusted && context.actor?.roleName !== 'super_admin') throw new ForbiddenError('Unsupported CRM query operation');
  }
  const joins = builder._statements.filter(s => s.grouping === 'join');
  const mutation = !['select', 'first', 'pluck', 'columnInfo'].includes(builder._method || 'select');
  const unsupportedTable = (!root && containsCrmTable(builder._single?.table, mutation))
    || joins.some(j => !tableName(j.table) && containsCrmTable(j.table, mutation));
  const unsafeFragment = builder._statements.some(s => unsafeCrmRaw(s.value) || unsafeCrmRaw(s.columns));
  if (unsupportedTable || unsafeFragment) {
    const context = contextForProtected();
    if (!context.trusted && context.actor?.roleName !== 'super_admin') throw new ForbiddenError('Unsupported raw CRM query');
  }
  const involved = (root && PROTECTED.has(root.table)) || joins.some(j => PROTECTED.has(tableName(j.table)?.table));
  if ((involved || (mutation && root && CRM_REFERENCES[root.table])) && builder._single?.schema) {
    const context = contextForProtected();
    if (!context.trusted && context.actor?.roleName !== 'super_admin') throw new ForbiddenError('CRM schema redirects are not supported');
  }
  if (!involved) {
    const rawTables = [builder._single?.table, ...joins.map(j => j.table)].filter(v => v?.isRawInstance);
    if (rawTables.some(v => referencesCrm(v.sql))) {
      const context = contextForProtected();
      if (!context.trusted && context.actor?.roleName !== 'super_admin') throw new ForbiddenError('Raw CRM tables are not supported');
    }
    return builder;
  }
  const context = contextForProtected();
  if (context.trusted || context.actor?.roleName === 'super_admin') return builder;
  const actor = context.actor;
  if (!actor) throw new ForbiddenError('CRM actor required');
  const copy = builder.clone();
  copy[INTERNAL] = true;
  const write = !['select', 'first', 'pluck'].includes(builder._method || 'select');
  if (root && PROTECTED.has(root.table)) {
    if (!['select', 'first', 'pluck', 'insert', 'update', 'del', 'delete', 'columnInfo'].includes(builder._method || 'select')) {
      throw new ForbiddenError('Unsupported CRM query operation');
    }
    if (builder._method === 'insert') {
      // Asynchronous row/relationship checks run on the same connection before
      // execution. Reject unsupported insert-select/conflict rewrites outright.
      if (!Array.isArray(builder._single.insert) && (!builder._single.insert || builder._single.insert.toSQL)) {
        throw new ForbiddenError('CRM inserts require explicit rows');
      }
      if (builder._single.onConflict) throw new ForbiddenError('CRM conflict rewrites are not supported');
    } else {
      const wheres = copy._statements.filter(s => s.grouping === 'where');
      copy._statements = copy._statements.filter(s => s.grouping !== 'where');
      if (wheres.length) copy.where(function () { this._statements.push(...wheres); });
      const guard = predicate(root.table, root.alias, actor, write);
      copy.whereRaw(guard.sql, guard.bindings);
    }
  }
  copy._statements = copy._statements.map(statement => {
    if (statement.grouping !== 'join') return statement;
    const joined = tableName(statement.table);
    if (!joined || !PROTECTED.has(joined.table)) return statement;
    const guard = predicate(joined.table, '__crm_join', actor, false);
    const clone = Object.assign(Object.create(Object.getPrototypeOf(statement)), statement);
    clone.table = client.raw(`(select * from ${identifier(joined.table)} as "__crm_join" where ${guard.sql}) as ${identifier(joined.alias)}`, guard.bindings);
    return clone;
  });
  return copy;
}

async function fenceCrmOwners(table, rows, client, connection) {
  const conn = connectionHandle(client);
  const locked = new Set();
  const lock = async (target, where) => {
    const query = conn(target).where(where).select('*').connection(connection);
    query[INTERNAL] = true; // authorization is checked separately, not bypassed
    if (client.config.client === 'pg') query.forShare();
    return query;
  };
  const lockAnchors = async (target, row) => {
    const key = `${target}:${row.id}`;
    if (locked.has(key)) return;
    locked.add(key);
    if (SIGNER_CHILDREN.has(target)) {
      const [signer] = await lock('contract_signers', { id: row.signer_id });
      if (signer) await lockAnchors('contract_signers', signer);
    } else if (CHILDREN[target]) {
      const [parent, field] = CHILDREN[target];
      const [record] = await lock(parent, { id: row[field] });
      if (record) await lockAnchors(parent, record);
    } else if (ROOTS[target] && row.created_by_admin_id == null) {
      // A legacy grant derives from these rows, so locking only the nullable
      // document creator is insufficient when a project/event is reassigned.
      if (row.project_id) {
        await lock('projects', { id: row.project_id });
        await lock('events', { project_id: row.project_id });
      }
      const eventId = row.event_id || row.converted_event_id;
      if (eventId) await lock('events', { id: eventId });
      for (const [field, parent] of [['source_quote_id', 'quotes'], ['source_contract_id', 'contracts']]) {
        if (!row[field]) continue;
        const [record] = await lock(parent, { id: row[field] });
        if (record) await lockAnchors(parent, record);
      }
      if (row.deal_uuid) for (const root of Object.keys(ROOTS)) await lock(root, { deal_uuid: row.deal_uuid });
    }
  };
  for (const row of rows) await lockAnchors(table, row);
}

/** Fence and validate changed relationships on the transaction's connection. */
async function validateWrite(builder, client, connection) {
  const parsed = tableName(builder._single?.table);
  if (!parsed || !PROTECTED.has(parsed.table) || !['insert', 'update'].includes(builder._method)) return;
  const context = contextForProtected();
  if (context.trusted || context.actor?.roleName === 'super_admin' || builder[INTERNAL]) return;
  const actor = context.actor, table = parsed.table;
  const securityColumns = new Set(['id', 'created_by_admin_id', 'deal_uuid', 'project_id', 'event_id', 'converted_event_id',
    'source_quote_id', 'source_contract_id', 'converted_contract_id', 'replaces_quote_id', 'cancels_invoice_id',
    'replaces_invoice_id', 'cancellation_storno_id', 'parent_line_item_id', 'quote_id', 'invoice_id', 'contract_id',
    'signer_id', 'doc_type', 'doc_id', 'document_type', 'document_id']);
  if (Object.keys(builder._single.counter || {}).some(column => securityColumns.has(column))) {
    throw new ForbiddenError('CRM relationships cannot be incremented');
  }
  const values = builder._method === 'insert' ? builder._single.insert : builder._single.update || {};
  const rows = Array.isArray(values) ? values : [values];
  const conn = connectionHandle(client);
  if (builder._method === 'update') {
    const existing = builder.clone();
    existing._method = 'select';
    existing.clearSelect().clearOrder().select(`${parsed.alias}.*`).connection(connection);
    if (client.config.client === 'pg') existing.forNoKeyUpdate();
    await fenceCrmOwners(table, await existing, client, connection);
  }
  const check = async (target, id, column = 'id') => {
    if (!Number.isSafeInteger(Number(id)) || Number(id) <= 0) throw new NotFoundError('CRM relationship');
    let query = conn(target).where(column, id).select(`${target}.*`).connection(connection);
    if (client.config.client === 'pg') query.forShare();
    const rows = await query;
    if (!rows.length) throw new NotFoundError('CRM relationship');
    await fenceCrmOwners(target, rows, client, connection);
    // Recheck after acquiring all derived-owner locks. An ownership-changing
    // transaction that won before the locks must not leave a stale grant.
    if (!(await conn(target).where(column, id).select('id').connection(connection)).length) throw new NotFoundError('CRM relationship');
  };
  for (const row of rows) {
    if (!row || typeof row !== 'object' || row.toSQL) throw new ForbiddenError('CRM writes require explicit values');
    if (builder._method === 'update' && Object.hasOwn(row, 'id')) throw new ForbiddenError('CRM identifiers cannot be changed');
    if (ROOTS[table]) {
      if (!allowed(actor, table, true)) throw new ForbiddenError('Insufficient CRM permissions');
      if (builder._method === 'insert' && Number(row.created_by_admin_id) !== actor.id) throw new ForbiddenError('CRM creator must be the current actor');
      if (builder._method === 'insert' && actor.capability) {
        const cap = actor.capability;
        const inDeal = cap.dealUuid && row.deal_uuid === cap.dealUuid;
        const inEvent = cap.eventId && Number(row.event_id || row.converted_event_id) === Number(cap.eventId);
        const inSource = (cap.root === 'quotes' && Number(row.source_quote_id) === cap.id)
          || (cap.root === 'contracts' && Number(row.source_contract_id) === cap.id);
        if (!inDeal && !inEvent && !inSource) throw new ForbiddenError('CRM write exceeds workflow entity capability');
      }
      if (Object.hasOwn(row, 'created_by_admin_id')) {
        if (Number(row.created_by_admin_id) !== actor.id) throw new ForbiddenError('CRM ownership cannot be transferred');
        if (builder._method === 'update') builder.where('created_by_admin_id', actor.id);
      }
      for (const [field, target] of [['source_quote_id', 'quotes'], ['source_contract_id', 'contracts'],
        ['converted_contract_id', 'contracts'], ['replaces_quote_id', 'quotes'],
        ['cancels_invoice_id', 'invoices'], ['replaces_invoice_id', 'invoices'], ['cancellation_storno_id', 'invoices']]) {
        if (row[field] != null) await check(target, row[field]);
      }
      for (const field of ['event_id', 'converted_event_id', 'project_id']) {
        if (row[field] == null) continue;
        const target = field === 'project_id' ? 'projects' : 'events';
        let query = conn(target).where('id', row[field]).where('created_by', actor.id).select('id').connection(connection);
        if (client.config.client === 'pg') query.forShare();
        if (!(await query).length) throw new NotFoundError('CRM relationship');
      }
      if (row.deal_uuid != null) {
        const cap = actor.capability;
        const derivedInsert = builder._method === 'insert' && cap && ((cap.root === 'quotes' && Number(row.source_quote_id) === cap.id)
          || (cap.root === 'contracts' && Number(row.source_contract_id) === cap.id));
        if (cap && row.deal_uuid !== cap.dealUuid && !derivedInsert) throw new ForbiddenError('CRM lineage exceeds workflow entity capability');
        for (const target of Object.keys(ROOTS)) {
          // Lock all existing lineage records first, not merely the visible
          // subset. The scoped check below must account for each of them.
          const all = conn(target).where('deal_uuid', row.deal_uuid).select('id').connection(connection);
          all[INTERNAL] = true;
          if (client.config.client === 'pg') all.forShare();
          const existing = await all;
          for (const record of existing) await check(target, record.id);
        }
      }
    } else if (CHILDREN[table]) {
      const [target, field] = CHILDREN[table];
      if (row[field] != null) await check(target, row[field]);
      else if (builder._method === 'insert' && table !== 'contract_signing_signals') throw new NotFoundError('CRM relationship');
      if (!allowed(actor, target, true)) throw new ForbiddenError('Insufficient CRM permissions');
      if (row.parent_line_item_id != null) await check(table, row.parent_line_item_id);
    } else if (SIGNER_CHILDREN.has(table)) {
      if (!allowed(actor, 'contracts', true)) throw new ForbiddenError('Insufficient CRM permissions');
      if (row.signer_id != null) await check('contract_signers', row.signer_id);
      else if (builder._method === 'insert') throw new NotFoundError('CRM relationship');
    } else if (POLYMORPHIC[table]) {
      const [type, id] = POLYMORPHIC[table];
      const target = TYPES[row[type]];
      if (target) {
        if (!allowed(actor, target, true)) throw new ForbiddenError('Insufficient CRM permissions');
        await check(target, row[id]);
      } else if (Object.hasOwn(row, id) && !Object.hasOwn(row, type)) throw new ForbiddenError('CRM document type required');
    } else if (table === 'customer_documents' && row.contract_id != null) {
      if (!allowed(actor, 'contracts', true)) throw new ForbiddenError('Insufficient CRM permissions');
      await check('contracts', row.contract_id);
    }
  }
}

async function validateDelete(builder, client, connection) {
  const parsed = tableName(builder._single?.table);
  if (!parsed || (!CRM_REFERENCES[parsed.table] && !PROTECTED.has(parsed.table))) return;
  const context = contextForProtected();
  if (context.trusted || context.actor?.roleName === 'super_admin') return;
  const actor = context.actor;
  if (ROOTS[parsed.table] && !allowed(actor, parsed.table, true)) throw new ForbiddenError('Insufficient CRM permissions');
  const conn = connectionHandle(client);
  const parents = builder.clone();
  parents._method = 'select';
  parents.clearSelect().clearOrder().select(`${parsed.alias}.*`).connection(connection);
  if (client.config.client === 'pg') parents.forUpdate();
  const rows = await parents;
  await fenceCrmOwners(parsed.table, rows, client, connection);
  const ids = rows.map(r => r.id);
  const visited = new Set();
  const inspectReferences = async (parent, parentIds) => {
    const unseen = parentIds.filter(id => {
      const key = `${parent}:${id}`;
      if (visited.has(key)) return false;
      visited.add(key);
      return true;
    });
    for (let offset = 0; offset < unseen.length; offset += 400) {
      for (const [target, column, action] of CRM_REFERENCES[parent] || []) {
        if (!(await conn.schema.hasTable(target).connection(connection))
        || !(await conn.schema.hasColumn(target, column).connection(connection))) continue;
        const chunk = unseen.slice(offset, offset + 400);
        const all = conn(target).whereIn(column, chunk).select('*').connection(connection);
        all[INTERNAL] = true;
        if (client.config.client === 'pg') all.forShare();
        const referenced = await all;
        if (!referenced.length) continue;
        if (PROTECTED.has(target)) {
          await fenceCrmOwners(target, referenced, client, connection);
          const guard = predicate(target, target, actor, true);
          const visible = await conn(target).whereIn(column, chunk)
            .whereRaw(guard.sql, guard.bindings).select('id').connection(connection);
          if (visible.length !== referenced.length) throw new ForbiddenError('CRM references prevent this deletion');
        }
        if (action === 'delete') await inspectReferences(target, referenced.map(r => r.id));
      }
    }
  };
  await inspectReferences(parsed.table, ids);
}

/** Only the shipped executable graph, not its editable builtin flag, is trusted. */
async function isShippedCrmGraph(workflow, graph) {
  if (workflow?.created_by || !graph?.nodeByKey || !Array.isArray(graph.edges)) return false;
  const { BUILTINS, buildDunningGraph } = require('../services/_workflowSeedBoot');
  const def = BUILTINS.find(entry => entry.key === workflow.builtin_key);
  if (!def || workflow.trigger_type !== def.trigger_type) return false;
  let shipped;
  if (def.key === 'invoice_dunning') {
    // Timing is seeded from settings, which may have changed since this pinned
    // version was written. Accept only the same shipped ladder/actions with
    // finite stored timing; never arbitrary configs, targets or recipients.
    const firstDays = graph.nodeByKey.get('waitGrace')?.config?.delayDays;
    const gapDays = graph.nodeByKey.get('waitGap')?.config?.delayDays;
    if (!Number.isFinite(firstDays) || firstDays < 0 || !Number.isFinite(gapDays) || gapDays < 1) return false;
    shipped = buildDunningGraph({ firstDays, gapDays, maxReminders: 3 });
  } else shipped = await def.build();
  const canonical = value => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
  };
  const executable = (nodes, edges) => canonical({
    nodes: nodes.map(n => ({ key: n.node_key, type: n.type, config: n.config || {} }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    edges: edges.map(e => ({ from: e.from_node, to: e.to_node, handle: e.from_handle || null,
      loop: [true, 1, '1'].includes(e.loop_back) })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  });
  return JSON.stringify(executable([...graph.nodeByKey.values()], graph.edges))
    === JSON.stringify(executable(shipped.nodes, shipped.edges));
}

/** Rehydrate workflow authority independently of its editable graph/payload. */
async function workflowCrmActor(run, workflow, initiatingAdminId, graph) {
  const { db } = require('./db');
  const roots = { quote: 'quotes', invoice: 'invoices', contract: 'contracts', event: 'events' };
  const root = roots[run.entity_type];
  const inherited = currentCrmActor();
  const originId = initiatingAdminId || inherited?.id;
  const builtinKeys = new Set(['invoice_dunning', 'pre_event_email', 'booking_full', 'booking_simple', 'booking_invoice_only', 'contract_completed_invoice']);
  const builtin = [true, 1, '1'].includes(workflow?.is_builtin) && builtinKeys.has(workflow?.builtin_key)
    && await isShippedCrmGraph(workflow, graph);
  let actor;
  if (originId) actor = await loadCrmActor({ id: Number(originId) });
  else if (!builtin && workflow?.created_by) actor = await loadCrmActor({ id: Number(workflow.created_by) });
  else if (!builtin) throw new ForbiddenError('Workflow has no live CRM actor');
  // A globally editable graph cannot inherit a creator's super-admin
  // exception. Only a live/persisted authenticated origin may retain it.
  if (!originId && actor?.roleName === 'super_admin') actor = { ...actor, roleName: 'crm_workflow_creator' };

  if (!root || !run.entity_id) {
    if (actor) return actor; // non-CRM actions retain the live delegated actor
    throw new ForbiddenError('System workflow requires an authoritative entity');
  }
  const loadEntity = async () => {
    const query = db(root).where('id', run.entity_id);
    if (root === 'events' && actor?.roleName !== 'super_admin') query.where('created_by', actor?.id);
    return query.first();
  };
  const entity = actor ? await withCrmActor(actor, loadEntity)
    : await withTrustedCrmAccess('shipped workflow authoritative entity lookup', () => db(root).where('id', run.entity_id).first());
  if (!entity) throw new NotFoundError('Workflow entity');
  if (!actor) {
    let ownerId = root === 'events' ? entity.created_by : entity.created_by_admin_id;
    if (!ownerId && entity.project_id) ownerId = (await db('projects').where('id', entity.project_id).first('created_by'))?.created_by;
    const eventId = root === 'events' ? entity.id : entity.event_id || entity.converted_event_id;
    if (!ownerId && eventId) ownerId = (await db('events').where('id', eventId).first('created_by'))?.created_by;
    // Legacy ownerless documents still need a real audit/FK identity. This
    // choice is not a super-admin grant: the entity capability below remains
    // mandatory for every read and write.
    if (!ownerId) ownerId = (await db('admin_users').join('roles', 'roles.id', 'admin_users.role_id')
      .where('roles.name', 'super_admin').where('admin_users.is_active', require('../utils/dbCompat').formatBoolean(true))
      .orderBy('admin_users.id').first('admin_users.id'))?.id;
    if (!ownerId) throw new ForbiddenError('System workflow audit actor unavailable');
    actor = { id: Number(ownerId), roleName: 'crm_system_capability', permissions: new Set(Object.values(ROOTS).flatMap(d => [`${d}.view`, `${d}.manage`])) };
  }
  // Super-admin is an explicit authenticated exception, not a role inferred
  // from an editable workflow definition. Other actors are entity-bound.
  if (actor.roleName === 'super_admin') return actor;
  return Object.freeze({ ...actor, capability: Object.freeze({ root, id: Number(entity.id), dealUuid: entity.deal_uuid || null,
    eventId: root === 'events' ? Number(entity.id) : entity.event_id || entity.converted_event_id || null }) });
}

/**
 * Install on the dialect prototype: Knex transaction clients inherit it too.
 * Enforcement happens at compilation, after callers have finished modifying
 * WHERE/OR/clone/from, and again at execution for insert/relationship values.
 * The bounded Knex 2 builder internals used here have cross-dialect regressions.
 */
function installCrmAccess(client) {
  const prototype = Object.getPrototypeOf(client);
  if (Object.hasOwn(prototype, INSTALLED)) return;
  Object.defineProperty(prototype, INSTALLED, { value: true });
  const compile = prototype.queryCompiler;
  prototype.queryCompiler = function (builder, formatter) {
    return compile.call(this, protectBuilder(builder, this), formatter);
  };
  const createRunner = prototype.runner;
  prototype.runner = function (builder) {
    const runner = createRunner.call(this, builder);
    const run = runner.run;
    const stream = runner.stream;
    runner.stream = function (...args) {
      const root = tableName(builder._single?.table);
      if (root && (PROTECTED.has(root.table) || CRM_REFERENCES[root.table])
        && !['select', 'first', 'pluck'].includes(builder._method || 'select')) {
        const context = contextForProtected();
        if (!context.trusted && context.actor?.roleName !== 'super_admin') throw new ForbiddenError('Streaming CRM mutations are not supported');
      }
      return stream.apply(this, args);
    };
    runner.run = async function () {
      if (builder.isRawInstance && (referencesCrm(rawSql(builder)) || rawCrmMutation(rawSql(builder)))) {
        const context = contextForProtected();
        if (!context.trusted && context.actor?.roleName !== 'super_admin') throw new ForbiddenError('Raw CRM queries are not supported');
      }
      const parsed = tableName(builder._single?.table);
      const deleting = parsed && (CRM_REFERENCES[parsed.table] || PROTECTED.has(parsed.table)) && ['del', 'delete'].includes(builder._method);
      const sensitive = deleting || (parsed && PROTECTED.has(parsed.table) && ['insert', 'update'].includes(builder._method));
      if (sensitive && !builder[INTERNAL]) {
        const context = contextForProtected();
        if (!context.trusted && context.actor?.roleName !== 'super_admin') {
          if (!this.client.transacting) {
            const conn = connectionHandle(this.client);
            return conn.transaction(trx => builder.clone().transacting(trx));
          }
          await this.ensureConnection(() => deleting ? validateDelete(builder, this.client, this.connection)
            : validateWrite(builder, this.client, this.connection));
        }
      }
      return run.call(this);
    };
    return runner;
  };
}

/** Numeric admin document routes deny before uploads or any side effects. */
function requireCrmDocument(root) {
  return async (req, res, next) => {
    // express-validator accepts a leading plus and zero-padded integers;
    // authorize those equivalent forms before multipart side effects too.
    if (!/^\+?\d+$/.test(req.params.id || '')) return next();
    try {
      // Preserve the route's existing domain-permission response. Without
      // that domain there is no ownership probe, including for missing IDs.
      const actor = currentCrmActor();
      if (actor && !allowed(actor, root, false)) return next();
      const { db } = require('./db');
      if (!(await db(root).where('id', Number(req.params.id)).first('id'))) {
        return res.status(404).json({ error: 'Document not found', code: 'NOT_FOUND' });
      }
      return next();
    } catch (error) { return next(error); }
  };
}

async function assertCrmParent(root, id) {
  const context = contextForProtected();
  if (context.trusted || context.actor?.roleName === 'super_admin') return;
  const { db } = require('./db');
  if (!(await db(root).where('id', id).first('id'))) throw new NotFoundError('Document');
}

module.exports = { installCrmAccess, loadCrmActor, withCrmActor, currentCrmActor,
  withTrustedCrmAccess, crmCapabilityRouter, requireCrmDocument,
  enterTrustedCrmFixtureContext, withoutCrmContext, workflowCrmActor, assertCrmParent };
