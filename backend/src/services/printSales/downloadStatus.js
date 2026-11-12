'use strict';
const { randomUUID } = require('crypto');
const { AppError, ConflictError, NotFoundError } = require('../../utils/errors');
const V = require('../albumProducts/validation');
const after = ms => new Date(Date.now() + ms).toISOString();
const context = (orderId, admin, kind) => ({ order_id: orderId, admin_id: admin.id, kind });

function createService(db) {
  async function read(id, orderId, admin, kind) {
    const row = await db('print_sales_downloads').where({ id: V.uuid(id), ...context(orderId, admin, kind) }).first();
    if (!row) throw new NotFoundError('Download status');
    if (new Date(row.expires_at).getTime() <= Date.now()) return { id: row.id, status: 'failed', error: 'Download status expired. Check your browser downloads before trying again.' };
    return { id: row.id, status: row.status, error: row.error };
  }
  async function create(orderId, admin, kind) {
    const id = randomUUID();
    await db('print_sales_downloads').insert({ id, ...context(orderId, admin, kind), status: 'pending', expires_at: after(60000) });
    return { id, status: 'pending' };
  }
  async function start(id, orderId, admin, kind) {
    const changed = await db('print_sales_downloads').where({ id: V.uuid(id), ...context(orderId, admin, kind), status: 'pending' })
      .where('expires_at', '>', new Date().toISOString()).update({ status: 'preparing', expires_at: after(60 * 60e3) });
    if (!changed) throw new ConflictError('This download attempt ended. Start another download from the order.');
  }
  async function update(id, status, error = null) {
    if (!id) return;
    // Keep unexpected internals out of the status API, as on the normal route.
    const message = error ? (error instanceof AppError ? error.message : 'The file could not be downloaded. Try again or contact the studio administrator.') : null;
    await db('print_sales_downloads').where({ id }).whereNotIn('status', ['complete', 'failed'])
      .update({ status, error: message?.slice(0, 300) || null });
  }
  async function cleanup() { await db('print_sales_downloads').where('expires_at', '<=', new Date().toISOString()).del(); }
  return { create, read, start, update, cleanup };
}
module.exports = { createService };
