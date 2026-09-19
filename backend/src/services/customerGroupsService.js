/**
 * Customer groups (#1443, migration 226).
 *
 * The group catalogue an admin manages, and the many-to-many assignment of
 * customers to it. A customer belongs to none, one or several groups, and a
 * group is referenced by id everywhere, so renaming or recolouring one is
 * reflected wherever it shows without touching a customer record.
 *
 * Two rules the rest of the code relies on:
 *   - an archived group stays on the customers that carry it and is refused
 *     for new assignments (`assertAssignable`), which is the way to retire a
 *     group that is in use;
 *   - deleting a group with members is refused (`GROUP_IN_USE`). Deleting a
 *     group must never reach a customer record, so the only delete this
 *     service allows is one that affects nothing but the group itself.
 *
 * Nothing here writes `customer_accounts`, so the accounting change history
 * (services/accountingHistory) is not involved: a group is admin organisation,
 * not billing data. Changes are recorded in `activity_logs` instead.
 */

const { db, logActivity } = require('../database/db');
const { AppError } = require('../utils/errors');
const { isUniqueViolation } = require('../utils/dbErrors');

const NAME_MAX = 80;
const DESCRIPTION_MAX = 500;
const DEFAULT_COLOR = '#6B7280';
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** A colour the chip can show in both themes; anything else is refused. */
function normalizeColor(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_COLOR;
  const color = String(value).trim();
  if (!HEX_COLOR.test(color)) {
    throw new AppError('Pick a colour as a hex value, for example #2563EB', 400, 'GROUP_COLOR_INVALID');
  }
  return color.toUpperCase();
}

function normalizeName(value) {
  const name = String(value === undefined || value === null ? '' : value).trim();
  if (!name) throw new AppError('A group needs a name', 400, 'GROUP_NAME_REQUIRED');
  if (name.length > NAME_MAX) {
    throw new AppError(`A group name is at most ${NAME_MAX} characters`, 400, 'GROUP_NAME_TOO_LONG');
  }
  return name;
}

function normalizeDescription(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > DESCRIPTION_MAX) {
    throw new AppError(`A description is at most ${DESCRIPTION_MAX} characters`, 400, 'GROUP_DESCRIPTION_TOO_LONG');
  }
  return text;
}

/**
 * What name uniqueness hangs on (`customer_groups.name_key`, unique). Folded
 * here rather than with SQL LOWER(), which is ASCII-only on SQLite: "Ärzte"
 * and "ärzte" have to be one group on both engines.
 */
const nameKey = (name) => name.normalize('NFC').toLowerCase();

const nameTaken = () => new AppError('A group with that name already exists', 409, 'GROUP_NAME_TAKEN');

/** The friendly refusal; the unique index is what holds under a race. */
async function assertNameFree(name, { exceptId = null, conn = db } = {}) {
  const query = conn('customer_groups').where({ name_key: nameKey(name) });
  if (exceptId) query.whereNot('id', exceptId);
  if (await query.first()) throw nameTaken();
}

/** activity_logs wants an actor object; a bare id is stored as "system". */
const adminActor = (admin) => (admin?.id
  ? { type: 'admin', id: admin.id, name: admin.username || 'admin' }
  : null);

const toApi = (row) => ({
  id: row.id,
  name: row.name,
  description: row.description || null,
  color: row.color || DEFAULT_COLOR,
  sortOrder: Number(row.sort_order) || 0,
  isArchived: !!row.is_archived,
  memberCount: row.member_count === undefined ? undefined : Number(row.member_count) || 0,
  createdAt: row.created_at || null,
});

/**
 * The catalogue, in the admin's order. Archived groups come back only when
 * asked for, so the assignment pickers get the live ones by default.
 */
async function list({ includeArchived = false } = {}) {
  const query = db('customer_groups')
    .leftJoin('customer_group_members', 'customer_group_members.group_id', 'customer_groups.id')
    .groupBy('customer_groups.id')
    .select('customer_groups.*', db.raw('COUNT(customer_group_members.id) as member_count'))
    .orderBy('customer_groups.sort_order', 'asc')
    .orderBy('customer_groups.name', 'asc');
  if (!includeArchived) query.where('customer_groups.is_archived', false);
  return (await query).map(toApi);
}

