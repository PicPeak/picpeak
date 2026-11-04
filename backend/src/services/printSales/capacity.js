'use strict';
const { budgetOf, MAX_PENDING_BYTES, MAX_CUSTOMER_PENDING_BYTES } = require('./limits');
const { ConflictError } = require('../../utils/errors');

/** Caller holds the settings admission lock; include failed/in-flight uploads. */
async function admit(tx, customerId, requestedBytes) {
  const sizes = await tx('print_sales_assets as a').join('print_sales_orders as o', 'o.id', 'a.order_id')
    .whereNull('o.accepted_at').select('a.order_id', 'o.customer_account_id')
    .sum({ bytes: 'a.size' }).groupBy('a.order_id', 'o.customer_account_id');
  const reservations = new Map(sizes.map(row => [row.order_id, { customerId: Number(row.customer_account_id), bytes: Number(row.bytes) }]));
  const pending = await tx('print_sales_orders').whereNull('accepted_at').whereIn('status', ['capturing', 'quoted'])
    .select('id', 'customer_account_id', 'snapshot', 'render_status');
  for (const row of pending) {
    let snapshot;
    try { snapshot = typeof row.snapshot === 'string' ? JSON.parse(row.snapshot) : row.snapshot; } catch { /* Reserve conservatively until cleanup. */ }
    reservations.set(row.id, { customerId: Number(row.customer_account_id),
      bytes: row.render_status === 'ready' ? reservations.get(row.id)?.bytes || 0
        : Math.max(reservations.get(row.id)?.bytes || 0, budgetOf(snapshot).totalBytes) });
  }
  let total = requestedBytes, own = requestedBytes;
  for (const reservation of reservations.values()) {
    total += reservation.bytes;
    if (reservation.customerId === Number(customerId)) own += reservation.bytes;
  }
  if (total > MAX_PENDING_BYTES || own > MAX_CUSTOMER_PENDING_BYTES)
    throw new ConflictError('Print preparation storage is busy; wait for an earlier basket to finish or be cleared, then try again');
}
module.exports = { admit };
