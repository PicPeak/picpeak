/**
 * Expense categories (migration 124).
 *
 * Seeded colored labels that classify "eigener Aufwand" expenses and feed
 * the future Erfolgsrechnung. Seed rows can be renamed/recolored but not
 * deleted (they back the reporting chart of accounts).
 */
const { db } = require('../database/db');
const { AppError } = require('../utils/errors');

async function list() {
  return db('expense_categories')
    .orderBy('display_order', 'asc')
    .orderBy('name', 'asc');
}

async function getById(id) {
  const row = await db('expense_categories').where({ id }).first();
  if (!row) throw new AppError('Expense category not found', 404, 'CATEGORY_NOT_FOUND');
  return row;
}

async function create({ name, color, displayOrder }, adminId) {
  if (!name || !String(name).trim()) {
    throw new AppError('Category name is required', 400, 'NAME_REQUIRED');
  }
  const now = new Date();
  const row = {
    name: String(name).trim(),
    color: color || null,
    is_seed: false,
    display_order: Number.isInteger(displayOrder) ? displayOrder : 0,
    created_at: now,
    updated_at: now,
  };
  const inserted = await db('expense_categories').insert(row).returning('id');
  const id = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];
  return getById(id);
}

async function update(id, { name, color, displayOrder }) {
  const existing = await getById(id);
  const patch = { updated_at: new Date() };
  if (name !== undefined) {
    if (!String(name).trim()) throw new AppError('Category name is required', 400, 'NAME_REQUIRED');
    patch.name = String(name).trim();
  }
  if (color !== undefined) patch.color = color || null;
  if (displayOrder !== undefined && Number.isInteger(displayOrder)) patch.display_order = displayOrder;
  await db('expense_categories').where({ id: existing.id }).update(patch);
  return getById(id);
}

async function remove(id) {
  const existing = await getById(id);
  if (existing.is_seed) {
    throw new AppError('Seed categories cannot be deleted', 409, 'SEED_CATEGORY_PROTECTED');
  }
  // FK on expenses.category_id is ON DELETE SET NULL — orphaned expenses keep working.
  await db('expense_categories').where({ id: existing.id }).del();
  return { deleted: true };
}

module.exports = { list, getById, create, update, remove };