async function getById(id) {
  const row = await db('customer_groups').where({ id }).first();
  if (!row) throw new AppError('Customer group not found', 404, 'GROUP_NOT_FOUND');
  return row;
}

async function create({ name, description, color }, admin = null) {
  const row = {
    name: normalizeName(name),
    description: normalizeDescription(description),
    color: normalizeColor(color),
    // New groups sort after the existing ones; the admin reorders from there.
    sort_order: Number((await db('customer_groups').max('sort_order as max').first())?.max || 0) + 1,
    is_archived: false,
    created_by_admin_id: admin?.id || null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  row.name_key = nameKey(row.name);
  await assertNameFree(row.name);
  let inserted;
  try {
    [inserted] = await db('customer_groups').insert(row).returning('id');
  } catch (err) {
    if (isUniqueViolation(err)) throw nameTaken();
    throw err;
  }
  const id = typeof inserted === 'object' ? inserted.id : inserted;
  await logActivity('customer_group_created', { groupId: id, name: row.name }, null, adminActor(admin));
  return toApi({ ...await getById(id), member_count: 0 });
}

/**
 * Rename, recolour, re-describe or (un)archive. Every field is optional, so a
 * caller that only archives doesn't have to send the rest back.
 */
async function update(id, payload, admin = null) {
  const existing = await getById(id);
  const updates = { updated_at: new Date().toISOString() };
  const changed = {};
  if (payload.name !== undefined) {
    updates.name = normalizeName(payload.name);
    updates.name_key = nameKey(updates.name);
    if (updates.name !== existing.name) {
      await assertNameFree(updates.name, { exceptId: id });
      changed.name = { from: existing.name, to: updates.name };
    }
  }
  if (payload.description !== undefined) {
    updates.description = normalizeDescription(payload.description);
    if (updates.description !== (existing.description || null)) changed.description = true;
  }
  if (payload.color !== undefined) {
    updates.color = normalizeColor(payload.color);
    if (updates.color !== existing.color) changed.color = { from: existing.color, to: updates.color };
  }
  if (payload.isArchived !== undefined) {
    updates.is_archived = !!payload.isArchived;
    if (!!payload.isArchived !== !!existing.is_archived) changed.isArchived = !!payload.isArchived;
  }
  try {
    await db('customer_groups').where({ id }).update(updates);
  } catch (err) {
    if (isUniqueViolation(err)) throw nameTaken();
    throw err;
  }
  if (Object.keys(changed).length > 0) {
    await logActivity('customer_group_updated', { groupId: id, name: updates.name || existing.name, changed }, null, adminActor(admin));
  }
  return (await list({ includeArchived: true })).find((group) => group.id === Number(id));
}

/**
 * Delete a group. Refused while customers carry it: the admin archives it
 * instead, or clears the assignments first. This is what keeps a delete from
 * ever reaching a customer record.
 *
 * The check and the delete are one statement, so nothing can be assigned in
 * between on SQLite. On PostgreSQL a concurrent assignment can still commit
 * after the statement took its snapshot; there the RESTRICT foreign key from
 * migration 226 refuses the delete (23503) instead of cascading it away.
 */
async function remove(id, admin = null) {
  const group = await getById(id);
  let deleted;
  try {
    deleted = await db('customer_groups')
      .where({ id })
      .whereNotExists(db('customer_group_members').where({ group_id: id }).select(db.raw('1')))
      .del();
  } catch (err) {
    if (err.code !== '23503') throw err;
    deleted = 0;
  }
  if (!deleted) {
    const [{ count }] = await db('customer_group_members').where({ group_id: id }).count({ count: '*' });
    throw new AppError(
      `${Number(count) || 0} customer(s) are still in this group. Archive it, or remove it from those customers first.`,
      409,
      'GROUP_IN_USE',
    );
  }
  await logActivity('customer_group_deleted', { groupId: id, name: group.name }, null, adminActor(admin));
  return { deleted: true };
}

/** The order the admin dragged the catalogue into. Ids not listed keep theirs. */
async function reorder(ids, admin = null) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new AppError('Send the group ids in their new order', 400, 'GROUP_ORDER_REQUIRED');
  }
  const known = await db('customer_groups').whereIn('id', ids).pluck('id');
  const missing = ids.filter((id) => !known.includes(id));
  if (missing.length > 0) throw new AppError('Customer group not found', 404, 'GROUP_NOT_FOUND');
  await db.transaction(async (trx) => {
    for (let position = 0; position < ids.length; position += 1) {
      await trx('customer_groups').where({ id: ids[position] })
        .update({ sort_order: position + 1, updated_at: new Date().toISOString() });
    }
  });
  await logActivity('customer_groups_reordered', { groupIds: ids }, null, adminActor(admin));
  return list({ includeArchived: true });
}

