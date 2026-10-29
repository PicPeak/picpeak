'use strict';
const crypto = require('crypto');
const V = require('../albumProducts/validation');
const P = require('./profiles');
const D = require('./domain');
const { AppError, ConflictError, NotFoundError, ForbiddenError } = require('../../utils/errors');
const { livePhotos, wherePhotoProcessed, isPhotoHiddenFromViewer } = require('../../utils/photoVisibility');
const { assertGalleryAvailable, isTrue } = require('../../utils/galleryLifecycle');
const work = require('../activeApplicationWork');
const now = () => new Date().toISOString();
const fingerprint = p => V.hash({ id: p.id, path: p.path, sha: p.content_sha256 || null, filename: p.original_filename });
const MAX_SOURCE_BYTES = 50 * 1024 * 1024;

async function read(storage, key, max = MAX_SOURCE_BYTES, options) {
  const stream = await storage.get(key, options), chunks = [];
  const timer = setTimeout(() => stream.destroy(new AppError('Order file read timed out', 504)), 60000);
  timer.unref();
  let size = 0;
  try {
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > max) throw new AppError('Image exceeds the print source limit', 400);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally { clearTimeout(timer); stream.destroy(); }
}

/** Byte identity is checked on every administrative release, not just object size. */
async function verified(storage, asset) {
  const bytes = await read(storage, asset.storage_key, Math.max(asset.size, 1));
  if (bytes.length !== asset.size || V.hash(bytes) !== asset.sha256)
    throw new ConflictError('An order file changed; hold the order for review');
  return bytes;
}

