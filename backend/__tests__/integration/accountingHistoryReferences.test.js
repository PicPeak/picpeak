const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

let db; let cleanup; let adminId; let customerId; let history;
let sequence = 0;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ adminId, customerId } = await seedMinimal(db));
  history = require('../../src/services/accountingHistory');
});
afterAll(async () => { if (cleanup) await cleanup(); });

const invoice = (extra = {}) => history.auditedInsert(db, 'invoices', {
  invoice_number: `REF-${++sequence}`, customer_account_id: customerId,
  issue_date: '2026-09-01', due_date: '2026-09-30', total_amount_minor: 10000, ...extra,
});

it('covers the schema foreign keys that change audited rows on deletion', async () => {
  const references = require('../../src/services/accountingHistoryReferences');
  let foreignKeys;
  if (db.client.config.client === 'pg') {
    foreignKeys = (await db.raw(`
      SELECT k.table_name, k.column_name, c.table_name AS parent_table, r.delete_rule
      FROM information_schema.referential_constraints r
      JOIN information_schema.key_column_usage k
        ON k.constraint_schema = r.constraint_schema AND k.constraint_name = r.constraint_name
      JOIN information_schema.constraint_column_usage c
        ON c.constraint_schema = r.unique_constraint_schema AND c.constraint_name = r.unique_constraint_name
      WHERE r.constraint_schema = 'public'
    `)).rows;
  } else {
    const tables = new Set([
      ...Object.keys(history.AUDITED_TABLES),
      ...Object.values(references).flat().map((ref) => ref.table),
    ]);
    foreignKeys = [];
    for (const table of tables) {
      for (const fk of await db.raw('PRAGMA foreign_key_list(??)', [table])) {
        foreignKeys.push({ table_name: table, column_name: fk.from, parent_table: fk.table, delete_rule: fk.on_delete });
      }
    }
  }
  const key = (parent, table, column, action) => `${parent}:${table}:${column}:${action}`;
  const mapped = Object.entries(references).flatMap(([parent, refs]) => refs.map((ref) =>
    key(parent, ref.table, ref.column, ref.action === 'delete' ? 'CASCADE' : 'SET NULL')));
  const schema = foreignKeys.map((fk) => key(fk.parent_table, fk.table_name, fk.column_name, fk.delete_rule));
  expect(mapped.filter((entry) => !schema.includes(entry))).toEqual([]);
  expect(foreignKeys.filter((fk) => history.AUDITED_TABLES[fk.table_name] && ['CASCADE', 'SET NULL'].includes(fk.delete_rule))
    .map((fk) => key(fk.parent_table, fk.table_name, fk.column_name, fk.delete_rule))
    .filter((entry) => !mapped.includes(entry))).toEqual([]);
});

it('records expense references when a custom category is deleted', async () => {
  const categories = require('../../src/services/expenseCategoriesService');
  const category = await categories.create({ name: 'History category' }, adminId);
  const [{ id }] = await history.auditedInsert(db, 'expenses', { disposition: 'eigener_aufwand', category_id: category.id });
  await categories.remove(category.id, adminId);
  expect((await db('expenses').where({ id }).first()).category_id).toBeNull();
  const entry = (await history.listHistory('expense', id)).at(-1);
  expect(entry.changes.category_id).toEqual({ from: category.id, to: null });
  expect(entry.actor.id).toBe(adminId);
});

it('keeps the category and reference if recording the change fails', async () => {
  const categories = require('../../src/services/expenseCategoriesService');
  const category = await categories.create({ name: 'Retained category' }, adminId);
  const [{ id }] = await history.auditedInsert(db, 'expenses', { disposition: 'eigener_aufwand', category_id: category.id });
  await db.schema.renameTable('accounting_change_history', 'history_offline');
  try { await expect(categories.remove(category.id, adminId)).rejects.toThrow(); }
  finally { await db.schema.renameTable('history_offline', 'accounting_change_history'); }
  expect(await db('expense_categories').where({ id: category.id }).first()).toBeTruthy();
  expect((await db('expenses').where({ id }).first()).category_id).toBe(category.id);
});