/** The groups on one customer, archived ones included — they are history. */
async function groupsForCustomer(customerId, conn = db) {
  const rows = await conn('customer_group_members')
    .join('customer_groups', 'customer_groups.id', 'customer_group_members.group_id')
    .where('customer_group_members.customer_account_id', customerId)
    .select('customer_groups.*')
    .orderBy('customer_groups.sort_order', 'asc')
    .orderBy('customer_groups.name', 'asc');
  return rows.map(toApi);
}

/** The same, for a page of customers at once: { customerId: [group, …] }. */
async function groupsForCustomers(customerIds, conn = db) {
  const byCustomer = new Map(customerIds.map((id) => [Number(id), []]));
  if (customerIds.length === 0) return byCustomer;
  const rows = await conn('customer_group_members')
    .join('customer_groups', 'customer_groups.id', 'customer_group_members.group_id')
    .whereIn('customer_group_members.customer_account_id', customerIds)
    .select('customer_groups.*', 'customer_group_members.customer_account_id')
    .orderBy('customer_groups.sort_order', 'asc')
    .orderBy('customer_groups.name', 'asc');
  for (const row of rows) {
    const list_ = byCustomer.get(Number(row.customer_account_id));
    if (list_) list_.push(toApi(row));
  }
  return byCustomer;
}

/**
 * Replace a customer's groups with exactly `groupIds`.
 *
 * An archived group can stay where it already is but can't be added, so a
 * customer who carries one keeps it through an unrelated edit — the caller
 * sends the ids it was shown, including the archived one.
 */
async function setCustomerGroups(customerId, groupIds, admin = null) {
  const wanted = [...new Set((Array.isArray(groupIds) ? groupIds : [])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0))];
  const customer = await db('customer_accounts').where({ id: customerId }).first('id');
  if (!customer) throw new AppError('Customer not found', 404, 'CUSTOMER_NOT_FOUND');

  const groups = wanted.length ? await db('customer_groups').whereIn('id', wanted) : [];
  if (groups.length !== wanted.length) throw new AppError('Customer group not found', 404, 'GROUP_NOT_FOUND');

  const current = await db('customer_group_members').where({ customer_account_id: customerId }).pluck('group_id');
  const currentIds = current.map((id) => Number(id));
  const added = wanted.filter((id) => !currentIds.includes(id));
  const removed = currentIds.filter((id) => !wanted.includes(id));

  const archivedAdded = groups.filter((g) => g.is_archived && added.includes(g.id));
  if (archivedAdded.length > 0) {
    throw new AppError(
      `"${archivedAdded[0].name}" is archived and can't be assigned. Restore it first.`,
      400,
      'GROUP_ARCHIVED',
    );
  }

  if (added.length === 0 && removed.length === 0) return groupsForCustomer(customerId);

  await db.transaction(async (trx) => {
    if (removed.length > 0) {
      await trx('customer_group_members')
        .where({ customer_account_id: customerId })
        .whereIn('group_id', removed)
        .del();
    }
    if (added.length > 0) {
      await trx('customer_group_members').insert(added.map((groupId) => ({
        group_id: groupId,
        customer_account_id: customerId,
        assigned_at: new Date().toISOString(),
      })));
    }
  });
  await logActivity('customer_groups_assigned', { customerId, added, removed }, null, adminActor(admin));
  return groupsForCustomer(customerId);
}

module.exports = {
  DEFAULT_COLOR,
  list,
  create,
  update,
  remove,
  reorder,
  groupsForCustomer,
  groupsForCustomers,
  setCustomerGroups,
  _internal: { normalizeColor, normalizeName, normalizeDescription, nameKey },
};
