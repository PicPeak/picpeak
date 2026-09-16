/**
 * Append-only change history for accounting records (migration 219).
 *
 * Every insert, update and delete of an audited table goes through
 * auditedInsert / auditedUpdate / auditedDelete. Each reads the affected rows,
 * makes the change and writes one history row per changed record with the
 * old and new values, all in one transaction: when the caller passes a
 * transaction it is used, otherwise one is opened for that write. A failed
 * history insert therefore rolls the change back, unlike logActivity, which
 * is best-effort.
 *
 * Nothing in the application may update or delete history rows;
 * __tests__/services/accountingHistoryCoverage.test.js pins that, and that
 * audited tables are not written anywhere else.
 */
const { db } = require('../database/db');

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
  expenses: { entity: 'expense', document: (row) => ['expense', row.id] },
  inbound_documents: { entity: 'inbound_document', document: (row) => ['inbound_document', row.id] },
};

// Bookkeeping columns: a change to only these is not a change to the record.
// raw_parsed is the parser's full output for an incoming invoice.
const IGNORED_COLUMNS = new Set([
  'updated_at', 'raw_parsed', 'create_idempotency_key', 'workflow_response_emitted_at',
]);
// Never copy anything shaped like a credential into the history.
const SECRET_COLUMN = /token|secret|password/i;

// SQLite caps bound parameters; keep IN lists well below it.
const CHUNK = 500;

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

function recorded(column) {
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
function diffRows(before, after) {
  const changes = {};
  const columns = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const column of columns) {
    if (!recorded(column)) continue;
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
  return executor.isTransaction ? work(executor) : executor.transaction(work);
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
  const changes = diffRows(numericBigints(before, columns), numericBigints(after, columns));
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
    const lock = applyWhere(trx(table).select('*'), where);
    if (trx.client.config.client === 'pg') lock.forUpdate();
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
  return inTransaction(conn, async (trx) => {
    const lock = applyWhere(trx(table).select('*'), where);
    if (trx.client.config.client === 'pg') lock.forUpdate();
    const before = await lock;
    if (before.length === 0) return 0;
    let count = 0;
    const ids = before.map((row) => row.id);
    for (let i = 0; i < ids.length; i += CHUNK) {
      count += await applyWhere(trx(table).whereIn('id', ids.slice(i, i + CHUNK)), where).delete();
    }
    for (const row of before) await writeHistory(trx, table, 'deleted', row, null, context);
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

module.exports = {
  AUDITED_TABLES,
  auditedInsert,
  auditedUpdate,
  auditedDelete,
  listHistory,
  diffRows,
  normalizeActor,
};