it('records invoice references when a bank account is deleted', async () => {
  const [bank] = await db('business_bank_accounts').insert({ business_profile_id: 1, label: 'History bank', iban: 'CH9300762011623852957', currency: 'CHF' }).returning('id');
  const [{ id }] = await invoice({ business_bank_account_id: bank.id });
  await require('../../src/services/businessProfileService').deleteBankAccount(bank.id, adminId);
  expect((await db('invoices').where({ id }).first()).business_bank_account_id).toBeNull();
  expect((await history.listHistory('invoice', id)).at(-1).changes.business_bank_account_id).toEqual({ from: bank.id, to: null });
});

it('records invoice references when its event is deleted through the cascade', async () => {
  const [event] = await db('events').insert({
    slug: 'history-delete-event', event_type: 'other', event_name: 'History event',
    event_date: '2026-09-01', host_email: 'host@example.com', admin_email: 'admin@example.com',
    password_hash: 'x', share_link: 'history-delete-share', expires_at: new Date().toISOString(),
  }).returning('id');
  const [{ id }] = await invoice({ event_id: event.id });
  await require('../../src/routes/adminEvents/helpers').deleteEventCascade(event.id, { id: adminId });
  expect(await db('events').where({ id: event.id }).first()).toBeUndefined();
  expect((await db('invoices').where({ id }).first()).event_id).toBeNull();
  expect((await history.listHistory('invoice', id)).at(-1)).toMatchObject({
    changes: { event_id: { from: event.id, to: null } }, actor: { type: 'admin', id: adminId },
  });
});

it('records invoice authorship changes when an admin is deleted', async () => {
  const [admin] = await db('admin_users').insert({
    username: 'history-deleted-admin', email: 'history-deleted@example.com', password_hash: 'x',
  }).returning('id');
  const [{ id }] = await invoice({ created_by_admin_id: admin.id });
  await require('../../src/services/userManagementService').deleteAdminUser(admin.id, adminId);
  expect((await db('invoices').where({ id }).first()).created_by_admin_id).toBeNull();
  expect((await history.listHistory('invoice', id)).at(-1).changes.created_by_admin_id)
    .toEqual({ from: admin.id, to: null });
});

it('records cascaded line-item and payment deletion and nulls surviving references', async () => {
  const [{ id }] = await invoice();
  const [parent] = await history.auditedInsert(db, 'invoice_line_items', { invoice_id: id, description: 'Parent', position: 1 });
  const [child] = await history.auditedInsert(db, 'invoice_line_items', { invoice_id: id, description: 'Child', position: 2, parent_line_item_id: parent.id });
  const [payment] = await history.auditedInsert(db, 'invoice_payment_log', { invoice_id: id, amount_minor: 100, paid_at: new Date() });
  const [survivor] = await invoice({ replaces_invoice_id: id });
  await history.auditedDelete(db, 'invoices', { id }, { actor: adminId });
  expect(await db('invoice_line_items').where({ invoice_id: id })).toEqual([]);
  expect(await db('invoice_payment_log').where({ invoice_id: id })).toEqual([]);
  expect((await db('invoices').where({ id: survivor.id }).first()).replaces_invoice_id).toBeNull();
  const deleted = (await history.listHistory('invoice', id)).filter((e) => e.action === 'deleted');
  expect(deleted.map((e) => `${e.entity_type}:${e.entity_id}`).sort()).toEqual([
    `invoice:${id}`, `invoice_line_item:${parent.id}`, `invoice_line_item:${child.id}`, `invoice_payment:${payment.id}`,
  ].sort());
  expect((await history.listHistory('invoice', survivor.id)).at(-1).changes.replaces_invoice_id).toEqual({ from: id, to: null });
});

it('records child removal when only a parent line item is deleted', async () => {
  const [{ id }] = await invoice();
  const [parent] = await history.auditedInsert(db, 'invoice_line_items', { invoice_id: id, description: 'Parent', position: 1 });
  const [child] = await history.auditedInsert(db, 'invoice_line_items', { invoice_id: id, description: 'Child', position: 2, parent_line_item_id: parent.id });
  await history.auditedDelete(db, 'invoice_line_items', { id: parent.id });
  expect(await db('invoice_line_items').where({ invoice_id: id })).toEqual([]);
  const removedIds = (await history.listHistory('invoice', id)).filter((e) => e.action === 'deleted').map((e) => e.entity_id);
  expect(removedIds.sort()).toEqual([child.id, parent.id].sort());
});