function createService({ db, storage, sharp }) {
  async function buyer(tx, eventId, customerId) {
    const event = await tx('events').where({ id: eventId }).first();
    assertGalleryAvailable(event);
    if (!isTrue(event.print_sales_enabled) || !event.print_sales_admin_id) throw new ForbiddenError('The print shop is closed');
    for (const key of ['printSales', 'albumProducts', 'bills'])
      if (!isTrue((await tx('feature_flags').where({ key }).first())?.value)) throw new ForbiddenError('Print ordering is disabled');
    const assigned = await tx('event_customer_assignments').where({ event_id: eventId, customer_account_id: customerId }).first();
    const customer = assigned && await tx('customer_accounts').where({ id: customerId }).first();
    if (!customer || !isTrue(customer.is_active) || !customer.email) throw new ForbiddenError('An assigned active customer account is required');
    require('../invoice/helpers').ensureCustomerCanBill(customer);
    return { event, customer };
  }
  async function photo(tx, eventId, id, accessLevel) {
    const p = await wherePhotoProcessed(livePhotos(tx)).where({ id, event_id: eventId }).first();
    if (!p || isPhotoHiddenFromViewer(p, accessLevel) || p.media_type === 'video' || p.mime_type?.startsWith('video/'))
      throw new NotFoundError('Photograph');
    return p;
  }
  async function asset(orderId, kind, bytes, claim = null, extension = 'bin') {
    const id = crypto.randomUUID(), key = `.print-sales/${orderId}/${id}.${extension}`;
    await storage.put(key, bytes, { contentType: extension === 'jpg' ? 'image/jpeg' : 'application/octet-stream', cacheControl: 'private, no-store' });
    const row = { id, order_id: orderId, storage_key: key, sha256: V.hash(bytes), size: bytes.length, kind, claim, created_at: now() };
    try { await db('print_sales_assets').insert(row); }
    catch (error) { await storage.delete(key).catch(() => {}); throw error; }
    return row;
  }
  function shape(row) {
    const s = P.parse(row.snapshot), contact = P.parse(row.contact);
    return { id: row.id, status: row.status, renderStatus: row.render_status,
      invoiceId: row.invoice_id, acceptedAt: row.accepted_at, expiresAt: row.expires_at,
      snapshotHash: row.snapshot_hash, artworkVersion: row.artwork_version,
      reviewedAt: row.reviewed_at, submittedAt: row.submitted_at, dispatchedAt: row.dispatched_at,
      supplierReference: row.supplier_reference, tracking: row.tracking,
      needsAttention: !!row.error, purgedAt: row.purged_at,
      ...(s && { currency: s.currency, totalMinor: s.totalMinor, netMinor: s.netMinor, vatMinor: s.vatMinor,
        delivery: contact?.delivery, policy: s.policy, buyerEmail: contact?.buyerEmail,
        items: s.items.map(i => ({ photoId: i.photoId, filename: i.source.filename, quantity: i.quantity,
          crop: i.crop, fit: i.fit, profileId: i.profile.id, selection: i.profile.selection,
          artwork: i.profile.artwork, manufacturing: i.profile.manufacturing, unitPriceMinor: i.unitPriceMinor })) }) };
  }
  async function owned(id, customerId, eventId) {
    const row = await db('print_sales_orders').where({ id: V.uuid(id), customer_account_id: customerId, event_id: eventId }).first();
    if (!row) throw new NotFoundError('Print order');
    return row;
  }
  async function offers(eventId, customerId) {
    await buyer(db, eventId, customerId);
    const config = await P.settings(db), variants = [];
    for (const p of config.profiles.filter(p => p.definition.enabled)) {
      try {
        const plan = await D.plan(db, [{ profileId: p.definition.id, photoId: 1, quantity: 1,
          crop: { x: 0, y: 0, width: 1, height: 1 }, fit: p.definition.manufacturing.fitModes[0] }]);
        const item = plan.items[0];
        variants.push({ id: p.definition.id, version: item.profile.version, selection: item.profile.selection,
          artwork: item.profile.artwork, fitModes: item.profile.manufacturing.fitModes,
          currency: plan.currency, unitPriceMinor: item.unitPriceMinor });
      } catch (error) {
        if (![400, 409].includes(error.statusCode)) throw error;
        // Stale or incomplete manufacturing configurations are withdrawn.
      }
    }
    return { variants, countries: config.countries, policy: config.policy, basketScope: V.hash({ eventId, customerId }) };
  }
  async function quote(eventId, customerId, accessLevel, input) {
    V.uuid(input.requestId);
    const { event, customer } = await buyer(db, eventId, customerId);
    const requestHash = V.hash({ cart: input.items, delivery: input.delivery });
    const existing = await db('print_sales_orders').where({ id: input.requestId }).first();
    if (existing) {
      if (existing.customer_account_id !== customerId || existing.event_id !== eventId || existing.request_hash !== requestHash)
        throw new ConflictError('This request identifier was already used');
      if (existing.status === 'capturing') throw new ConflictError('This quotation is still being prepared');
      return shape(existing);
    }
    const plan = await D.plan(db, input.items), destination = D.delivery(input.delivery, plan.countries);
    const id = input.requestId;
    await db.transaction(async tx => {
      // Match customer erasure and native gallery deletion before taking order
      // locks. This also prevents an erasure racing admission from reintroducing
      // the old contact after the account has been anonymised.
      await tx('customer_accounts').where({ id: customerId }).forUpdate().first();
      await tx('events').where({ id: eventId }).forUpdate().first();
      await buyer(tx, eventId, customerId);
      // Global admission lock bounds retained originals even across API replicas.
      await tx('print_sales_settings').where({ id: 1 }).forUpdate().first();
      if (await tx('print_sales_orders').where({ id }).first())
        throw new ConflictError('This quotation request is already being prepared; retry shortly');
      const pending = await tx('print_sales_orders').whereIn('status', ['capturing', 'quoted']).where('expires_at', '>', now());
      const open = await tx('print_sales_orders').where({ status: 'accepted' }).select('customer_account_id');
      if (open.length >= 100 || open.filter(o => o.customer_account_id === customerId).length >= 10)
        throw new ConflictError('Resolve existing studio orders before placing another order');
      if (pending.length >= 20 || pending.filter(o => o.status === 'capturing').length >= 2 ||
          pending.filter(o => o.customer_account_id === customerId).length >= 2)
        throw new ConflictError('Finish or wait for an existing quotation before creating another');
      await tx('print_sales_orders').insert({ id, request_hash: requestHash, event_id: eventId,
        customer_account_id: customerId, created_by_admin_id: event.print_sales_admin_id,
        status: 'capturing', created_at: now(), expires_at: new Date(Date.now() + 30 * 60e3).toISOString() });
    });
    try {
      const sources = new Map(); let totalBytes = 0;
      for (const item of plan.items) {
        if (!sources.has(item.photoId)) {
          const p = await photo(db, eventId, item.photoId, accessLevel);
          const key = require('../photoResolver').resolvePhotoStorageKey(event, p);
          if (!key) throw new AppError('Print ordering currently requires managed originals', 400);
          const stat = await storage.stat(key);
          if (!stat || stat.size > MAX_SOURCE_BYTES) throw new AppError('Original is missing or too large for print ordering', 400);
          const bytes = await read(storage, key, MAX_SOURCE_BYTES, { ifMatch: stat.etag, versionId: stat.versionId });
          totalBytes += bytes.length;
          if (totalBytes > 200 * 1024 * 1024) throw new AppError('Choose fewer photographs per order', 400);
          const after = await storage.stat(key);
          if (!after || after.size !== stat.size || String(after.mtime) !== String(stat.mtime) || after.etag !== stat.etag)
            throw new ConflictError('An original changed; review the photograph again');
          if (p.content_sha256 && p.content_sha256 !== V.hash(bytes)) throw new ConflictError('Original content does not match its recorded version');
          const meta = await sharp(bytes).metadata();
          if (!['jpeg', 'png', 'webp', 'tiff'].includes(meta.format) || !meta.width || !meta.height ||
              meta.width * meta.height > 60e6 || (meta.pages || 1) > 1) throw new AppError('Use a single image up to 60 megapixels', 400);
          const stored = await asset(id, 'source', bytes);
          sources.set(item.photoId, { assetId: stored.id, sha256: stored.sha256, fingerprint: fingerprint(p),
            filename: p.source_filename || p.original_filename || p.filename, width: meta.width, height: meta.height,
            orientation: meta.orientation || 1 });
        }
        item.source = sources.get(item.photoId);
        item.geometry = D.geometry(item.source, item);
      }
      const contact = { delivery: destination, buyerEmail: customer.email, buyerName: customer.display_name };
      const cart = plan.items.map(i => ({ profileId: i.profile.id, photoId: i.photoId, quantity: i.quantity, crop: i.crop, fit: i.fit }));
      const snapshot = { ...plan, contactHash: V.hash(contact), cart, consentVersion: 'photo-selection-v1' };
      const serial = JSON.stringify(snapshot), snapshotHash = V.hash(serial);
      const changed = await db('print_sales_orders').where({ id, status: 'capturing' })
        .update({ status: 'quoted', snapshot: serial, snapshot_hash: snapshotHash, contact: JSON.stringify(contact) });
      if (!changed) throw new ConflictError('The quotation expired during preparation');
      return shape(await owned(id, customerId, eventId));
    } catch (error) {
      await db('print_sales_orders').where({ id, status: 'capturing' }).update({ status: 'failed', error: 'Source preparation failed' });
      throw error;
    }
  }
  async function accept(eventId, customerId, accessLevel, id, input) {
    const { event } = await buyer(db, eventId, customerId), row = await owned(id, customerId, eventId);
    if (input.snapshotHash !== row.snapshot_hash || input.acknowledgeSelection !== true)
      throw new AppError('Confirm the displayed photo selections, prices and policy', 400);
    if (row.accepted_at) return shape(row);
    const policy = require('../../database/crmAccess');
    const admin = await db('admin_users').where({ id: event.print_sales_admin_id, is_active: true }).first();
    if (!admin || !await require('../../middleware/permissions').userHasAllPermissions(admin.id, ['bills.manage', 'customers.edit']))
      throw new ForbiddenError('The studio billing owner is unavailable');
    const actor = await policy.loadCrmActor({ id: admin.id });
    const { hasColumnCached } = require('../../utils/schemaCache');
    await hasColumnCached('invoices', 'vat_code'); await hasColumnCached('invoices', 'project_id');
    return policy.withCrmActor(actor, () => db.transaction(async tx => {
      await tx('customer_accounts').where({ id: customerId }).forUpdate().first();
      await tx('events').where({ id: eventId }).forUpdate().first();
      await tx('album_product_catalogue').where({ id: 1 }).forUpdate().first();
      await tx('print_sales_settings').where({ id: 1 }).forUpdate().first();
      const current = await tx('print_sales_orders').where({ id }).forUpdate().first();
      if (current.accepted_at) return shape(current);
      if (current.status !== 'quoted' || new Date(current.expires_at).getTime() <= Date.now())
        throw new ConflictError('The quotation expired; review a new quotation');
      if (current.created_by_admin_id !== event.print_sales_admin_id)
        throw new ConflictError('The studio billing owner changed; review a new quotation');
      const open = await tx('print_sales_orders').where({ status: 'accepted' }).select('customer_account_id', 'render_status');
      if (open.length >= 100 || open.filter(o => o.customer_account_id === customerId).length >= 10 ||
          open.filter(o => ['queued', 'running'].includes(o.render_status)).length >= 20)
        throw new ConflictError('The studio order queue is full; try again after existing orders are processed');
      await buyer(tx, eventId, customerId);
      const snapshot = P.parse(current.snapshot), next = await D.plan(tx, snapshot.cart);
      if (V.hash(current.snapshot) !== current.snapshot_hash || snapshot.signature !== next.signature)
        throw new ConflictError('The product offer changed; review a new quotation');
      for (const item of snapshot.items) {
        const p = await photo(tx, eventId, item.photoId, accessLevel);
        if (fingerprint(p) !== item.source.fingerprint) throw new ConflictError('A selected photograph changed; review a new quotation');
        const source = await tx('print_sales_assets').where({ id: item.source.assetId, order_id: id, kind: 'source' }).first();
        if (!source || !await storage.stat(source.storage_key)) throw new ConflictError('Retained original is missing');
      }
      const created = await require('../invoiceService').createInvoice({
        customerAccountId: customerId, eventId, eventName: event.event_name,
        projectId: event.project_id, currency: snapshot.currency, vatCode: snapshot.vatCode,
        vatRate: snapshot.vatRate, lineItems: snapshot.lines, _skipMonthlyRouting: true,
        skontoDisabled: true,
      }, admin.id, tx);
      if (created.invoiceIds.length !== 1) throw new ConflictError('A shop order requires one invoice');
      const invoiceId = created.invoiceIds[0], invoice = await tx('invoices').where({ id: invoiceId }).first();
      if (Number(invoice.total_amount_minor) !== snapshot.totalMinor) throw new ConflictError('Invoice total changed; review the order');
      const invoiceHash = await invoiceIdentity(tx, invoice);
      await tx('print_sales_orders').where({ id, status: 'quoted' }).update({ status: 'accepted', accepted_at: now(),
        invoice_id: invoiceId, invoice_hash: invoiceHash, render_status: 'queued' });
      await require('../../database/db').logActivity('print_order_accepted', { orderId: id, invoiceId }, eventId,
        { type: 'customer', id: customerId }, tx);
      return shape(await tx('print_sales_orders').where({ id }).first());
    }));
  }
  return { buyer, photo, asset, shape, owned, offers,
    quote: (...args) => work.track('print order source capture', () => quote(...args)),
    accept: (...args) => work.track('print order acceptance', () => accept(...args)) };
}

async function invoiceIdentity(tx, invoice) {
  const lines = await tx('invoice_line_items').where({ invoice_id: invoice.id }).orderBy('position');
  return V.hash({ customer: Number(invoice.customer_account_id), currency: invoice.currency,
    net: Number(invoice.net_amount_minor), total: Number(invoice.total_amount_minor),
    vat: Number(invoice.vat_amount_minor), vatCode: invoice.vat_code, shipping: Number(invoice.shipping_amount_minor),
    lines: lines.map(l => ({ position: l.position, description: l.description, quantity: Number(l.quantity),
      unit: Number(l.unit_price_minor), total: Number(l.line_total_minor), discount: Number(l.discount_percent),
      configuration: l.configuration_snapshot, details: l.details_text })) });
}
function application() {
  return createService({ db: require('../../database/db').db,
    storage: require('../storage').getStorage(), sharp: require('../isolatedSharp') });
}
module.exports = { createService, application, read, verified, invoiceIdentity };
