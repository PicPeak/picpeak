/**
 * Append-only change history for accounting records (migration 219).
 *
 * Every insert, update and delete of an audited table goes through
 * auditedInsert / auditedUpdate / auditedDelete. Each reads the affected rows,
 * makes the change and writes one history row per changed record with the
 * old and new values, all in one transaction: when the caller passes a
 * transaction a savepoint is used, otherwise one is opened for that write. A failed
 * history insert therefore rolls the change back, unlike logActivity, which
 * is best-effort.
 *
 * Nothing in the application may update or delete history rows, with one
 * exception: erasing a customer blanks the values in that customer's own
 * billing-field history and their name as an actor (redactCustomerHistory). The document history of
 * their invoices, quotes and contracts is kept, like the documents.
 * __tests__/services/accountingHistoryCoverage.test.js pins that, and that
 * audited tables are not written anywhere else.
 */
const { db } = require('../database/db');
const DELETE_REFERENCES = require('./accountingHistoryReferences');

const invoiceDocument = (row) => ['invoice', row.invoice_id];

const AUDITED_TABLES = {
  invoices: { entity: 'invoice', document: (row) => ['invoice', row.id] },
  invoice_line_items: { entity: 'invoice_line_item', document: invoiceDocument },
  invoice_payment_log: { entity: 'invoice_payment', document: invoiceDocument },
  quotes: { entity: 'quote', document: (row) => ['quote', row.id] },
  quote_line_items: { entity: 'quote_line_item', document: (row) => ['quote', row.quote_id] },
  contracts: { entity: 'contract', document: (row) => ['contract', row.id] },
  contract_block_inclusions: {
    entity: 'contract_block_inclusion', document: (row) => ['contract', row.contract_id],
  },
  // The free text a contract carries beyond its clauses, and which
  // attachments go out with it and how — both are part of what the customer
  // is sent, so a change to either belongs in the document's history (#1445).
  contract_text_sections: {
    entity: 'contract_text_section', document: (row) => ['contract', row.contract_id],
  },
  contract_attachment_inclusions: {
    entity: 'contract_attachment_inclusion', document: (row) => ['contract', row.contract_id],
  },
  expenses: { entity: 'expense', document: (row) => ['expense', row.id] },
  inbound_documents: { entity: 'inbound_document', document: (row) => ['inbound_document', row.id] },
  // Configuration printed on or feeding accounting documents.
  business_profile: { entity: 'business_profile', document: (row) => ['business_profile', row.id] },
  business_bank_accounts: {
    entity: 'bank_account', document: (row) => ['business_profile', row.business_profile_id || 1],
  },
  ledger_accounts: { entity: 'ledger_account', document: (row) => ['ledger_account', row.id] },
  vat_codes: { entity: 'vat_code', document: (row) => ['vat_code', row.id] },
  expense_categories: { entity: 'expense_category', document: (row) => ['expense_category', row.id] },
  // Only the columns that feed billing; logins, passwords, portal feature
  // switches and marketing consent are not accounting data.
  customer_accounts: {
    entity: 'customer',
    document: (row) => ['customer', row.id],
    columns: [
      'salutation', 'first_name', 'last_name', 'display_name', 'company_name', 'email',
      'billing_email', 'vat_id', 'address_line1', 'address_line2', 'postal_code', 'city',
      'state', 'country_code', 'country_name', 'preferred_language', 'billing_cadence',
      'billing_cycle_day', 'hourly_rate_minor', 'day_rate_minor', 'skonto_disabled', 'rebill_attach_proof',
    ],
  },
  customer_hour_entries: { entity: 'hour_entry', document: (row) => ['customer', row.customer_account_id] },
};

