'use strict';
const crypto = require('crypto');
const V = require('../albumProducts/validation');
const P = require('./profiles');
const D = require('./domain');
const { AppError, ConflictError, NotFoundError, ForbiddenError } = require('../../utils/errors');
const { livePhotos, wherePhotoProcessed, isPhotoHiddenFromViewer } = require('../../utils/photoVisibility');
const { assertGalleryAvailable, isTrue } = require('../../utils/galleryLifecycle');
const work = require('../activeApplicationWork');
const { formatBoolean } = require('../../utils/dbCompat');
const { MAX_SOURCE_BYTES, MAX_ORDER_SOURCE_BYTES, MAX_IMAGE_BYTES, MAX_ORDER_ARTWORK_BYTES, MAX_PACK_BYTES, MAX_SHEET_BYTES,
  QUOTE_TTL_MS, preparationBudget, budgetOf } = require('./limits');
const { isManagedOriginalKey, resolvePhotoStorageKey } = require('../photoResolver');
const now = () => new Date().toISOString();
const fingerprint = p => V.hash({ id: p.id, path: p.path, sha: p.content_sha256 || null, filename: p.original_filename });
const ACTIVE = ['capturing', 'quoted', 'accepted'];

async function read(storage, key, max = MAX_SOURCE_BYTES, options) {
  options?.signal?.throwIfAborted();
  const stream = await storage.get(key, options), chunks = [];
  const abort = () => stream.destroy(options.signal.reason);
  options?.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => stream.destroy(new AppError('Order file read timed out', 504)), 60000);
  timer.unref();
  let size = 0;
  try {
    options?.signal?.throwIfAborted();
    for await (const chunk of stream) {
      timer.refresh(); size += chunk.length;
      if (size > max) throw new AppError('Image exceeds the print source limit', 400);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally { clearTimeout(timer); options?.signal?.removeEventListener('abort', abort); stream.destroy(); }
}

/** Byte identity is checked on every administrative release, not just object size. */
async function verified(storage, asset, options) {
  const bytes = await read(storage, asset.storage_key, Math.max(asset.size, 1), options);
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
  /** Not on tx: the permission lookup uses the global connection. */
  async function billingOwner(event) {
    const admin = await db('admin_users').where({ id: event.print_sales_admin_id, is_active: formatBoolean(true) }).first();
    if (!admin || !await require('../../middleware/permissions').userHasAllPermissions(admin.id, ['bills.manage', 'customers.edit']))
      throw new ForbiddenError('The studio billing owner is unavailable');
    return admin;
  }
  async function photo(tx, eventId, id, accessLevel) {
    const p = await wherePhotoProcessed(livePhotos(tx)).where({ id, event_id: eventId }).first();
    if (!p || isPhotoHiddenFromViewer(p, accessLevel) || p.media_type === 'video' || p.mime_type?.startsWith('video/'))
      throw new NotFoundError('Photograph');
    return p;
  }
  async function asset(orderId, kind, bytes, claim = null, extension = 'bin', options = {}) {
    options.signal?.throwIfAborted();
    const id = crypto.randomUUID(), key = `.print-sales/${orderId}/${id}.${extension}`;
    const contentType = { jpg: 'image/jpeg', png: 'image/png', tif: 'image/tiff', pdf: 'application/pdf', zip: 'application/zip' }[extension] || 'application/octet-stream';
    const expectedClaim = options.expectedClaim || claim;
    const check = row => {
      options.signal?.throwIfAborted();
      if (!row || row.purged_at || !ACTIVE.includes(row.status) || (!row.accepted_at && new Date(row.expires_at).getTime() <= Date.now()) ||
          (expectedClaim && (row.claim !== expectedClaim || row.render_status !== 'running' || !row.contact)))
        throw new ConflictError('This preparation is no longer active');
    };
    const maxBytes = options.maxBytes || ({ source: MAX_SOURCE_BYTES, artwork: MAX_IMAGE_BYTES, pack: MAX_PACK_BYTES, sheet: MAX_SHEET_BYTES }[kind]);
    const reservedBytes = Buffer.isBuffer(bytes) ? bytes.length : maxBytes;
    if (!maxBytes || reservedBytes > maxBytes) throw Object.assign(new AppError('Choose fewer or smaller prints for one order', 400), { code: 'PRINT_SIZE_LIMIT' });
    // Track an upload before touching storage. A crash leaves a reclaimable,
    // budgeted staging row, never an untracked completed multipart object.
    await db.transaction(async tx => {
      await tx('print_sales_settings').where({ id: 1 }).forUpdate().first();
      const row = await tx('print_sales_orders').where({ id: orderId }).forUpdate().first(); check(row);
      const budget = budgetOf(P.parse(row.snapshot));
      const used = await tx('print_sales_assets').where({ order_id: orderId }).sum({ bytes: 'size' }).first();
      if (Number(used?.bytes || 0) + reservedBytes > budget.totalBytes)
        throw Object.assign(new AppError('Choose fewer or smaller prints for one order', 400), { code: 'PRINT_SIZE_LIMIT' });
      await tx('print_sales_assets').insert({ id, order_id: orderId, storage_key: key,
        sha256: '', size: reservedBytes, kind: 'staging', claim: expectedClaim || null, created_at: now() });
    });
    try {
      const identity = await require('./files').upload(storage, key, bytes, maxBytes, { contentType, cacheControl: 'private, no-store', signal: options.signal });
      const row = { id, order_id: orderId, storage_key: key, ...identity, kind, claim, created_at: now() };
      await db.transaction(async tx => {
        await tx('print_sales_settings').where({ id: 1 }).forUpdate().first();
        check(await tx('print_sales_orders').where({ id: orderId }).forUpdate().first());
        if (!await tx('print_sales_assets').where({ id, kind: 'staging' }).update({ ...identity, kind, claim }))
          throw new ConflictError('This preparation is no longer active');
      });
      return row;
    } catch (error) {
      try { await storage.delete(key); await db('print_sales_assets').where({ id }).del(); }
      catch { /* Keep the staging row for retryable cleanup. */ }
      throw error;
    }
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
          artwork: i.profile.artwork, background: i.profile.manufacturing.background ?? '#ffffff', manufacturing: i.profile.manufacturing, unitPriceMinor: i.unitPriceMinor })) }) };
  }
  /** The lab reference is the studio's own bookkeeping, not the buyer's. */
  function customerShape(row) {
    const { supplierReference, ...rest } = shape(row);
    return rest;
  }
  async function owned(id, customerId, eventId) {
    const row = await db('print_sales_orders').where({ id: V.uuid(id), customer_account_id: customerId, event_id: eventId }).first();
    if (!row) throw new NotFoundError('Print order');
    return row;
  }
  async function offers(eventId, customerId) {
    await billingOwner((await buyer(db, eventId, customerId)).event);
    const config = await P.settings(db), variants = [];
    for (const p of config.profiles.filter(p => p.definition.enabled)) {
      try {
        const plan = await D.plan(db, [{ profileId: p.definition.id, photoId: 1, quantity: 1,
          crop: { x: 0, y: 0, width: 1, height: 1 }, fit: p.definition.manufacturing.fitModes[0] }], { includeDelivery: false });
        const item = plan.items[0];
        variants.push({ id: p.definition.id, version: item.profile.version, selection: item.profile.selection,
          artwork: item.profile.artwork, trimMm: item.profile.manufacturing.trimMm, bleedMm: item.profile.manufacturing.bleedMm,
          fitModes: item.profile.manufacturing.fitModes,
          background: item.profile.manufacturing.background ?? '#ffffff', currency: plan.currency, unitPriceMinor: item.unitPriceMinor });
      } catch (error) {
        if (![400, 409].includes(error.statusCode)) throw error;
        // Stale or incomplete manufacturing configurations are withdrawn.
        require('../../utils/logger').warn('Print variant withdrawn from offers', { profileId: p.definition.id, error: error.message });
      }
    }
    return { variants, countries: config.countries, policy: config.policy, basketScope: V.hash({ eventId, customerId }) };
  }
  async function progress(row) {
    const snapshot = P.parse(row.snapshot), items = snapshot?.items || [], sources = new Set(items.map(i => i.photoId)).size;
    const assets = await db('print_sales_assets').where({ order_id: row.id });
    const sourceIds = new Set(items.map(i => i.source.assetId).filter(Boolean));
    const captured = assets.filter(a => a.kind === 'source' && sourceIds.has(a.id)).length;
    const rendered = assets.filter(a => a.kind === 'artwork' && a.claim === row.claim).length;
    const packaged = assets.filter(a => ['sheet', 'pack'].includes(a.kind) && a.claim === row.claim).length;
    const expired = !row.accepted_at && new Date(row.expires_at).getTime() <= Date.now();
    const total = sources + items.length + 2, ready = !expired && row.render_status === 'ready' && ['quoted', 'accepted'].includes(row.status);
    const stage = expired || ['expired', 'cancelled'].includes(row.status) ? 'expired' : row.status === 'failed' || row.render_status === 'failed' ? 'failed'
      : ready ? 'ready' : row.render_status !== 'running' ? 'queued'
        : captured < sources ? 'capturing' : rendered < items.length ? 'rendering' : 'packaging';
    const completed = Math.min(total, captured + rendered + packaged);
    return { ...customerShape(row), preparation: { stage, completed, total,
      percent: ready ? 100 : Math.min(99, Math.floor(completed * 100 / total)) } };
  }
  async function status(eventId, customerId, id) {
    await buyer(db, eventId, customerId);
    return progress(await owned(id, customerId, eventId));
  }
  async function discard(eventId, customerId, id) {
    await buyer(db, eventId, customerId);
    await db.transaction(async tx => {
      await tx('print_sales_settings').where({ id: 1 }).forUpdate().first();
      const row = await tx('print_sales_orders').where({ id: V.uuid(id), event_id: eventId, customer_account_id: customerId }).forUpdate().first();
      if (!row) throw new NotFoundError('Print order');
      if (row.accepted_at) throw new ConflictError('This order is already confirmed; reload its status');
      await tx('print_sales_orders').where({ id }).update({ status: 'expired', render_status: 'cancelled', contact: null,
        purge_requested: formatBoolean(true) });
    });
    return progress(await owned(id, customerId, eventId));
  }
  async function quote(eventId, customerId, accessLevel, input) {
    V.uuid(input?.requestId);
    const { event, customer } = await buyer(db, eventId, customerId);
    await billingOwner(event);
    const requestHash = V.hash({ cart: input.items, delivery: input.delivery });
    const existing = await db('print_sales_orders').where({ id: input.requestId }).first();
    if (existing) {
      if (existing.customer_account_id !== customerId || existing.event_id !== eventId || existing.request_hash !== requestHash)
        throw new ConflictError('This request identifier was already used');
      if (!existing.accepted_at && (!['capturing', 'quoted'].includes(existing.status) || !(new Date(existing.expires_at).getTime() > Date.now())))
        throw new ConflictError('The quotation expired; review a new quotation');
      return progress(existing);
    }
    const destination = D.delivery(input.delivery, (await P.settings(db)).countries),
      plan = await D.plan(db, input.items, { country: destination.country });
    const rawBytes = item => item.profile.manufacturing.output.format === 'tiff' && item.profile.manufacturing.output.compression === 'none'
      ? item.profile.artwork.widthPx * item.profile.artwork.heightPx * 3 : 0;
    if (plan.items.some(item => rawBytes(item) > MAX_IMAGE_BYTES) || plan.items.reduce((sum, item) => sum + rawBytes(item), 0) > MAX_ORDER_ARTWORK_BYTES)
      throw new AppError('Uncompressed TIFF artwork exceeds the order limit; choose fewer or smaller prints', 400);
    const sources = new Map(); let sourceBytes = 0;
    // Record the version, without transferring original image bytes in the request.
    for (const item of plan.items) {
      if (!sources.has(item.photoId)) {
        const p = await photo(db, eventId, item.photoId, accessLevel), key = resolvePhotoStorageKey(event, p);
        if (!key || !isManagedOriginalKey(key)) throw new AppError('Print ordering currently requires managed originals', 400);
        const stat = await storage.stat(key);
        if (!stat || !Number.isSafeInteger(stat.size) || stat.size < 1 || stat.size > MAX_SOURCE_BYTES)
          throw new AppError('Original is missing or too large for print ordering', 400);
        sourceBytes += stat.size;
        if (sourceBytes > MAX_ORDER_SOURCE_BYTES) throw new AppError('Choose fewer photographs per order', 400);
        sources.set(item.photoId, { pending: { key, size: stat.size, mtime: String(stat.mtime),
          etag: stat.etag ?? null, versionId: stat.versionId ?? null, contentHash: p.content_sha256 || null },
        fingerprint: fingerprint(p), filename: p.source_filename || p.original_filename || p.filename });
      }
      item.source = sources.get(item.photoId);
    }
    const contact = { delivery: destination, buyerEmail: customer.email, buyerName: customer.display_name };
    const cart = plan.items.map(i => ({ profileId: i.profile.id, photoId: i.photoId, quantity: i.quantity, crop: i.crop, fit: i.fit }));
    const snapshot = { ...plan, contactHash: V.hash(contact), cart, consentVersion: 'photo-selection-v1',
      preparationBudget: preparationBudget(plan.items, sourceBytes) };
    const serial = JSON.stringify(snapshot), id = input.requestId;
    await db.transaction(async tx => {
      await tx('customer_accounts').where({ id: customerId }).forUpdate().first();
      await tx('events').where({ id: eventId }).forUpdate().first();
      const current = await buyer(tx, eventId, customerId);
      if (current.event.print_sales_admin_id !== event.print_sales_admin_id) throw new ConflictError('The studio billing owner changed');
      await tx('print_sales_settings').where({ id: 1 }).forUpdate().first();
      if (await tx('print_sales_orders').where({ id }).first()) throw new ConflictError('This quotation request is already being prepared; retry shortly');
      await tx('print_sales_orders').where({ event_id: eventId, customer_account_id: customerId }).whereNull('accepted_at')
        .whereIn('status', ['capturing', 'quoted']).update({ status: 'expired', render_status: 'cancelled', contact: null, purge_requested: formatBoolean(true) });
      await require('./capacity').admit(tx, customerId, snapshot.preparationBudget.totalBytes);
      const pending = await tx('print_sales_orders').whereIn('status', ['capturing', 'quoted']);
      const open = await tx('print_sales_orders').where({ status: 'accepted' }).select('customer_account_id', 'created_by_admin_id');
      if (open.filter(o => Number(o.created_by_admin_id) === Number(event.print_sales_admin_id)).length >= 100 ||
          open.filter(o => o.customer_account_id === customerId).length >= 10)
        throw new ConflictError('Resolve existing studio orders before placing another order');
      if (pending.length >= 20 || pending.filter(o => o.customer_account_id === customerId).length >= 2)
        throw new ConflictError('Finish or wait for an existing quotation before creating another');
      await tx('print_sales_orders').insert({ id, request_hash: requestHash, event_id: eventId,
        customer_account_id: customerId, created_by_admin_id: event.print_sales_admin_id,
        status: 'capturing', render_status: 'queued', snapshot: serial, snapshot_hash: V.hash(serial), contact: JSON.stringify(contact),
        created_at: now(), expires_at: deadline(current.event) });
    });
    return progress(await owned(id, customerId, eventId));
  }
  async function capture(row, { signal } = {}) {
    const snapshot = P.parse(row.snapshot), sources = new Map();
    for (const item of snapshot.items) {
      if (!sources.has(item.photoId)) {
        if (!item.source.pending) sources.set(item.photoId, item.source);
        else {
          const p = item.source.pending;
          const matches = stat => stat && stat.size === p.size && String(stat.mtime) === p.mtime &&
            (stat.etag ?? null) === p.etag && (stat.versionId ?? null) === p.versionId;
          if (!matches(await storage.stat(p.key))) throw new ConflictError('An original changed; review the photograph again');
          const bytes = await read(storage, p.key, MAX_SOURCE_BYTES, { ifMatch: p.etag || undefined, versionId: p.versionId || undefined, signal });
          if (bytes.length !== p.size || !matches(await storage.stat(p.key)) || (p.contentHash && p.contentHash !== V.hash(bytes)))
            throw new ConflictError('An original changed; review the photograph again');
          const meta = await sharp(bytes, { signal }).metadata();
          if (!['jpeg', 'png', 'webp', 'tiff'].includes(meta.format) || !meta.width || !meta.height ||
              meta.width * meta.height > 60e6 || (meta.pages || 1) > 1) throw new AppError('Use a single image up to 60 megapixels', 400);
          const source = { fingerprint: item.source.fingerprint, filename: item.source.filename,
            width: meta.width, height: meta.height, orientation: meta.orientation || 1 };
          for (const print of snapshot.items.filter(i => i.photoId === item.photoId)) D.geometry(source, print);
          const stored = await asset(row.id, 'source', bytes, null, 'bin', { expectedClaim: row.claim, signal });
          sources.set(item.photoId, { ...source, assetId: stored.id, sha256: stored.sha256 });
        }
      }
      item.source = sources.get(item.photoId); item.geometry = D.geometry(item.source, item);
      // Save completed capture incrementally; retries retain these exact originals.
      const serial = JSON.stringify(snapshot);
      const changed = await db('print_sales_orders').where({ id: row.id, status: 'capturing', claim: row.claim, render_status: 'running' })
        .update({ snapshot: serial, snapshot_hash: V.hash(serial) });
      if (!changed) throw new ConflictError('This preparation is no longer active');
    }
    const serial = JSON.stringify(snapshot);
    return { ...row, snapshot: serial, snapshot_hash: V.hash(serial) };
  }
  async function prepared(row) {
    if (row.render_status !== 'ready' || !row.claim || !row.artwork_version || row.purged_at)
      throw new ConflictError('Wait until the production files are ready before confirming');
    const assets = await db('print_sales_assets').where({ order_id: row.id, claim: row.claim }).orderBy('id');
    if (assets.filter(a => a.kind === 'artwork').length !== P.parse(row.snapshot).items.length ||
        assets.filter(a => a.kind === 'pack').length !== 1 || assets.filter(a => a.kind === 'sheet').length !== 1 ||
        assets.some(a => a.kind === 'staging') || V.hash(assets.map(a => ({ id: a.id, sha256: a.sha256, size: a.size }))) !== row.artwork_version)
      throw new ConflictError('Production file identity changed; review a new quotation');
    const retained = await db('print_sales_assets').where({ order_id: row.id });
    if (retained.some(a => a.kind === 'staging')) throw new ConflictError('An earlier upload still needs cleanup; review a new quotation');
    for (const a of retained) {
      const stat = await storage.stat(a.storage_key);
      if (!stat || stat.size !== a.size) throw new ConflictError('A prepared file is missing; review a new quotation');
    }
  }
  async function accept(eventId, customerId, accessLevel, id, input) {
    const { event } = await buyer(db, eventId, customerId), row = await owned(id, customerId, eventId);
    if (input?.snapshotHash !== row.snapshot_hash || input?.acknowledgeSelection !== true)
      throw new AppError('Confirm the displayed photo selections, prices and policy', 400);
    if (row.accepted_at) return customerShape(row);
    if (!['capturing', 'quoted'].includes(row.status) || new Date(row.expires_at).getTime() <= Date.now())
      throw new ConflictError('The quotation expired; review a new quotation');
    await prepared(row);
    const policy = require('../../database/crmAccess');
    const admin = await billingOwner(event);
    const actor = await policy.loadCrmActor({ id: admin.id });
    const { hasColumnCached } = require('../../utils/schemaCache');
    await hasColumnCached('invoices', 'vat_code'); await hasColumnCached('invoices', 'project_id');
    return policy.withCrmActor(actor, () => db.transaction(async tx => {
      await tx('customer_accounts').where({ id: customerId }).forUpdate().first();
      await tx('events').where({ id: eventId }).forUpdate().first();
      await tx('album_product_catalogue').where({ id: 1 }).forUpdate().first();
      await tx('print_sales_settings').where({ id: 1 }).forUpdate().first();
      const current = await tx('print_sales_orders').where({ id }).forUpdate().first();
      if (current.accepted_at) return customerShape(current);
      if (current.status !== 'quoted' || !(new Date(current.expires_at).getTime() > Date.now()))
        throw new ConflictError('The quotation expired; review a new quotation');
      if (current.render_status !== 'ready' || current.claim !== row.claim || current.artwork_version !== row.artwork_version || current.purged_at)
        throw new ConflictError('Production files changed; review a new quotation');
      const { event: currentEvent } = await buyer(tx, eventId, customerId);
      if (current.created_by_admin_id !== currentEvent.print_sales_admin_id || currentEvent.print_sales_admin_id !== admin.id)
        throw new ConflictError('The studio billing owner changed; review a new quotation');
      const open = await tx('print_sales_orders').where({ status: 'accepted' }).select('customer_account_id', 'created_by_admin_id', 'render_status');
      const studio = open.filter(o => Number(o.created_by_admin_id) === Number(admin.id));
      // The render queue is one worker, so that cap stays install-wide.
      if (studio.length >= 100 || open.filter(o => o.customer_account_id === customerId).length >= 10 ||
          open.filter(o => ['queued', 'running'].includes(o.render_status)).length >= 20)
        throw new ConflictError('The studio order queue is full; try again after existing orders are processed');
      const snapshot = P.parse(current.snapshot), contact = P.parse(current.contact);
      if (!contact || V.hash(contact) !== snapshot.contactHash) throw new ConflictError('Confirmed delivery details changed; review a new quotation');
      const next = await D.plan(tx, snapshot.cart, { country: contact.delivery.country });
      if (V.hash(current.snapshot) !== current.snapshot_hash || snapshot.signature !== next.signature)
        throw new ConflictError('The product offer changed; review a new quotation');
      for (const item of snapshot.items) {
        const p = await photo(tx, eventId, item.photoId, accessLevel);
        if (fingerprint(p) !== item.source.fingerprint) throw new ConflictError('A selected photograph changed; review a new quotation');
        const source = await tx('print_sales_assets').where({ id: item.source.assetId, order_id: id, kind: 'source' }).first();
        if (!source) throw new ConflictError('Retained original is missing');
      }
      const created = await require('../invoiceService').createInvoice({
        customerAccountId: customerId, eventId, eventName: currentEvent.event_name,
        projectId: currentEvent.project_id, currency: snapshot.currency, vatCode: snapshot.vatCode,
        vatRate: snapshot.vatRate, lineItems: snapshot.lines, _skipMonthlyRouting: true,
        skontoDisabled: true,
      }, admin.id, tx);
      if (created.invoiceIds.length !== 1) throw new ConflictError('A shop order requires one invoice');
      const invoiceId = created.invoiceIds[0], invoice = await tx('invoices').where({ id: invoiceId }).first();
      if (Number(invoice.total_amount_minor) !== snapshot.totalMinor) throw new ConflictError('Invoice total changed; review the order');
      const invoiceHash = await invoiceIdentity(tx, invoice);
      await tx('print_sales_orders').where({ id, status: 'quoted' }).update({ status: 'accepted', accepted_at: now(),
        invoice_id: invoiceId, invoice_hash: invoiceHash });
      await require('../../database/db').logActivity('print_order_accepted', { orderId: id, invoiceId, eventName: currentEvent.event_name }, eventId,
        { type: 'customer', id: customerId }, tx);
      return customerShape(await tx('print_sales_orders').where({ id }).first());
    }));
  }
  return { buyer, photo, asset, shape, customerShape, owned, offers, progress, status, capture,
    discard: (...args) => work.track('print preparation discard', () => discard(...args)),
    quote: (...args) => work.track('print order admission', () => quote(...args)),
    accept: (...args) => work.track('print order acceptance', () => accept(...args)) };
}

function deadline(event) {
  return new Date(Math.min(Date.now() + QUOTE_TTL_MS, event.expires_at ? new Date(event.expires_at).getTime() : Infinity)).toISOString();
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
module.exports = { createService, application, read, verified, invoiceIdentity, deadline };
