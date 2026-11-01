'use strict';
const V = require('../albumProducts/validation');
const { parse } = require('./profiles');
const { invoiceIdentity } = require('./orders');
const { verify, withVerifiedFile } = require('./files');
const { AppError, ConflictError, NotFoundError } = require('../../utils/errors');
const { formatBoolean } = require('../../utils/dbCompat');
const now = () => new Date().toISOString();
const log = (...args) => require('../../database/db').logActivity(...args);
const SWEEP_SIZE = 20;
// Rows that keep failing must not hold the sweep, so each pass resumes after the last.
let sweepAfter = '';
function createService({ db, storage }) {
  async function order(id, admin) {
    const row = await db('print_sales_orders').where({ id: V.uuid(id) }).first();
    if (!row || (admin.roleName !== 'super_admin' && Number(row.created_by_admin_id) !== Number(admin.id)))
      throw new NotFoundError('Print order');
    return row;
  }
  /** A Storno and reissue moves the order to the replacement; identity is still checked against it. */
  async function liveInvoice(tx, id) {
    let invoice = await tx('invoices').where({ id }).forUpdate().first();
    const seen = new Set();
    while (invoice?.status === 'cancelled' && !seen.has(invoice.id)) {
      seen.add(invoice.id);
      const replacements = await tx('invoices').where({ replaces_invoice_id: invoice.id }).forUpdate();
      invoice = replacements.find(i => i.status !== 'cancelled') || replacements[0];
    }
    return invoice;
  }
  /** Every reissue descending from an invoice; a cancelled one can be reissued again, so this branches. */
  async function replacementTree(tx, id) {
    const found = [], seen = new Set([id]);
    let ancestors = [id];
    while (ancestors.length) {
      const replacements = (await tx('invoices').whereIn('replaces_invoice_id', ancestors)).filter(i => !seen.has(i.id));
      found.push(...replacements);
      ancestors = replacements.map(i => i.id);
      for (const id of ancestors) seen.add(id);
      if (seen.size > 1000) throw new ConflictError('Invoice corrections require manual review');
    }
    return found;
  }
  async function settled(tx, row) {
    const invoice = row.invoice_id && await liveInvoice(tx, row.invoice_id);
    // A native reissue copies lines and amounts but not vat_code.
    const vatCode = invoice?.vat_code ?? (await tx('invoices').where({ id: row.invoice_id }).first())?.vat_code;
    if (!invoice || invoice.status !== 'paid' || Number(invoice.paid_amount_minor) < Number(invoice.total_amount_minor) ||
        await invoiceIdentity(tx, { ...invoice, vat_code: vatCode }) !== row.invoice_hash)
      throw new ConflictError('The exact order invoice must be fully settled; check native billing');
    if (!row.contact || V.hash(parse(row.contact)) !== parse(row.snapshot).contactHash)
      throw new ConflictError('Confirmed delivery details are unavailable');
  }
  async function files(row, options) {
    if (row.render_status !== 'ready' || !row.artwork_version || row.purged_at)
      throw new ConflictError('Production files are not ready');
    const assets = await db('print_sales_assets').where({ order_id: row.id, claim: row.claim }).orderBy('id');
    if (!assets.some(a => a.kind === 'pack') || !assets.some(a => a.kind === 'sheet') ||
        V.hash(assets.map(a => ({ id: a.id, sha256: a.sha256, size: a.size }))) !== row.artwork_version)
      throw new ConflictError('Production file identity changed');
    for (const asset of assets) await verify(storage, asset, options);
    return assets;
  }
  async function action(id, admin, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('Choose a fulfilment action', 400);
    const row = await order(id, admin);
    if (input.action === 'retry') {
      const changed = await db('print_sales_orders').where({ id, status: 'accepted', render_status: 'failed' })
        .update({ render_status: 'queued', attempts: 0, error: null, reviewed_version: null, reviewed_at: null });
      if (!changed) throw new ConflictError('Only failed accepted preparation can be retried');
      await log('print_order_retry', { orderId: id }, row.event_id, { type: 'admin', id: admin.id });
      return;
    }
    // The way out for an order the invoice no longer matches: submitted to the
    // lab, or reissued with different lines, so cancel and dispatch both refuse.
    if (input.action === 'resolve') return db.transaction(async tx => {
      const current = await tx('print_sales_orders').where({ id }).forUpdate().first();
      if (current.status !== 'accepted') throw new ConflictError('Only an open order can be closed manually');
      const invoice = current.invoice_id && await tx('invoices').where({ id: current.invoice_id }).forUpdate().first();
      if (invoice?.status !== 'cancelled') throw new ConflictError('Cancel/correct the invoice in native billing first');
      // Closing may drop a reissue with different lines, but never one the buyer
      // is still being asked to pay. A paid one is the studio's to refund, so its
      // state goes on the record.
      const replacements = (await replacementTree(tx, invoice.id)).filter(i => i.status !== 'cancelled');
      if (replacements.some(i => i.status !== 'paid' || Number(i.paid_amount_minor) < Number(i.total_amount_minor)))
        throw new ConflictError('Settle or cancel the replacement invoice before closing this order');
      const note = V.text(input.note, 500, true);
      await tx('print_sales_orders').where({ id }).update({ status: 'resolved', render_status: 'cancelled', closed_at: now() });
      await log('print_order_resolve', { orderId: id, note, replacements: replacements.map(i => ({ id: i.id, status: i.status })) },
        current.event_id, { type: 'admin', id: admin.id }, tx);
    });
    if (input.action === 'cancel') return db.transaction(async tx => {
      const current = await tx('print_sales_orders').where({ id }).forUpdate().first();
      if (['expired', 'cancelled', 'dispatched', 'resolved'].includes(current.status)) throw new ConflictError('This order is already closed');
      if (current.submitted_at) throw new ConflictError('An order already submitted to a lab needs manual resolution');
      const invoice = current.invoice_id && await tx('invoices').where({ id: current.invoice_id }).forUpdate().first();
      if (invoice && invoice.status !== 'cancelled') throw new ConflictError('Cancel/correct the invoice in native billing first');
      if (invoice && (await replacementTree(tx, invoice.id)).some(i => i.status !== 'cancelled'))
        throw new ConflictError('Correct the live replacement invoice before cancelling this order');
      await tx('print_sales_orders').where({ id }).update({ status: 'cancelled', render_status: 'cancelled', closed_at: now(),
        ...(!current.accepted_at ? { contact: null, purge_requested: formatBoolean(true) } : {}) });
      await log('print_order_cancel', { orderId: id }, current.event_id, { type: 'admin', id: admin.id }, tx);
    });
    if (input.artworkVersion !== row.artwork_version) throw new ConflictError('Review the current production files');
    await files(row);
    return db.transaction(async tx => {
      const current = await tx('print_sales_orders').where({ id }).forUpdate().first();
      if (current.artwork_version !== input.artworkVersion || current.render_status !== 'ready' || ['cancelled', 'resolved'].includes(current.status))
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
      await log(`print_order_${input.action}`, { orderId: id, artworkVersion: current.artwork_version },
        current.event_id, { type: 'admin', id: admin.id }, tx);
    });
  }
  async function download(id, admin, kind, consume, options) {
    if (!['pack', 'sheet'].includes(kind)) throw new NotFoundError('Supplier file');
    const row = await order(id, admin);
    await db.transaction(tx => settled(tx, row));
    const asset = (await files(row, options)).find(a => a.kind === kind);
    if (!asset) throw new NotFoundError('Supplier file');
    return withVerifiedFile(storage, asset, async (stream, size) => {
      // Verification can take time for a large pack. A cancellation, erasure or
      // invoice correction during it must still stop the browser's release.
      const current = await order(id, admin);
      if (current.claim !== row.claim || current.artwork_version !== row.artwork_version ||
          current.render_status !== 'ready' || current.purged_at)
        throw new ConflictError('The order changed; reload before downloading');
      await db.transaction(tx => settled(tx, current));
      return consume(stream, size);
    }, options);
  }
  /** Terminal artwork expires separately from native accounting records. Active orders are held. */
  async function cleanup() {
    const old = new Date(Date.now() - 90 * 86400e3).toISOString(), day = new Date(Date.now() - 86400e3).toISOString();
    await db('print_sales_orders').whereIn('status', ['quoted', 'capturing', 'failed']).where('expires_at', '<', day)
      .update({ status: 'expired', render_status: 'cancelled', contact: null });
    const rows = await db('print_sales_orders').whereNull('purged_at').where(q => q
      .where(w => w.whereIn('status', ['expired', 'failed']).where(x => x.where('expires_at', '<', day).orWhere('purge_requested', formatBoolean(true))))
      .orWhere(w => w.whereIn('status', ['dispatched', 'cancelled', 'resolved']).where(x => x
        .where('closed_at', '<', old).orWhere('purge_requested', formatBoolean(true)))))
      .where('id', '>', sweepAfter).orderBy('id').limit(SWEEP_SIZE);
    sweepAfter = rows.length === SWEEP_SIZE ? rows[rows.length - 1].id : '';
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
  if (rows.some(o => o.accepted_at && !['cancelled', 'dispatched', 'resolved'].includes(o.status)))
    throw new ConflictError('Resolve active print orders before erasing this customer');
  for (const row of rows) await tx('print_sales_orders').where({ id: row.id }).update({
    contact: null, purge_requested: formatBoolean(true),
    ...(!row.accepted_at ? { status: 'expired', render_status: 'cancelled' } : {}),
  });
}
module.exports = { createService, eraseCustomer };