// Bookkeeping columns: a change to only these is not a change to the record.
// raw_parsed is the parser's full output for an incoming invoice.
// Bookkeeping and derived columns:
//   audit_chain_head moves with every entry in a contract's own signing event
//     log (#1446), which is itself the append-only record of those events;
//   rendered_content is the contract's whole frozen text (#1445), copied in
//     full on both sides of every change that touches it. Its sha256 IS
//     recorded and changes with it, so the history still shows that the
//     frozen text changed, and the text itself lives on the contract and in
//     the stored PDF.
const IGNORED_COLUMNS = new Set([
  'updated_at', 'raw_parsed', 'create_idempotency_key', 'workflow_response_emitted_at',
  'audit_chain_head', 'rendered_content',
]);
// Never copy anything shaped like a credential into the history.
const SECRET_COLUMN = /token|secret|password/i;

// SQLite caps bound parameters; keep IN lists well below it.
const CHUNK = 400;

// PostgreSQL returns bigint columns (the *_minor amounts) as strings, SQLite
// as numbers. Record numbers on both, so a history reads the same everywhere.
const bigintColumnsByTable = new Map();
async function bigintColumns(trx, table) {
  if (trx.client.config.client !== 'pg') return new Set();
  if (!bigintColumnsByTable.has(table)) {
    const info = await trx(table).columnInfo();
    bigintColumnsByTable.set(table, new Set(
      Object.entries(info).filter(([, column]) => column.type === 'bigint').map(([name]) => name),
    ));
  }
  return bigintColumnsByTable.get(table);
}

function numericBigints(row, columns) {
  if (!row || columns.size === 0) return row;
  const copy = { ...row };
  for (const column of columns) {
    if (typeof copy[column] === 'string' && Number.isSafeInteger(Number(copy[column]))) {
      copy[column] = Number(copy[column]);
    }
  }
  return copy;
}

function tableConfig(table) {
  const config = AUDITED_TABLES[table];
  if (!config) throw new Error(`accountingHistory: ${table} is not an audited table`);
  return config;
}

function recorded(column, config) {
  if (config?.columns && !config.columns.includes(column)) return false;
  return !IGNORED_COLUMNS.has(column) && !SECRET_COLUMN.test(column);
}

function normalizeValue(value) {
  if (value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Buffer.isBuffer(value)) return '[binary]';
  return value;
}

function sameValue(a, b) {
  return JSON.stringify(normalizeValue(a)) === JSON.stringify(normalizeValue(b));
}

/**
 * { column: { from, to } } for the recorded columns that differ. A created
 * record lists its non-null values, a deleted one what it held.
 */
function diffRows(before, after, config = null) {
  const changes = {};
  const columns = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const column of columns) {
    if (!recorded(column, config)) continue;
    const from = before ? normalizeValue(before[column]) : null;
    const to = after ? normalizeValue(after[column]) : null;
    if (sameValue(from, to)) continue;
    changes[column] = { from, to };
  }
  return changes;
}

/**
 * Actors arrive in every shape the services already use: an admin id, an
 * { type, id, name } object, or strings like 'admin:5', 'customer:public' and
 * 'scheduler'.
 */
function normalizeActor(actor) {
  if (actor === null || actor === undefined) return { type: 'system', id: null, name: null };
  if (typeof actor === 'number' || (typeof actor === 'string' && /^\d+$/.test(actor))) {
    return { type: 'admin', id: Number(actor), name: null };
  }
  if (typeof actor === 'string') {
    const [prefix, rest] = actor.split(':');
    if (['admin', 'customer', 'public'].includes(prefix)) {
      const id = rest && /^\d+$/.test(rest) ? Number(rest) : null;
      return { type: prefix, id, name: id === null && rest ? rest : null };
    }
    return { type: 'system', id: null, name: actor };
  }
  const type = ['admin', 'customer', 'public', 'system'].includes(actor.type) ? actor.type : 'system';
  const id = Number.isSafeInteger(Number(actor.id)) && actor.id !== null && actor.id !== undefined
    ? Number(actor.id) : null;
  return { type, id, name: actor.name ? String(actor.name).slice(0, 255) : null };
}

function inTransaction(conn, work) {
  const executor = conn || db;
  // Knex creates a savepoint when executor is already a transaction. Without
  // it a caller catching a failed history INSERT could commit the preceding
  // business write on SQLite (and could not recover its transaction on PG).
  return executor.transaction(work);
}

