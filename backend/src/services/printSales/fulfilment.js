'use strict';
const V = require('../albumProducts/validation');
const { parse } = require('./profiles');
const { invoiceIdentity, verified } = require('./orders');
const { AppError, ConflictError, NotFoundError } = require('../../utils/errors');
const now = () => new Date().toISOString();
function createService({ db, storage }) {
  async function order(id, admin) {
    const row = await db('print_sales_orders').where({ id: V.uuid(id) }).first();
    if (!row || (admin.roleName !== 'super_admin' && Number(row.created_by_admin_id) !== Number(admin.id)))
      throw new NotFoundError('Print order');
    return row;
  }
  async function settled(tx, row) {
    const invoice = row.invoice_id && await tx('invoices').where({ id: row.invoice_id }).forUpdate().first();
    if (!invoice || invoice.status !== 'paid' || Number(invoice.paid_amount_minor) < Number(invoice.total_amount_minor) ||
        await invoiceIdentity(tx, invoice) !== row.invoice_hash)
      throw new ConflictError('The exact order invoice must be fully settled; check native billing');
    if (!row.contact || V.hash(parse(row.contact)) !== parse(row.snapshot).contactHash)
      throw new ConflictError('Confirmed delivery details are unavailable');
  }
  async function files(row) {
    if (row.render_status !== 'ready' || !row.artwork_version || row.purged_at)
      throw new ConflictError('Production files are not ready');
    const assets = await db('print_sales_assets').where({ order_id: row.id, claim: row.claim }).orderBy('id');
    if (!assets.some(a => a.kind === 'pack') || !assets.some(a => a.kind === 'sheet') ||
        V.hash(assets.map(a => ({ id: a.id, sha256: a.sha256, size: a.size }))) !== row.artwork_version)
      throw new ConflictError('Production file identity changed');
    for (const asset of assets) await verified(storage, asset);
    return assets;
  }
  async function action(id, admin, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('Choose a fulfilment action', 400);
    const row = await order(id, admin);
    if (input.action === 'retry') {
      const changed = await db('print_sales_orders').where({ id, status: 'accepted', render_status: 'failed' })
        .update({ render_status: 'queued', attempts: 0, error: null, reviewed_version: null, reviewed_at: null });
      if (!changed) throw new ConflictError('Only failed accepted preparation can be retried');
      return;
    }
    if (input.action === 'cancel') return db.transaction(async tx => {
      const current = await tx('print_sales_orders').where({ id }).forUpdate().first();
      if (current.submitted_at) throw new ConflictError('An order already submitted to a lab needs manual resolution');
      const invoice = current.invoice_id && await tx('invoices').where({ id: current.invoice_id }).forUpdate().first();
      if (invoice && invoice.status !== 'cancelled') throw new ConflictError('Cancel/correct the invoice in native billing first');
      let ancestors = invoice ? [invoice.id] : [], seen = new Set(ancestors);
      while (ancestors.length) {
        const replacements = await tx('invoices').whereIn('replaces_invoice_id', ancestors);
        if (replacements.some(i => i.status !== 'cancelled')) throw new ConflictError('Correct the live replacement invoice before cancelling this order');
        ancestors = replacements.map(i => i.id).filter(id => !seen.has(id));
        for (const id of ancestors) seen.add(id);
        if (seen.size > 1000) throw new ConflictError('Invoice corrections require manual review');
      }
      await tx('print_sales_orders').where({ id }).update({ status: 'cancelled', render_status: 'cancelled', closed_at: now(),
        ...(!current.accepted_at ? { contact: null, purge_requested: true } : {}) });
    });
    if (input.artworkVersion !== row.artwork_version) throw new ConflictError('Review the current production files');
    await files(row);
    return db.transaction(async tx => {
      const current = await tx('print_sales_orders').where({ id }).forUpdate().first();
      if (current.artwork_version !== input.artworkVersion || current.render_status !== 'ready' || current.status === 'cancelled')
        throw new ConflictError('The order changed; reload before continuing');
      await settled(tx, current);
      let update;
      if (input.action === 'review') {
        if (current.submitted_at) throw new ConflictError('This order was already submitted');
        update = { reviewed_version: current.artwork_version, reviewed_at: now(), reviewed_by: admin.id };
      } else if (input.action === 'submit') {
        if (current.reviewed_version !== current.artwork_version) throw new ConflictError('Check the exact production files before lab submission');
        const ref = V.text(input.supplierReference, 200, true);
        if (current.submitted_at) {
          if (current.supplier_reference === ref) return;
          throw new ConflictError('A lab submission is already recorded');
        }
        update = { submitted_at: now(), supplier_reference: ref };
      } else if (input.action === 'dispatch') {
        if (!current.submitted_at) throw new ConflictError('Record lab submission before dispatch');
        const tracking = V.text(input.tracking ?? '', 500);
        if (current.dispatched_at) {
          if (current.tracking === tracking) return;
          throw new ConflictError('Dispatch was already recorded');
        }
        update = { dispatched_at: now(), closed_at: now(), tracking, status: 'dispatched' };
      } else throw new ConflictError('Unknown fulfilment action');
      await tx('print_sales_orders').where({ id }).update(update);
      await require('../../database/db').logActivity(`print_order_${input.action}`, { orderId: id, artworkVersion: current.artwork_version },
        current.event_id, { type: 'admin', id: admin.id }, tx);
    });
  }
  async function download(id, admin, kind) {
    const row = await order(id, admin);
    await db.transaction(tx => settled(tx, row));
    const assets = await files(row), asset = assets.find(a => a.kind === kind);
    if (!asset || !['pack', 'sheet'].includes(kind)) throw new NotFoundError('Supplier file');
    return verified(storage, asset);
  }
  /** Terminal artwork expires separately from native accounting records. Active orders are held. */
  async function cleanup() {
    const old = new Date(Date.now() - 90 * 86400e3).toISOString(), day = new Date(Date.now() - 86400e3).toISOString();
    await db('print_sales_orders').whereIn('status', ['quoted', 'capturing', 'failed']).where('expires_at', '<', day)
      .update({ status: 'expired', render_status: 'cancelled', contact: null });
    const rows = await db('print_sales_orders').whereNull('purged_at').where(q => q
      .where(w => w.whereIn('status', ['expired', 'failed']).where(x => x.where('expires_at', '<', day).orWhere('purge_requested', true)))
      .orWhere(w => w.whereIn('status', ['dispatched', 'cancelled']).where(x => x
        .where('closed_at', '<', old).orWhere('purge_requested', true)))).limit(20);
    for (const row of rows) {
      const assets = await db('print_sales_assets').where({ order_id: row.id });
      let complete = true;
      for (const a of assets) {
        try {
          await storage.delete(a.storage_key);
          await db('print_sales_assets').where({ id: a.id }).del();
        } catch (error) {
          // Keep the asset row for retry; one storage fault must not hold every other order.
          complete = false;
          require('../../utils/logger').error('Print asset cleanup failed', { orderId: row.id, assetId: a.id, error: error.message });
        }
      }
      if (complete) await db('print_sales_orders').where({ id: row.id }).update({ purged_at: now(), contact: null });
    }
  }
  return { order, settled, files, action, download, cleanup };
}

/** Called inside native customer erasure; ongoing orders must be explicitly resolved first. */
async function eraseCustomer(tx, customerId) {
  if (!await tx.schema.hasTable('print_sales_orders')) return;
  const rows = await tx('print_sales_orders').where({ customer_account_id: customerId }).forUpdate();
  if (rows.some(o => o.accepted_at && !['cancelled', 'dispatched'].includes(o.status)))
    throw new ConflictError('Resolve active print orders before erasing this customer');
  for (const row of rows) await tx('print_sales_orders').where({ id: row.id }).update({
    contact: null, purge_requested: true,
    ...(!row.accepted_at ? { status: 'expired', render_status: 'cancelled' } : {}),
  });
}
module.exports = { createService, eraseCustomer };