function applyWhere(query, where) {
  if (typeof where === 'function') where(query);
  else query.where(where);
  return query;
}

async function selectByIds(trx, table, ids) {
  const rows = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    rows.push(...await trx(table).whereIn('id', ids.slice(i, i + CHUNK)));
  }
  return rows;
}

async function writeHistory(trx, table, action, before, after, context) {
  const config = tableConfig(table);
  const row = after || before;
  const columns = await bigintColumns(trx, table);
  const changes = diffRows(numericBigints(before, columns), numericBigints(after, columns), config);
  if (action === 'updated' && Object.keys(changes).length === 0) return;
  const [documentType, documentId] = config.document(row);
  const actor = normalizeActor(context.actor);
  await trx('accounting_change_history').insert({
    document_type: documentType,
    document_id: Number(documentId),
    entity_type: config.entity,
    entity_id: Number(row.id),
    action,
    changes: JSON.stringify(changes),
    actor_type: actor.type,
    actor_id: actor.id,
    actor_name: actor.name,
    source: context.source ? String(context.source).slice(0, 100) : null,
    created_at: new Date().toISOString(),
  });
}

/**
 * Insert one row or an array of rows. Resolves to [{ id }] in insert order,
 * the shape `.returning('id')` callers already unwrap with `row.id ?? row`.
 */
async function auditedInsert(conn, table, rows, context = {}) {
  tableConfig(table);
  const list = Array.isArray(rows) ? rows : [rows];
  return inTransaction(conn, async (trx) => {
    const ids = [];
    for (const values of list) {
      const [inserted] = await trx(table).insert(values).returning('id');
      const id = Number(inserted?.id ?? inserted);
      ids.push({ id });
      const after = await trx(table).where({ id }).first();
      await writeHistory(trx, table, 'created', null, after, context);
    }
    return ids;
  });
}

/**
 * Update the rows matching `where` (an object or a query callback). Resolves
 * to the number of rows updated, like knex's update, so compare-and-set
 * callers keep working.
 */
async function auditedUpdate(conn, table, where, values, context = {}) {
  tableConfig(table);
  return inTransaction(conn, async (trx) => {
    const lock = applyWhere(trx(table).select('*'), where).orderBy('id');
    // Compatible with the KEY SHARE lock held by foreign-key checks on child
    // inserts. FOR UPDATE here deadlocks two payments inserting children of
    // the same invoice before updating it. The UPDATE itself still acquires
    // a stronger lock if it actually changes a referenced key.
    if (trx.client.config.client === 'pg') lock.forNoKeyUpdate();
    const before = await lock;
    if (before.length === 0) return 0;
    const ids = before.map((row) => row.id);
    let count = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
      count += await applyWhere(trx(table).whereIn('id', ids.slice(i, i + CHUNK)), where).update(values);
    }
    const after = new Map((await selectByIds(trx, table, ids)).map((row) => [row.id, row]));
    for (const row of before) {
      if (after.has(row.id)) await writeHistory(trx, table, 'updated', row, after.get(row.id), context);
    }
    return count;
  });
}

/** Delete the rows matching `where`. Resolves to the number deleted. */
async function auditedDelete(conn, table, where, context = {}) {
  tableConfig(table);
  return deleteWithAccountingHistory(conn, table, where, context);
}

// Also used for parents outside the accounting scope (an event, admin or
// category). Their deletion can change audited rows through foreign keys.
async function deleteWithAccountingHistory(conn, table, where, context = {}) {
  if (!AUDITED_TABLES[table] && !DELETE_REFERENCES[table]) tableConfig(table);
  return inTransaction(conn, async (trx) => {
    const lock = applyWhere(trx(table).select('*'), where).orderBy('id');
    if (trx.client.config.client === 'pg') lock.forUpdate();
    const before = await lock;
    if (before.length === 0) return 0;
    let count = 0;
    const ids = before.map((row) => row.id);
    const deletingIds = new Set(ids);
    for (const ref of DELETE_REFERENCES[table] || []) {
      if (!AUDITED_TABLES[ref.table] || !(await trx.schema.hasColumn(ref.table, ref.column))) continue;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const referencedIds = await trx(ref.table).whereIn(ref.column, ids.slice(i, i + CHUNK)).pluck('id');
        // Rows already being deleted have their original values recorded
        // below. Filter in memory to keep every bound IN list bounded.
        const affectedIds = referencedIds.filter((id) => ref.table !== table || !deletingIds.has(id));
        for (let j = 0; j < affectedIds.length; j += CHUNK) {
          const match = (q) => q.whereIn('id', affectedIds.slice(j, j + CHUNK))
            .whereIn(ref.column, ids.slice(i, i + CHUNK));
          if (ref.action === 'delete') await auditedDelete(trx, ref.table, match, context);
          else await auditedUpdate(trx, ref.table, match, { [ref.column]: null }, context);
        }
      }
    }
    for (let i = 0; i < ids.length; i += CHUNK) {
      count += await applyWhere(trx(table).whereIn('id', ids.slice(i, i + CHUNK)), where).delete();
    }
    if (AUDITED_TABLES[table]) {
      for (const row of before) await writeHistory(trx, table, 'deleted', row, null, context);
    }
    return count;
  });
}

/** The history of one document, oldest first. */
async function listHistory(documentType, documentId, conn = db) {
  const rows = await conn('accounting_change_history')
    .where({ document_type: documentType, document_id: documentId })
    .orderBy('id', 'asc');
  return rows.map((row) => ({
    id: row.id,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    action: row.action,
    changes: typeof row.changes === 'string' ? JSON.parse(row.changes) : row.changes,
    actor: { type: row.actor_type, id: row.actor_id, name: row.actor_name },
    source: row.source,
    created_at: row.created_at,
  }));
}

const ERASED = '[erased]';
// The customer billing fields that identify a person. Billing settings such
// as the cadence or hourly rate stay readable after erasure.
const PERSONAL_CUSTOMER_COLUMNS = new Set([
  'salutation', 'first_name', 'last_name', 'display_name', 'company_name', 'email',
  'billing_email', 'vat_id', 'address_line1', 'address_line2', 'postal_code', 'city',
  'state', 'country_code', 'country_name',
]);

/**
 * Blank the recorded personal values in an erased customer's own history
 * (names, addresses, emails, VAT id) and their display name as the actor of
 * any entry, including portal actions on quotes and contracts. Which fields
 * changed, when and the actor's type/id stay. Run it in the erasure's
 * transaction after the erasure's own update, whose entry holds the values
 * being erased.
 */
async function redactCustomerHistory(trx, customerId) {
  // The customer's own record, plus every entry they made as the actor: portal
  // quote responses, signatures and uploads name them on those documents too.
  const rows = await trx('accounting_change_history')
    .where((q) => q.where({ document_type: 'customer', entity_type: 'customer', document_id: customerId })
      .orWhere({ actor_type: 'customer', actor_id: customerId }));
  for (const row of rows) {
    const ownRecord = row.document_type === 'customer' && row.entity_type === 'customer'
      && Number(row.document_id) === Number(customerId);
    const changes = typeof row.changes === 'string' ? JSON.parse(row.changes) : row.changes;
    const redacted = {};
    for (const [column, { from, to }] of Object.entries(changes || {})) {
      redacted[column] = ownRecord && PERSONAL_CUSTOMER_COLUMNS.has(column)
        ? { from: from === null ? null : ERASED, to: to === null ? null : ERASED }
        : { from, to };
    }
    const actorName = row.actor_type === 'customer' && Number(row.actor_id) === Number(customerId)
      && row.actor_name !== null ? ERASED : row.actor_name;
    await trx('accounting_change_history').where({ id: row.id }).update({
      changes: JSON.stringify(redacted), actor_name: actorName,
    });
  }
  return rows.length;
}

module.exports = {
  AUDITED_TABLES,
  redactCustomerHistory,
  auditedInsert,
  auditedUpdate,
  auditedDelete,
  deleteWithAccountingHistory,
  listHistory,
  diffRows,
  normalizeActor,
};
