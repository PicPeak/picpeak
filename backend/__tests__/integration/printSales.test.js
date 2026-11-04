'use strict';
const crypto = require('crypto');
const sharp = require('sharp');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp } = require('./helpers/crmDb');
const P = require('../../src/services/printSales/profiles');
const V = require('../../src/services/albumProducts/validation');
const G = require('../../src/services/albumProducts/library');
const uuid = () => crypto.randomUUID();
const { isTrue } = require('../../src/utils/galleryLifecycle');
let db, cleanup, storage, orders, fulfilment, worker, admin, customerId, event, photoId, config, definition, product,
  sourceBytes, adminApp, customerApp, galleryApp, adminToken;
beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  const seeded = await seedMinimal(db); customerId = seeded.customerId;
  await assignAdminRole(db, seeded.adminId);
  admin = { id: seeded.adminId, roleName: 'super_admin' }; adminToken = mintAdminToken(admin.id);
  const Local = require('../../src/services/storage/LocalFsStorage');
  storage = new Local({ root: process.env.STORAGE_PATH }); await storage.init();
  require('../../src/services/storage').setStorageForTesting(storage);
  orders = require('../../src/services/printSales/orders').createService({ db, storage, sharp });
  fulfilment = require('../../src/services/printSales/fulfilment').createService({ db, storage });
  worker = require('../../src/services/printSales/worker').createWorker({ db, storage, sharp, orders });
  adminApp = buildRouteApp('/api/admin/print-sales', require('../../src/routes/adminPrintSales'));
  customerApp = buildRouteApp('/api/admin/customers', require('../../src/routes/adminCustomers'));
  galleryApp = buildRouteApp('/api/gallery', require('../../src/routes/gallery/printSales'));
  galleryApp.set('trust proxy', 'loopback');
  sourceBytes = await sharp({ create: { width: 400, height: 600, channels: 3, background: '#3578a2' } }).jpeg().toBuffer();
}, 180000);
afterAll(async () => { if (cleanup) await cleanup(); });
beforeEach(async () => {
  await db('print_sales_assets').del(); await db('print_sales_orders').del();
  for (const key of ['printSales', 'albumProducts', 'bills', 'customerPortal'])
    await db('feature_flags').insert({ key, value: true }).onConflict('key').merge({ value: true });
  require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
  const group = { id: uuid(), name: 'Size', kind: 'size', options: [{ id: uuid(), name: 'Nominal photo', width: 3, height: 4, unit: 'cm', active: true }] };
  const type = { id: uuid(), name: 'Photo print', active: true, attributes: [{ id: uuid(), name: 'Size', groupId: group.id,
    optionIds: group.options.map(o => o.id), required: true, multiple: false, dependsOn: [] }] };
  product = { id: uuid(), name: 'Rectangular print', active: true, typeId: type.id };
  await db('album_product_catalogue').where({ id: 1 }).update({ revision: 1, products: JSON.stringify([product]),
    library: JSON.stringify(G.cleanLibrary([group])), types: JSON.stringify(G.cleanTypes([type], G.cleanLibrary([group]))) });
  const cat = await P.catalogue(db), resolved = G.resolve(product, cat);
  const vat = await db('vat_codes').where({ direction: 'output', active: true }).where('rate', '>', 0).first();
  const preset = await require('../../src/services/quoteService').createLineItemPreset({ name: 'Photographic print', currency: 'EUR',
    price_mode: 'fixed', unit_price_minor: 250, product_id: product.id, vat_code: vat.code });
  definition = { id: uuid(), revision: 1, enabled: true, labReference: 'Synthetic studio profile',
    selection: { productId: product.id, productVersion: resolved.version, values: { [type.attributes[0].id]: [group.options[0].id] } },
    manufacturing: { capability: 'single-photo-rectangle', trimMm: { width: 25.4, height: 38.1 },
      bleedMm: { top: 0, right: 0, bottom: 0, left: 0 }, safeInsetMm: { top: 0, right: 0, bottom: 0, left: 0 },
      resolution: { targetDpi: 100, minimumDpi: 72 }, output: { format: 'jpeg', colourSpace: 'srgb' }, fitModes: ['cover', 'contain'] } };
  config = await P.save(db, { revision: (await P.settings(db)).revision, profiles: [{ definition, cataloguePresetId: preset.id }],
    countries: ['IE', 'DE'], policy: 'Synthetic buyer selection policy and delivery information.', shippingPresetId: null });
  const slug = `prints-${uuid()}`;
  const inserted = await db('events').insert({ slug, event_name: 'Synthetic gallery', event_type: 'wedding', event_date: '2026-10-28',
    host_email: 'client@example.com', admin_email: 'studio@example.com', password_hash: 'x',
    share_link: `/gallery/${slug}`, share_token: uuid(), created_by: admin.id, is_active: true,
    print_sales_enabled: true, print_sales_admin_id: admin.id }).returning('id');
  event = await db('events').where({ id: inserted[0]?.id ?? inserted[0] }).first();
  await db('event_customer_assignments').insert({ event_id: event.id, customer_account_id: customerId });
  const path = `${slug}/individual/source.jpg`;
  await storage.put(`events/active/${path}`, sourceBytes);
  const ids = await db('photos').insert({ event_id: event.id, filename: 'source.jpg', original_filename: 'camera.jpg', path,
    type: 'individual', content_sha256: V.hash(sourceBytes), width: 400, height: 600 }).returning('id');
  photoId = ids[0]?.id ?? ids[0];
});
// Fixtures are tiny; production downloads consume a verified stream directly.
async function download(id, actor, kind) {
  return fulfilment.download(id, actor, kind, async stream => {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
  });
}
const payload = () => ({ requestId: uuid(), items: [{ profileId: definition.id, photoId, quantity: 2,
  crop: { x: 0, y: 0, width: 1, height: 1 }, fit: 'cover' }],
delivery: { country: 'IE', name: 'Synthetic Buyer', line1: '1 Test Lane', city: 'Dublin', postalCode: 'D01 TEST' } });
async function quoted(input = payload()) {
  const q = await orders.quote(event.id, customerId, 'client', input);
  if (q.renderStatus === 'queued') await worker.runOne();
  const ready = await orders.status(event.id, customerId, q.id);
  if (ready.status === 'failed') throw new Error('Preparation failed before confirmation');
  return ready;
}
async function accepted({ repairQueue = false } = {}) {
  const q = await quoted();
  const result = await orders.accept(event.id, customerId, 'client', q.id, { snapshotHash: q.snapshotHash, acknowledgeSelection: true });
  if (repairQueue) {
    const pack = await db('print_sales_assets').where({ order_id: q.id, kind: 'pack' }).first();
    await storage.put(pack.storage_key, Buffer.alloc(pack.size));
    await fulfilment.action(q.id, admin, { action: 'repair' });
  }
  return result;
}
async function pay(order, amount = order.totalMinor) {
  return require('../../src/services/invoiceService').markPaid(order.invoiceId, { amountMinor: amount, paymentMethod: 'bank_transfer' }, admin.id);
}
function galleryToken(extra = {}) {
  return jwt.sign({ type: 'gallery', eventId: event.id, eventSlug: event.slug, accessLevel: 'guest',
    via: 'customer', customerId, jti: uuid(), ...extra }, process.env.JWT_SECRET, { expiresIn: '1h', issuer: 'picpeak-auth' });
}
test('settings use optimistic revision and automatically version manufacturing edits', async () => {
  await expect(P.save(db, { ...config, revision: config.revision - 1 })).rejects.toThrow('changed');
  config.profiles[0].definition.manufacturing.trimMm.width = 26;
  const changed = await P.save(db, config);
  expect(changed.profiles[0].definition.revision).toBe(2);
  expect((await P.catalogue(db)).products[0].id).toBe(product.id);
});
test('duplicate enabled variants are rejected, and stale variants may be withdrawn', async () => {
  config.profiles.push({ ...config.profiles[0], definition: { ...definition, id: uuid() } });
  await expect(P.save(db, config)).rejects.toThrow('same product choices');
  config.profiles.pop(); await db('album_product_catalogue').where({ id: 1 }).update({ products: '[]' });
  config.profiles[0].definition.enabled = false;
  await expect(P.save(db, config)).resolves.toMatchObject({ profiles: [{ definition: { enabled: false } }] });
});
test('captures exact sources, freezes native prices and creates one product-only invoice on duplicate acceptance', async () => {
  const q = await quoted(), input = { snapshotHash: q.snapshotHash, acknowledgeSelection: true };
  const [a, b] = await Promise.all([orders.accept(event.id, customerId, 'client', q.id, input), orders.accept(event.id, customerId, 'client', q.id, input)]);
  expect(a.invoiceId).toBe(b.invoiceId);
  const lines = await db('invoice_line_items').where({ invoice_id: a.invoiceId });
  expect(lines).toHaveLength(1); expect(Number(lines[0].quantity)).toBe(2); expect(Number(lines[0].unit_price_minor)).toBe(250);
  expect(Number((await db('invoices').where({ id: a.invoiceId }).first()).total_amount_minor)).toBe(q.totalMinor);
  const row = await db('print_sales_orders').where({ id: q.id }).first();
  expect(P.parse(row.snapshot).items[0].source.sha256).toBe(V.hash(sourceBytes));
  await expect(db('print_sales_orders').where({ id: q.id }).update({ snapshot: '{}' })).rejects.toThrow('immutable');
});
test('quote replay is scoped to buyer, gallery and request content', async () => {
  const input = payload(), q = await quoted(input);
  expect((await quoted(input)).id).toBe(q.id);
  input.items[0].quantity++;
  await expect(quoted(input)).rejects.toThrow('already used');
});
test('refuses an unacknowledged or expired quotation', async () => {
  const q = await quoted();
  await expect(orders.accept(event.id, customerId, 'client', q.id, { snapshotHash: q.snapshotHash })).rejects.toThrow('Confirm');
  await db('print_sales_orders').where({ id: q.id }).update({ expires_at: '2020-01-01T00:00:00Z' });
  await expect(orders.accept(event.id, customerId, 'client', q.id, { snapshotHash: q.snapshotHash, acknowledgeSelection: true })).rejects.toThrow('expired');
});
test('catalogue pricing changes require a new quotation', async () => {
  const q = await quoted();
  await db('quote_line_item_presets').where({ id: config.profiles[0].cataloguePresetId }).update({ unit_price_minor: 251 });
  await expect(orders.accept(event.id, customerId, 'client', q.id, { snapshotHash: q.snapshotHash, acknowledgeSelection: true })).rejects.toThrow('offer changed');
});
test('replacement or revoked visibility before acceptance requires a new selection', async () => {
  const q = await quoted();
  await db('photos').where({ id: photoId }).update({ path: 'replacement/other.jpg' });
  await expect(orders.accept(event.id, customerId, 'client', q.id, { snapshotHash: q.snapshotHash, acknowledgeSelection: true })).rejects.toThrow('photograph changed');
});
test.each(['hidden', 'trashed', 'moderated', 'unprocessed'])('refuses unavailable %s photographs', async kind => {
  const updates = { hidden: { visibility: 'hidden' }, trashed: { deleted_at: new Date().toISOString() },
    moderated: { moderation_status: 'pending' }, unprocessed: { processing_status: 'pending' } }[kind];
  await db('photos').where({ id: photoId }).update(updates);
  await expect(orders.quote(event.id, customerId, 'guest', payload())).rejects.toThrow();
});
test('refuses mismatched crops and insufficient effective resolution before invoicing', async () => {
  for (const crop of [{ x: 0, y: 0, width: .5, height: 1 }, { x: 0, y: 0, width: .1, height: .1 }]) {
    const input = payload(); input.items[0].crop = crop;
    const q = await orders.quote(event.id, customerId, 'client', input);
    await worker.runOne();
    expect(await orders.status(event.id, customerId, q.id)).toMatchObject({ status: 'failed', invoiceId: null, preparation: { stage: 'failed' } });
  }
});
test('retained sources survive gallery deletion and produce sRGB artwork plus neutral pack', async () => {
  const a = await accepted();
  await require('../../src/routes/adminEvents/helpers').deleteEventCascade(event.id, { ...admin, username: 'Synthetic admin' });
  await storage.delete(`events/active/${event.slug}/individual/source.jpg`);
  expect(await worker.runOne()).toBe(false);
  const row = await db('print_sales_orders').where({ id: a.id }).first();
  expect(row.render_status).toBe('ready');
  const image = await db('print_sales_assets').where({ order_id: a.id, kind: 'artwork', claim: row.claim }).first();
  const meta = await sharp(await require('../../src/services/printSales/orders').verified(storage, image)).metadata();
  expect(meta).toMatchObject({ format: 'jpeg', width: 100, height: 150, density: 100 }); expect(meta.icc).toBeTruthy();
  expect(await db('print_sales_assets').where({ order_id: a.id, kind: 'pack' }).first()).toBeTruthy();
});
test('payment during repair holds files, then manual review/submission/dispatch records exact artwork', async () => {
  const a = await accepted({ repairQueue: true }); await pay(a);
  await expect(download(a.id, admin, 'pack')).rejects.toThrow('not ready');
  await worker.runOne();
  const row = await fulfilment.order(a.id, admin), details = { artworkVersion: row.artwork_version };
  await expect(fulfilment.action(a.id, admin, { ...details, action: 'submit', supplierReference: 'LAB-001' })).rejects.toThrow('Check');
  await fulfilment.action(a.id, admin, { ...details, action: 'review' });
  const pack = await download(a.id, admin, 'pack'); expect(pack.subarray(0, 2).toString()).toBe('PK');
  await fulfilment.action(a.id, admin, { ...details, action: 'submit', supplierReference: 'LAB-001' });
  await fulfilment.action(a.id, admin, { ...details, action: 'dispatch', tracking: 'Test tracking' });
  expect(await fulfilment.order(a.id, admin)).toMatchObject({ status: 'dispatched', supplier_reference: 'LAB-001', tracking: 'Test tracking' });
});
test('rendering before payment and partial payments do not release supplier files', async () => {
  const a = await accepted(); await worker.runOne(); await pay(a, 1);
  await expect(download(a.id, admin, 'pack')).rejects.toThrow('fully settled');
  await pay(a, a.totalMinor - 1);
  await expect(download(a.id, admin, 'pack')).resolves.toBeInstanceOf(Buffer);
});
test('changing a production file holds release even when its byte length is unchanged', async () => {
  const a = await accepted(); await worker.runOne(); await pay(a);
  const file = await db('print_sales_assets').where({ order_id: a.id, kind: 'pack' }).first();
  await storage.put(file.storage_key, Buffer.alloc(file.size));
  await expect(download(a.id, admin, 'pack')).rejects.toThrow('file changed');
});
test('editing the native invoice after acceptance holds fulfilment', async () => {
  const a = await accepted(); await worker.runOne(); await pay(a);
  await require('../../src/services/accountingHistory').auditedUpdate(db, 'invoice_line_items', { invoice_id: a.invoiceId }, { description: 'Changed product' }, { actor: admin.id, source: 'test.invoice.edit' });
  await expect(download(a.id, admin, 'pack')).rejects.toThrow('fully settled');
});
test('repair failure preserves the paid invoice and requires controlled retry after three failures', async () => {
  const a = await accepted({ repairQueue: true }); await pay(a);
  const source = await db('print_sales_assets').where({ order_id: a.id, kind: 'source' }).first();
  await storage.delete(source.storage_key);
  for (let n = 0; n < 3; n++) await worker.runOne();
  expect((await fulfilment.order(a.id, admin)).render_status).toBe('failed');
  expect((await db('invoices').where({ id: a.invoiceId }).first()).status).toBe('paid');
  await storage.put(source.storage_key, sourceBytes);
  await fulfilment.action(a.id, admin, { action: 'repair' });
  expect((await fulfilment.order(a.id, admin)).render_status).toBe('queued');
});
test('backup required-key inventory contains retained order files', async () => {
  const q = await quoted(), keys = await require('../../src/services/recoveryFiles').requiredKeys(db, key => key.startsWith('.print-sales/'));
  expect([...keys].some(key => key.startsWith(`.print-sales/${q.id}/`))).toBe(true);
});
test('customer erasure refuses active orders and withdraws personal details from unaccepted work', async () => {
  const a = await accepted();
  await expect(db.transaction(tx => require('../../src/services/printSales/fulfilment').eraseCustomer(tx, customerId))).rejects.toThrow('active print orders');
  await db('print_sales_orders').where({ id: a.id }).del();
  const q = await quoted();
  await db.transaction(tx => require('../../src/services/printSales/fulfilment').eraseCustomer(tx, customerId));
  expect(await db('print_sales_orders').where({ id: q.id }).first()).toMatchObject({ contact: null, status: 'expired' });
});
test('HTTP permissions deny shared gallery passwords and unassigned customer identities', async () => {
  const root = `/api/gallery/${event.slug}/print-sales`;
  expect((await request(galleryApp).get(root).set('Authorization', `Bearer ${galleryToken({ via: undefined, customerId: undefined })}`)).status).toBe(403);
  expect((await request(galleryApp).get(root).set('Authorization', `Bearer ${galleryToken({ customerId: customerId + 999 })}`)).status).toBeGreaterThanOrEqual(400);
  const response = await request(galleryApp).get(root).set('Authorization', `Bearer ${galleryToken()}`);
  expect(response.status).toBe(200); expect(response.body.variants).toHaveLength(1);
  expect(response.body.variants[0].trimMm).toEqual(definition.manufacturing.trimMm);
  expect(response.body.variants[0].bleedMm).toEqual(definition.manufacturing.bleedMm);
  expect(JSON.stringify(response.body)).not.toContain('storage_key');
});
test('HTTP shop switch is default-off and disabled flags block configuration but preserve admin order reads', async () => {
  const q = await quoted();
  await db('feature_flags').where({ key: 'printSales' }).update({ value: false });
  require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
  expect((await request(adminApp).put('/api/admin/print-sales/settings').set('Authorization', `Bearer ${adminToken}`).send(config)).status).toBe(403);
  const response = await request(adminApp).get(`/api/admin/print-sales/orders/${q.id}`).set('Authorization', `Bearer ${adminToken}`);
  expect(response.status).toBe(200); expect(response.body.id).toBe(q.id);
});
test('a second photo allocation or crop stays on its own native invoice line', async () => {
  const input = payload(); input.items.push({ ...input.items[0], quantity: 3, crop: { x: .25, y: .25, width: .5, height: .5 } });
  const q = await quoted(input), a = await orders.accept(event.id, customerId, 'client', q.id, { snapshotHash: q.snapshotHash, acknowledgeSelection: true });
  const lines = await db('invoice_line_items').where({ invoice_id: a.invoiceId }).orderBy('position');
  expect(lines.map(l => Number(l.quantity))).toEqual([2, 3]);
  expect(P.parse((await fulfilment.order(a.id, admin)).snapshot).items.map(i => i.linePosition)).toEqual([1, 2]);
});
test('monthly customer billing does not absorb a shop order into a running draft', async () => {
  await db('customer_accounts').where({ id: customerId }).update({ billing_cadence: 'monthly' });
  try {
    const a = await accepted(), invoice = await db('invoices').where({ id: a.invoiceId }).first();
    expect(invoice.status).toBe('scheduled'); expect(invoice.is_monthly_draft).not.toBe(true);
  } finally { await db('customer_accounts').where({ id: customerId }).update({ billing_cadence: 'per_event' }); }
});
test('native delivery pricing adds a separate taxed line', async () => {
  const vat = await db('vat_codes').where({ direction: 'output', active: true }).where('rate', '>', 0).first();
  const preset = await require('../../src/services/quoteService').createLineItemPreset({ name: 'Delivery', currency: 'EUR', price_mode: 'fixed', unit_price_minor: 100, vat_code: vat.code });
  await P.save(db, { ...config, shippingPresetId: preset.id });
  const q = await quoted(), a = await orders.accept(event.id, customerId, 'client', q.id, { snapshotHash: q.snapshotHash, acknowledgeSelection: true });
  expect(q.netMinor).toBe(600); expect(q.vatMinor).toBe(Math.round(600 * Number(vat.rate) / 100));
  expect(await db('invoice_line_items').where({ invoice_id: a.invoiceId })).toHaveLength(2);
});
test('independent workers cannot prepare the same order concurrently', async () => {
  const a = await orders.quote(event.id, customerId, 'client', payload());
  const results = await Promise.all([worker.runOne(), worker.runOne()]);
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(await db('print_sales_assets').where({ order_id: a.id, kind: 'pack' })).toHaveLength(1);
});
test('an interrupted older worker cannot publish over a newer attempt', async () => {
  const a = await quoted();
  await db('print_sales_orders').where({ id: a.id }).update({ render_status: 'queued', attempts: 0 }); let entered, unblock;
  const paused = new Promise(resolve => { entered = resolve; }), resume = new Promise(resolve => { unblock = resolve; });
  let once = false;
  const old = require('../../src/services/printSales/worker').createWorker({ db, storage, sharp, orders: { ...orders,
    asset: async (...args) => { if (!once && args[1] === 'artwork') { once = true; entered(); await resume; } return orders.asset(...args); } } });
  const pending = old.runOne(); await paused;
  const older = await fulfilment.order(a.id, admin);
  await db('print_sales_orders').where({ id: a.id }).update({ heartbeat: '2000-01-01T00:00:00Z' });
  try {
    expect(await worker.runOne()).toBe(true);
    const newer = await fulfilment.order(a.id, admin); expect(newer.claim).not.toBe(older.claim);
    unblock(); await pending;
    expect((await fulfilment.order(a.id, admin)).artwork_version).toBe(newer.artwork_version);
    expect((await fulfilment.order(a.id, admin)).render_status).toBe('ready');
  } finally { unblock(); await pending; }
});
test('retention keeps old unpaid/paid accepted orders and prunes only terminal artwork', async () => {
  const a = await accepted();
  await db('print_sales_orders').where({ id: a.id }).update({ created_at: '2000-01-01T00:00:00Z', expires_at: '2000-01-01T00:00:00Z' });
  await fulfilment.cleanup(); expect((await fulfilment.order(a.id, admin)).purged_at).toBeNull();
  await pay(a); await worker.runOne(); await fulfilment.cleanup();
  expect((await fulfilment.order(a.id, admin)).purged_at).toBeNull();
  await db('print_sales_orders').where({ id: a.id }).update({ status: 'dispatched', closed_at: '2000-01-01T00:00:00Z', dispatched_at: '2000-01-01T00:00:00Z' });
  await fulfilment.cleanup(); const row = await fulfilment.order(a.id, admin);
  expect(row.purged_at).toBeTruthy(); expect(row.contact).toBeNull();
  expect(await db('print_sales_assets').where({ order_id: a.id })).toHaveLength(0);
  expect((await db('invoices').where({ id: a.invoiceId }).first()).status).toBe('paid');
});
test('manual cancellation requires native invoice cancellation first', async () => {
  const a = await accepted();
  await expect(fulfilment.action(a.id, admin, { action: 'cancel' })).rejects.toThrow('native billing first');
  await require('../../src/services/invoiceService').cancelInvoice(a.invoiceId, admin.id);
  await fulfilment.action(a.id, admin, { action: 'cancel' });
  expect((await fulfilment.order(a.id, admin)).status).toBe('cancelled');
});
test('a native portable backup includes order-specific originals even without gallery photos', async () => {
  const q = await quoted(), fs = require('fs'), path = require('path');
  const exported = await require('../../src/services/picpeakExportService').createPicpeak({ includePhotos: false });
  const archive = new (require('node-stream-zip').async)({ file: exported.filePath });
  try {
    const files = Object.keys(await archive.entries());
    expect(files.some(k => k.startsWith(`files/.print-sales/${q.id}/`))).toBe(true);
    expect(files.some(k => k.endsWith('print_sales_orders.ndjson'))).toBe(true);
  } finally { await archive.close(); fs.rmSync(path.dirname(exported.filePath), { recursive: true, force: true }); }
});
test('the real isolated renderer embeds sRGB and density while stripping camera metadata', async () => {
  const a = await accepted({ repairQueue: true });
  const isolated = require('../../src/services/isolatedSharp');
  try {
    await require('../../src/services/printSales/worker').createWorker({ db, storage, sharp: isolated, orders }).runOne();
    const row = await fulfilment.order(a.id, admin); expect(row.error).toBeNull(); expect(row.render_status).toBe('ready');
    const file = await db('print_sales_assets').where({ order_id: a.id, kind: 'artwork', claim: row.claim }).first();
    const meta = await sharp(await require('../../src/services/printSales/orders').verified(storage, file)).metadata();
    expect(meta.density).toBe(100); expect(meta.icc).toBeTruthy(); expect(meta.exif).toBeUndefined();
  } finally { await isolated.shutdown(); }
});
test('a full studio queue refuses acceptance before creating a financial obligation', async () => {
  const q = await quoted();
  await db('print_sales_orders').insert(Array.from({ length: 20 }, () => ({ id: uuid(), request_hash: 'fixture',
    customer_account_id: customerId, created_by_admin_id: admin.id, status: 'accepted', render_status: 'queued',
    created_at: new Date().toISOString(), expires_at: new Date().toISOString() })));
  await expect(orders.accept(event.id, customerId, 'client', q.id, { snapshotHash: q.snapshotHash, acknowledgeSelection: true })).rejects.toThrow('queue is full');
  expect((await db('print_sales_orders').where({ id: q.id }).first()).invoice_id).toBeNull();
});
test('settings recover their empty seed after restoring a backup from before this feature', async () => {
  await db('print_sales_settings').del();
  expect(await P.settings(db)).toMatchObject({ revision: 0, profiles: [] });
  expect(await P.save(db, { ...config, revision: 0 })).toMatchObject({ revision: 1 });
});
test('migration rollback refuses to discard retained orders', async () => {
  const q = await quoted();
  await expect(require('../../migrations/core/341_print_sales').down(db)).rejects.toThrow('destructive rollback');
  expect((await orders.owned(q.id, customerId, event.id)).status).toBe('quoted');
});
test.each(['png', 'tiff'])('studio-selected %s artwork and supplier instructions survive later configuration edits', async format => {
  const p = config.profiles[0].definition;
  p.supplierName = 'Studio-selected production partner'; p.instructions = 'Check the trim dimensions.\nUse the recorded stock code.';
  p.labReference = 'STUDIO-OWN-SKU'; p.manufacturing.background = '#102030';
  p.manufacturing.output = { format, colourSpace: 'srgb' };
  config = await P.save(db, config); const a = await accepted();
  p.supplierName = 'Changed future partner'; p.instructions = 'Future orders only';
  p.manufacturing.output = { format: 'jpeg', colourSpace: 'srgb' };
  await P.save(db, { ...config, profiles: [{ ...config.profiles[0], definition: p }] });
  const isolated = require('../../src/services/isolatedSharp');
  try {
    await require('../../src/services/printSales/worker').createWorker({ db, storage, sharp: isolated, orders }).runOne();
    const row = await fulfilment.order(a.id, admin); expect(row.error).toBeNull(); expect(row.render_status).toBe('ready');
    const file = await db('print_sales_assets').where({ order_id: a.id, kind: 'artwork', claim: row.claim }).first();
    expect(file.storage_key.endsWith(format === 'png' ? '.png' : '.tif')).toBe(true);
    const meta = await sharp(await require('../../src/services/printSales/orders').verified(storage, file)).metadata();
    expect(meta).toMatchObject({ format, width: 100, height: 150, density: 100 }); expect(meta.icc).toBeTruthy();
    const frozen = P.parse(row.snapshot).items[0].profile;
    expect(frozen.supplierName).toBe('Studio-selected production partner'); expect(frozen.instructions).toContain('\nUse the recorded stock code.');
    const pack = await db('print_sales_assets').where({ order_id: a.id, kind: 'pack', claim: row.claim }).first();
    const fs = require('fs/promises'), path = require('path'), temporary = path.join(process.env.STORAGE_PATH, `${uuid()}.zip`);
    await fs.writeFile(temporary, await require('../../src/services/printSales/orders').verified(storage, pack));
    const archive = new (require('node-stream-zip').async)({ file: temporary });
    try {
      const manifest = JSON.parse((await archive.entryData('manifest.json')).toString('utf8'));
      expect(manifest.schemaVersion).toBe(2);
      expect(manifest.shipping).toEqual(P.parse(row.snapshot).shipping);
      expect(manifest.items[0].file).toBe(`001.${format === 'png' ? 'png' : 'tif'}`);
      expect(manifest.items[0].profile).toEqual(frozen);
    } finally { await archive.close(); await fs.rm(temporary, { force: true }); }
  } finally { await isolated.shutdown(); }
});
test('studio background handles transparent originals without relying on a supplier-specific convention', async () => {
  const bytes = await sharp({ create: { width: 400, height: 600, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  await storage.put(`events/active/${event.slug}/individual/source.jpg`, bytes);
  await db('photos').where({ id: photoId }).update({ content_sha256: V.hash(bytes) });
  config.profiles[0].definition.manufacturing.output = { format: 'png', colourSpace: 'srgb' };
  config.profiles[0].definition.manufacturing.background = '#102030'; await P.save(db, config);
  const a = await accepted(); await worker.runOne();
  const row = await fulfilment.order(a.id, admin); expect(row.render_status).toBe('ready');
  const file = await db('print_sales_assets').where({ order_id: a.id, kind: 'artwork', claim: row.claim }).first();
  const { data, info } = await sharp(await require('../../src/services/printSales/orders').verified(storage, file)).raw().toBuffer({ resolveWithObject: true });
  expect(info.channels).toBe(3); expect([...data.subarray(0, 3)]).toEqual([16, 32, 48]);
});
test.each(['adobe-rgb-1998', 'display-p3', 'prophoto-rgb'])('the %s ICC identity is frozen and embedded after future settings change', async colourSpace => {
  config.profiles[0].definition.manufacturing.output = { format: 'png', colourSpace };
  config = await P.save(db, config); const a = await accepted();
  const frozen = P.parse((await fulfilment.order(a.id, admin)).snapshot).items[0].profile.manufacturing.output;
  expect(frozen.profileSha256).toMatch(/^[a-f0-9]{64}$/);
  config.profiles[0].definition.manufacturing.output = { format: 'png', colourSpace: 'srgb' }; await P.save(db, config);
  const isolated = require('../../src/services/isolatedSharp');
  try {
    await require('../../src/services/printSales/worker').createWorker({ db, storage, sharp: isolated, orders }).runOne();
    const row = await fulfilment.order(a.id, admin); expect(row.error).toBeNull(); expect(row.render_status).toBe('ready');
    const file = await db('print_sales_assets').where({ order_id: a.id, kind: 'artwork', claim: row.claim }).first();
    const metadata = await sharp(await require('../../src/services/printSales/orders').verified(storage, file)).metadata();
    expect(crypto.createHash('sha256').update(metadata.icc).digest('hex')).toBe(frozen.profileSha256);
    expect(P.parse(row.snapshot).items[0].profile.manufacturing.output).toEqual(frozen);
  } finally { await isolated.shutdown(); }
});
test('country zones use different native delivery prices and freeze the selected zone on the invoice order', async () => {
  const vat = await db('vat_codes').where({ direction: 'output', active: true }).where('rate', '>', 0).first();
  const home = await require('../../src/services/quoteService').createLineItemPreset({ name: 'Studio home delivery', currency: 'EUR', price_mode: 'fixed', unit_price_minor: 100, vat_code: vat.code });
  const other = await require('../../src/services/quoteService').createLineItemPreset({ name: 'Studio other delivery', currency: 'EUR', price_mode: 'fixed', unit_price_minor: 300, vat_code: vat.code });
  config = await P.save(db, { ...config, shippingZones: [
    { id: uuid(), name: 'Home region', countries: ['IE'], cataloguePresetId: home.id },
    { id: uuid(), name: 'Second region', countries: ['DE'], cataloguePresetId: other.id },
  ] });
  const offers = await orders.offers(event.id, customerId); expect(offers.variants).toHaveLength(1);
  expect(offers.countries).toEqual(['DE', 'IE']);
  const homeQuote = await quoted(), input = payload(); input.delivery.country = 'DE'; input.delivery.city = 'Berlin'; input.delivery.postalCode = '10115';
  const otherQuote = await quoted(input); expect(homeQuote.netMinor).toBe(600); expect(otherQuote.netMinor).toBe(800);
  const a = await orders.accept(event.id, customerId, 'client', otherQuote.id, { snapshotHash: otherQuote.snapshotHash, acknowledgeSelection: true });
  expect(P.parse((await fulfilment.order(a.id, admin)).snapshot).shipping).toMatchObject({ country: 'DE', zoneId: config.shippingZones[1].id, cataloguePresetId: other.id });
  const lines = await db('invoice_line_items').where({ invoice_id: a.invoiceId }).orderBy('position');
  expect(Number(lines[1].unit_price_minor)).toBe(300);
});
test('a country without a configured zone is refused without retaining files or creating an invoice', async () => {
  await P.save(db, { ...config, shippingZones: [{ id: uuid(), name: 'Configured destinations', countries: ['DE'], cataloguePresetId: null }] });
  await expect(quoted()).rejects.toThrow('supported delivery country');
  expect(await db('print_sales_orders')).toHaveLength(0); expect(await db('print_sales_assets')).toHaveLength(0);
});
test('changing destination pricing requires a new quotation instead of rewriting the confirmed total', async () => {
  config = await P.save(db, { ...config, shippingZones: [{ id: uuid(), name: 'Configured destinations', countries: ['IE'], cataloguePresetId: null }] });
  const q = await quoted(); await P.save(db, { ...config, shippingZones: [{ ...config.shippingZones[0], name: 'Updated region' }] });
  await expect(orders.accept(event.id, customerId, 'client', q.id, { snapshotHash: q.snapshotHash, acknowledgeSelection: true })).rejects.toThrow('offer changed');
});
test('a configured crop/fit restriction is enforced on the server', async () => {
  config.profiles[0].definition.manufacturing.fitModes = ['contain']; await P.save(db, config);
  await expect(quoted()).rejects.toThrow('crop/fit mode');
});
test('a version-one accepted profile keeps its frozen JPEG requirements after a configuration upgrade', async () => {
  const a = await accepted(); await worker.runOne();
  const original = await fulfilment.order(a.id, admin), old = P.parse(original.snapshot), id = uuid();
  await db('print_sales_orders').insert({ id, request_hash: 'historical-fixture', customer_account_id: customerId,
    status: 'capturing', render_status: 'queued', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60000).toISOString() });
  const source = await orders.asset(id, 'source', sourceBytes);
  for (const item of old.items) {
    item.source.assetId = source.id; const p = item.profile;
    item.profile = { schemaVersion: 1, id: p.id, revision: p.revision, enabled: p.enabled, selection: p.selection,
      manufacturing: { ...p.manufacturing, output: { format: 'jpeg', colourSpace: 'srgb' } }, artwork: p.artwork, labReference: p.labReference };
    delete item.profile.manufacturing.background; item.profile.version = V.hash(item.profile);
  }
  const serialized = JSON.stringify(old);
  await db('print_sales_orders').where({ id }).update({ status: 'accepted', render_status: 'queued', accepted_at: new Date().toISOString(),
    snapshot: serialized, snapshot_hash: V.hash(serialized), contact: original.contact });
  config.profiles[0].definition.manufacturing.output = { format: 'png', colourSpace: 'srgb' }; await P.save(db, config);
  await worker.runOne();
  const row = await db('print_sales_orders').where({ id }).first(); expect(row.render_status).toBe('ready');
  const file = await db('print_sales_assets').where({ order_id: id, kind: 'artwork', claim: row.claim }).first();
  expect((await sharp(await require('../../src/services/printSales/orders').verified(storage, file)).metadata()).format).toBe('jpeg');
  expect(row.snapshot).toBe(serialized);
});

test('refuses a billing-owner change between initial access and the acceptance transaction', async () => {
  const q = await quoted(), policy = require('../../src/database/crmAccess');
  const original = policy.loadCrmActor;
  const ids = await db('admin_users').insert({ username: uuid(), email: `${uuid()}@example.com`, password_hash: 'unused',
    is_active: true, created_at: new Date().toISOString() }).returning('id');
  const replacement = ids[0]?.id ?? ids[0];
  const change = jest.spyOn(policy, 'loadCrmActor').mockImplementationOnce(async options => {
    const actor = await original(options);
    await db('events').where({ id: event.id }).update({ print_sales_admin_id: replacement });
    return actor;
  });
  try {
    await expect(orders.accept(event.id, customerId, 'client', q.id, { snapshotHash: q.snapshotHash, acknowledgeSelection: true }))
      .rejects.toThrow('billing owner changed');
    expect((await db('print_sales_orders').where({ id: q.id }).first()).invoice_id).toBeNull();
  } finally { change.mockRestore(); }
});

test('isolates retention deletion failures, preserves retry records and keeps purging other orders', async () => {
  const a = await quoted(), b = await quoted();
  await db('print_sales_orders').whereIn('id', [a.id, b.id]).update({ expires_at: '2000-01-01T00:00:00Z' });
  const stuck = await db('print_sales_assets').where({ order_id: a.id }).first();
  const original = storage.delete.bind(storage);
  const deletion = jest.spyOn(storage, 'delete').mockImplementation(async key => {
    if (key === stuck.storage_key) throw new Error('Synthetic storage delete failure');
    return original(key);
  });
  try {
    await expect(fulfilment.cleanup()).resolves.toBeUndefined();
    expect((await fulfilment.order(a.id, admin)).purged_at).toBeNull();
    expect(await db('print_sales_assets').where({ id: stuck.id }).first()).toBeTruthy();
    expect((await fulfilment.order(b.id, admin)).purged_at).toBeTruthy();
  } finally { deletion.mockRestore(); }
  await fulfilment.cleanup();
  expect((await fulfilment.order(a.id, admin)).purged_at).toBeTruthy();
});

test.each([null, [], 'invalid'])('invalid photo entries return a validation response without creating an order: %p', async item => {
  const input = payload(); input.items = [item];
  const response = await request(galleryApp).post(`/api/gallery/${event.slug}/print-sales/quotes`)
    .set('Authorization', `Bearer ${galleryToken()}`).send(input);
  expect(response.status).toBe(400);
  expect(await db('print_sales_orders').where({ id: input.requestId }).first()).toBeUndefined();
});

test('accepts multiline buyer policies and normalises line endings before freezing the quotation', async () => {
  const policy = 'Selection terms.\r\nDelivery information.';
  config = await P.save(db, { ...config, policy });
  expect(config.policy).toBe('Selection terms.\nDelivery information.');
  expect((await quoted()).policy).toBe(config.policy);
  await expect(P.save(db, { ...config, policy: 'Invalid\u0000policy' })).rejects.toThrow('Invalid text');
});

test('repairs a partially applied gallery-column migration without changing existing shop configuration', async () => {
  await db.schema.alterTable('events', t => t.dropColumn('print_sales_admin_id'));
  await require('../../migrations/core/341_print_sales').up(db);
  expect(await db.schema.hasColumn('events', 'print_sales_admin_id')).toBe(true);
  expect((await P.settings(db)).policy).toBe(config.policy);
});

test('archived-gallery deletion detaches retained orders and keeps them visible in the studio list', async () => {
  const a = await accepted({ repairQueue: true });
  await db('events').where({ id: event.id }).update({ is_archived: true });
  const app = buildRouteApp('/api/admin/archives', require('../../src/routes/adminArchives'));
  const response = await request(app).delete(`/api/admin/archives/${event.id}`).set('Authorization', `Bearer ${adminToken}`);
  expect(response.status).toBe(200);
  expect((await fulfilment.order(a.id, admin)).event_id).toBeNull();
  const listing = await request(adminApp).get('/api/admin/print-sales/orders').set('Authorization', `Bearer ${adminToken}`);
  expect(listing.status).toBe(200); expect(listing.body.orders.some(o => o.id === a.id)).toBe(true);
  await storage.delete(`events/active/${event.slug}/individual/source.jpg`);
  expect(await worker.runOne()).toBe(true);
  expect((await fulfilment.order(a.id, admin)).render_status).toBe('ready');
});

const authed = req => req.set('Authorization', `Bearer ${adminToken}`);
const paidAndReady = async () => { const a = await accepted(); await pay(a); await worker.runOne(); return fulfilment.order(a.id, admin); };
test('an invoice correction during pack verification prevents release to the browser', async () => {
  const row = await paidAndReady();
  const pack = await db('print_sales_assets').where({ order_id: row.id, kind: 'pack' }).first();
  const original = storage.get.bind(storage); let reads = 0;
  const read = jest.spyOn(storage, 'get').mockImplementation(async key => {
    if (key === pack.storage_key && ++reads === 1)
      await require('../../src/services/invoiceService').cancelInvoice(row.invoice_id, admin.id);
    return original(key);
  });
  try { await expect(download(row.id, admin, 'pack')).rejects.toThrow('fully settled'); }
  finally { read.mockRestore(); }
});
const submitted = async () => {
  const row = await paidAndReady();
  await fulfilment.action(row.id, admin, { action: 'review', artworkVersion: row.artwork_version });
  await fulfilment.action(row.id, admin, { action: 'submit', artworkVersion: row.artwork_version, supplierReference: 'LAB-1' });
  return fulfilment.order(row.id, admin);
};
const invoices = () => require('../../src/services/invoiceService');
async function secondCustomer() {
  const row = await db('customer_accounts').where({ id: customerId }).first();
  const { id, ...rest } = row;
  const ids = await db('customer_accounts').insert({ ...rest, email: `${uuid()}@example.com`, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }).returning('id');
  return ids[0]?.id ?? ids[0];
}
async function newAdmin(extra = {}) {
  const ids = await db('admin_users').insert({ username: uuid(), email: `${uuid()}@example.com`, password_hash: 'unused',
    is_active: true, created_at: new Date().toISOString(), ...extra }).returning('id');
  return ids[0]?.id ?? ids[0];
}
test('a Storno and reissue moves fulfilment to the paid replacement', async () => {
  const row = await paidAndReady();
  await invoices().cancelInvoice(row.invoice_id, admin.id);
  await expect(download(row.id, admin, 'sheet')).rejects.toThrow('fully settled');
  const reissued = await invoices().reissueInvoice(row.invoice_id, admin.id);
  const replacement = await db('invoices').where({ replaces_invoice_id: row.invoice_id }).first();
  expect(replacement?.id).toBeDefined(); expect(reissued).toBeDefined();
  await expect(download(row.id, admin, 'sheet')).rejects.toThrow('fully settled');
  await invoices().markPaid(replacement.id, { amountMinor: Number(replacement.total_amount_minor), paymentMethod: 'bank_transfer' }, admin.id);
  expect((await download(row.id, admin, 'sheet')).length).toBeGreaterThan(0);
});
test('an order at the lab whose invoice was cancelled can be closed, which releases customer erasure', async () => {
  const row = await submitted(), { eraseCustomer } = require('../../src/services/printSales/fulfilment');
  await expect(fulfilment.action(row.id, admin, { action: 'resolve', note: 'Lab refunded' })).rejects.toThrow('native billing first');
  await invoices().cancelInvoice(row.invoice_id, admin.id);
  await expect(fulfilment.action(row.id, admin, { action: 'cancel' })).rejects.toThrow('manual resolution');
  await expect(fulfilment.action(row.id, admin, { action: 'resolve', note: '  ' })).rejects.toThrow();
  await db.transaction(tx => expect(eraseCustomer(tx, customerId)).rejects.toThrow('Resolve active print orders'));
  await fulfilment.action(row.id, admin, { action: 'resolve', note: 'Lab refunded' });
  expect(await fulfilment.order(row.id, admin)).toMatchObject({ status: 'resolved', render_status: 'cancelled' });
  await db.transaction(tx => eraseCustomer(tx, customerId));
  await expect(fulfilment.action(row.id, admin, { action: 'resolve', note: 'Again' })).rejects.toThrow('open order');
  const logged = await db('activity_logs').where({ activity_type: 'print_order_resolve' }).orderBy('id', 'desc').first();
  expect(JSON.stringify(logged.metadata)).toContain('Lab refunded');
});
test('cancelling a closed order changes nothing, and cancel leaves an activity record', async () => {
  const a = await accepted();
  await invoices().cancelInvoice(a.invoiceId, admin.id);
  await fulfilment.action(a.id, admin, { action: 'cancel' });
  const closed = (await fulfilment.order(a.id, admin)).closed_at;
  await expect(fulfilment.action(a.id, admin, { action: 'cancel' })).rejects.toThrow('already closed');
  expect((await fulfilment.order(a.id, admin)).closed_at).toEqual(closed);
  expect(await db('activity_logs').where({ activity_type: 'print_order_cancel' }).first()).toBeTruthy();
});
test('the gallery switch keeps billing with the gallery owner, also when a super admin flips it', async () => {
  const owner = await newAdmin();
  await assignAdminRole(db, owner);
  await db('events').where({ id: event.id }).update({ created_by: owner, print_sales_admin_id: null, print_sales_enabled: false });
  const put = enabled => authed(request(adminApp).put(`/api/admin/print-sales/events/${event.id}`)).send({ enabled });
  expect((await put(true)).status).toBe(200);
  expect(Number((await db('events').where({ id: event.id }).first()).print_sales_admin_id)).toBe(owner);
  await db('events').where({ id: event.id }).update({ print_sales_admin_id: admin.id });
  expect((await put(false)).status).toBe(200);
  expect(Number((await db('events').where({ id: event.id }).first()).print_sales_admin_id)).toBe(admin.id);
});
test('the gallery switch refuses an owner who could not be invoiced under', async () => {
  const owner = await newAdmin();
  await db('events').where({ id: event.id }).update({ created_by: owner });
  const response = await authed(request(adminApp).put(`/api/admin/print-sales/events/${event.id}`)).send({ enabled: true });
  expect(response.status).toBe(409);
});
test('a gallery a non-owner manages cannot be opened: invoices would be refused under it', async () => {
  const other = await newAdmin();
  await assignAdminRole(db, other, 'admin');
  await db('events').where({ id: event.id }).update({ created_by: null });
  const response = await request(adminApp).put(`/api/admin/print-sales/events/${event.id}`)
    .set('Authorization', `Bearer ${mintAdminToken(other)}`).send({ enabled: true });
  expect(response.status).toBe(403);
  expect(response.body.error).toContain('gallery owner');
});
test('with the feature off, preparation/release actions and file downloads stop while order reads stay', async () => {
  const row = await paidAndReady();
  await db('feature_flags').where({ key: 'printSales' }).update({ value: false });
  require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
  for (const action of ['review', 'submit', 'dispatch', 'repair', 'unknown', 'cancel ', ['cancel'], null]) {
    const response = await authed(request(adminApp).post(`/api/admin/print-sales/orders/${row.id}/actions`))
      .send({ action, artworkVersion: row.artwork_version });
    expect(response.status).toBe(403); expect(response.body.code).toBe('PRINT_SALES_DISABLED');
  }
  expect((await authed(request(adminApp).get(`/api/admin/print-sales/orders/${row.id}/files/pack`))).status).toBe(403);
  expect((await authed(request(adminApp).get(`/api/admin/print-sales/orders/${row.id}`))).status).toBe(200);
});
test.each(['cancel', 'resolve'])('with the feature off, %s still needs admin authentication and permissions', async action => {
  const row = await accepted(), path = `/api/admin/print-sales/orders/${row.id}/actions`;
  const viewer = await newAdmin(); await assignAdminRole(db, viewer, 'viewer');
  await db('feature_flags').where({ key: 'printSales' }).update({ value: false });
  require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
  expect((await request(adminApp).post(path).send({ action, note: 'Close for erasure' })).status).toBe(401);
  const denied = await request(adminApp).post(path).set('Authorization', `Bearer ${mintAdminToken(viewer)}`).send({ action, note: 'Close for erasure' });
  expect(denied.status).toBe(403); expect(denied.body.error).toContain('Insufficient permissions');
  expect((await fulfilment.order(row.id, admin)).status).toBe('accepted');
});
test.each(['cancel', 'resolve'])('with the feature off, %s releases customer erasure only after native invoice correction', async action => {
  const buyer = await secondCustomer();
  await db('event_customer_assignments').insert({ event_id: event.id, customer_account_id: buyer });
  const q = await orders.quote(event.id, buyer, 'client', payload());
  await worker.runOne();
  const ready = await orders.status(event.id, buyer, q.id);
  const acceptedOrder = await orders.accept(event.id, buyer, 'client', q.id, { snapshotHash: ready.snapshotHash, acknowledgeSelection: true });
  let row = await fulfilment.order(q.id, admin);
  if (action === 'resolve') {
    await pay(acceptedOrder);
    await fulfilment.action(row.id, admin, { action: 'review', artworkVersion: row.artwork_version });
    await fulfilment.action(row.id, admin, { action: 'submit', artworkVersion: row.artwork_version, supplierReference: 'LAB-ERASURE' });
    row = await fulfilment.order(q.id, admin);
  }
  await db('feature_flags').where({ key: 'printSales' }).update({ value: false });
  require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
  const erase = () => authed(request(customerApp).post(`/api/admin/customers/${buyer}/erase`)).send({});
  const close = () => authed(request(adminApp).post(`/api/admin/print-sales/orders/${row.id}/actions`))
    .send({ action, note: 'Lab cancellation confirmed; close for customer erasure' });
  expect((await erase()).status).toBe(409);
  const refused = await close(); expect(refused.status).toBe(409); expect(refused.body.error).toContain('native billing first');
  expect((await fulfilment.order(row.id, admin)).status).toBe('accepted');
  await invoices().cancelInvoice(row.invoice_id, admin.id);
  const closed = await close(); expect(closed.status).toBe(200);
  expect(closed.body.status).toBe(action === 'cancel' ? 'cancelled' : 'resolved');
  expect((await erase()).status).toBe(200);
  const erased = await db('customer_accounts').where({ id: buyer }).first();
  expect(isTrue(erased.is_active)).toBe(false); expect(erased.display_name).toBeNull();
  expect((await fulfilment.order(row.id, admin)).contact).toBeNull();
  expect((await db('invoices').where({ id: row.invoice_id }).first()).status).toBe('cancelled');
  expect(isTrue((await db('feature_flags').where({ key: 'printSales' }).first()).value)).toBe(false);
});
test('a photo path that leaves the managed originals is refused', async () => {
  await db('photos').where({ id: photoId }).update({ path: '../../.print-sales/other/source.jpg' });
  await expect(quoted()).rejects.toThrow('managed originals');
});
test('large print profiles are admitted without guessing compressed file sizes', async () => {
  const big = { ...definition, manufacturing: { ...definition.manufacturing, trimMm: { width: 600, height: 400 }, resolution: { targetDpi: 300, minimumDpi: 72 },
    output: { format: 'tiff', colourSpace: 'srgb', compression: 'none' } } };
  await expect(P.save(db, { ...config, profiles: [{ definition: big, cataloguePresetId: config.profiles[0].cataloguePresetId }] })).resolves.toHaveProperty('revision');
  const q = await orders.quote(event.id, customerId, 'client', payload());
  expect(q).toMatchObject({ status: 'capturing', invoiceId: null, preparation: { stage: 'queued' } });
  expect(await db('print_sales_assets').where({ order_id: q.id })).toHaveLength(0);
});
test('buyers do not see the lab reference', async () => {
  const row = await submitted();
  expect(orders.shape(row).supplierReference).toBe('LAB-1');
  expect(orders.customerShape(row).supplierReference).toBeUndefined();
  const response = await request(galleryApp).get(`/api/gallery/${event.slug}/print-sales/orders`).set('Authorization', `Bearer ${galleryToken()}`);
  expect(response.status).toBe(200); expect(JSON.stringify(response.body)).not.toContain('LAB-1');
});
test('erasure during source capture prevents late storage writes', async () => {
  const input = payload();
  const racing = require('../../src/services/printSales/orders').createService({ db, storage, sharp: bytes => ({ metadata: async () => {
    await db.transaction(tx => require('../../src/services/printSales/fulfilment').eraseCustomer(tx, customerId));
    await fulfilment.cleanup();
    return sharp(bytes).metadata();
  } }) });
  await racing.quote(event.id, customerId, 'client', input);
  await require('../../src/services/printSales/worker').createWorker({ db, storage, sharp, orders: racing }).runOne();
  expect(await db('print_sales_assets').where({ order_id: input.requestId })).toHaveLength(0);
  expect(await db('print_sales_orders').where({ id: input.requestId }).first()).toMatchObject({ status: 'expired', contact: null });
});
test('a deactivated billing owner closes the shop before any original is retained', async () => {
  await db('admin_users').where({ id: admin.id }).update({ is_active: false });
  try {
    await expect(orders.offers(event.id, customerId)).rejects.toThrow('billing owner');
    await expect(quoted()).rejects.toThrow('billing owner');
    expect(await db('print_sales_orders').first()).toBeUndefined();
  } finally { await db('admin_users').where({ id: admin.id }).update({ is_active: true }); }
});
test('delivery priced differently from the enabled variants is refused on save', async () => {
  const preset = await require('../../src/services/quoteService').createLineItemPreset({ name: 'Delivery', currency: 'USD',
    price_mode: 'fixed', unit_price_minor: 500, vat_code: (await db('quote_line_item_presets').where({ id: config.profiles[0].cataloguePresetId }).first()).vat_code });
  const settings = await P.settings(db);
  await expect(P.save(db, { ...settings, shippingZones: [], countries: ['IE'], shippingPresetId: preset.id })).rejects.toThrow('same currency');
});
test('quotations stop once unaccepted orders hold too many retained bytes', async () => {
  const failed = uuid();
  await db('print_sales_orders').insert({ id: failed, request_hash: 'x', event_id: event.id, customer_account_id: customerId,
    created_by_admin_id: admin.id, status: 'failed', created_at: new Date().toISOString(), expires_at: new Date().toISOString() });
  for (let n = 0; n < 4; n++)
    await db('print_sales_assets').insert({ id: uuid(), order_id: failed, storage_key: `.print-sales/${failed}/${n}`, sha256: 'x', size: 2147483647, kind: 'source', created_at: new Date().toISOString() });
  await expect(quoted()).rejects.toThrow('storage is busy');
});
test('a replayed request for a failed quotation requires a new basket', async () => {
  const input = payload(), q = await orders.quote(event.id, customerId, 'client', input);
  await db('print_sales_orders').where({ id: q.id }).update({ status: 'failed', render_status: 'failed' });
  await expect(orders.quote(event.id, customerId, 'client', input)).rejects.toThrow('expired');
});
test('an admin with open print orders cannot be deleted', async () => {
  const owner = await newAdmin(), a = await accepted();
  await db('print_sales_orders').where({ id: a.id }).update({ created_by_admin_id: owner });
  await expect(require('../../src/services/userManagementService').deleteAdminUser(owner, admin.id)).rejects.toThrow('open print orders');
  await db('print_sales_orders').where({ id: a.id }).update({ created_by_admin_id: admin.id });
});
test('one studio\'s backlog does not refuse another studio\'s customers at acceptance', async () => {
  const q = await quoted(), other = await newAdmin(), now = new Date().toISOString(), buyer = await secondCustomer();
  await db.batchInsert('print_sales_orders', Array.from({ length: 100 }, () => ({ id: uuid(), request_hash: 'x', event_id: event.id,
    customer_account_id: buyer, created_by_admin_id: other, status: 'accepted', render_status: 'ready', created_at: now, expires_at: now })), 50);
  const done = await orders.accept(event.id, customerId, 'client', q.id, { snapshotHash: q.snapshotHash, acknowledgeSelection: true });
  expect(done.status).toBe('accepted');
});
test('a quotation that failed on a bad crop gives its sources back straight away', async () => {
  const input = payload(); input.items[0].crop = { x: 0, y: 0, width: 1, height: .5 };
  await orders.quote(event.id, customerId, 'client', input); await worker.runOne();
  expect((await db('print_sales_orders').where({ id: input.requestId }).first()).status).toBe('failed');
  await fulfilment.cleanup();
  expect(await db('print_sales_assets').where({ order_id: input.requestId })).toHaveLength(0);
  expect((await db('print_sales_orders').where({ id: input.requestId }).first()).purged_at).toBeTruthy();
});
test('one customer cannot use up the retained-source budget for everybody', async () => {
  const failed = uuid(), other = await secondCustomer();
  await db('event_customer_assignments').insert({ event_id: event.id, customer_account_id: other });
  await db('print_sales_orders').insert({ id: failed, request_hash: 'x', event_id: event.id, customer_account_id: customerId,
    created_by_admin_id: admin.id, status: 'failed', created_at: new Date().toISOString(), expires_at: new Date().toISOString() });
  await db('print_sales_assets').insert({ id: uuid(), order_id: failed, storage_key: `.print-sales/${failed}/0`, sha256: 'x', size: 2147483647, kind: 'source', created_at: new Date().toISOString() });
  await db('print_sales_assets').insert({ id: uuid(), order_id: failed, storage_key: `.print-sales/${failed}/1`, sha256: 'x', size: 1100000000, kind: 'source', created_at: new Date().toISOString() });
  await expect(quoted()).rejects.toThrow('storage is busy');
  await expect(orders.quote(event.id, other, 'client', payload())).resolves.toMatchObject({ status: 'capturing' });
});
test('a lapsed quotation is not handed back to an unchanged basket', async () => {
  const input = payload(), q = await quoted(input);
  await db('print_sales_orders').where({ id: q.id }).update({ expires_at: new Date(Date.now() - 1000).toISOString() });
  await expect(quoted(input)).rejects.toThrow('expired');
  await expect(quoted()).resolves.toMatchObject({ status: 'quoted' });
});
test('changing the basket replaces the earlier quotation, however often', async () => {
  const first = await quoted(), second = await quoted(), third = await quoted();
  const rows = await db('print_sales_orders').whereIn('id', [first.id, second.id, third.id]);
  expect(rows.find(r => r.id === third.id).status).toBe('quoted');
  for (const old of [first, second]) {
    const row = rows.find(r => r.id === old.id);
    expect(row).toMatchObject({ status: 'expired', contact: null }); expect(isTrue(row.purge_requested)).toBe(true);
  }
  await expect(orders.accept(event.id, customerId, 'client', first.id, { snapshotHash: first.snapshotHash, acknowledgeSelection: true })).rejects.toThrow('expired');
});
test('a quotation in another gallery survives a new basket here', async () => {
  const q = await quoted();
  await db('print_sales_orders').where({ id: q.id }).update({ event_id: null });
  await quoted();
  expect((await db('print_sales_orders').where({ id: q.id }).first()).status).toBe('quoted');
});
test('crop slack scales with the original, and a wrong ratio is still refused', () => {
  const { geometry } = require('../../src/services/printSales/domain');
  const item = (height, width = .8) => ({ fit: 'cover', crop: { x: 0, y: 0, width, height },
    profile: { artwork: { widthMm: 140, heightMm: 100 }, manufacturing: { resolution: { minimumDpi: 1 } } } });
  const source = { width: 7952, height: 5304, orientation: 1 };
  // 1280.6 x 1920 preview rounded to 1281: a true 1.4 crop, 2.4 px out at full size.
  expect(geometry(source, item(.8 * 7952 / 1.4 / 5304 + 2.4 / 1.4 / 5304))).toBeTruthy();
  expect(() => geometry(source, item(.8))).toThrow('ratio');
  expect(() => geometry({ width: 400, height: 300, orientation: 1 }, { ...item(.8), crop: { x: 0, y: 0, width: 1, height: .9 } })).toThrow('ratio');
});
test('the supplier pack leaves out the private sheet, and earlier attempts leave no artwork behind', async () => {
  const a = await accepted({ repairQueue: true }), stale = uuid(), key = `.print-sales/${a.id}/${stale}.jpg`;
  await storage.put(key, Buffer.from('old'));
  await db('print_sales_assets').insert({ id: stale, order_id: a.id, storage_key: key, sha256: 'x', size: 3, kind: 'artwork', claim: uuid(), created_at: new Date().toISOString() });
  await worker.runOne();
  expect(await db('print_sales_assets').where({ id: stale }).first()).toBeUndefined();
  const row = await db('print_sales_orders').where({ id: a.id }).first();
  const pack = await db('print_sales_assets').where({ order_id: a.id, kind: 'pack', claim: row.claim }).first();
  const bytes = await require('../../src/services/printSales/orders').verified(storage, pack);
  expect(bytes.includes('manifest.json')).toBe(true); expect(bytes.includes('order-sheet.pdf')).toBe(false);
  expect(await db('print_sales_assets').where({ order_id: a.id, kind: 'sheet', claim: row.claim }).first()).toBeTruthy();
});
test('closing an order waits for an unpaid replacement invoice and records a paid one', async () => {
  const row = await submitted();
  await invoices().cancelInvoice(row.invoice_id, admin.id);
  await invoices().reissueInvoice(row.invoice_id, admin.id);
  const replacement = await db('invoices').where({ replaces_invoice_id: row.invoice_id }).first();
  await expect(fulfilment.action(row.id, admin, { action: 'resolve', note: 'Lab refunded' })).rejects.toThrow('replacement invoice');
  await invoices().markPaid(replacement.id, { amountMinor: Number(replacement.total_amount_minor), paymentMethod: 'bank_transfer' }, admin.id);
  await fulfilment.action(row.id, admin, { action: 'resolve', note: 'Lab refunded' });
  expect((await fulfilment.order(row.id, admin)).status).toBe('resolved');
  const logged = await db('activity_logs').where({ activity_type: 'print_order_resolve' }).orderBy('id', 'desc').first();
  expect(P.parse(logged.metadata)).toMatchObject({ replacements: [{ id: replacement.id, status: 'paid' }] });
});
test('closing an order sees an unpaid reissue on any branch of the corrections', async () => {
  const row = await submitted();
  await invoices().cancelInvoice(row.invoice_id, admin.id);
  await invoices().reissueInvoice(row.invoice_id, admin.id);
  const first = await db('invoices').where({ replaces_invoice_id: row.invoice_id }).first();
  await invoices().cancelInvoice(first.id, admin.id);
  await invoices().reissueInvoice(row.invoice_id, admin.id);
  const second = await db('invoices').where({ replaces_invoice_id: row.invoice_id }).whereNot({ id: first.id }).first();
  await invoices().cancelInvoice(second.id, admin.id);
  await invoices().reissueInvoice(second.id, admin.id);
  await expect(fulfilment.action(row.id, admin, { action: 'resolve', note: 'Lab refunded' })).rejects.toThrow('replacement invoice');
  await expect(fulfilment.action(row.id, admin, { action: 'cancel' })).rejects.toThrow('manual resolution');
});
test('orders that keep failing to purge do not starve the rest of the sweep', async () => {
  const stamp = new Date().toISOString(), rows = Array.from({ length: 25 }, () => ({ id: uuid(), request_hash: 'x', event_id: event.id,
    customer_account_id: customerId, created_by_admin_id: admin.id, status: 'failed', purge_requested: true, created_at: stamp, expires_at: stamp }));
  await db.batchInsert('print_sales_orders', rows, 10);
  const stuck = rows.map(r => r.id).sort().slice(0, 20);
  await db.batchInsert('print_sales_assets', stuck.map(id => ({ id: uuid(), order_id: id, storage_key: `.print-sales/${id}/x`, sha256: 'x', size: 1, kind: 'source', created_at: stamp })), 10);
  const deletion = jest.spyOn(storage, 'delete').mockRejectedValue(new Error('Synthetic storage delete failure'));
  try {
    await fulfilment.cleanup(); await fulfilment.cleanup();
    expect(await db('print_sales_orders').whereIn('id', rows.map(r => r.id)).whereNotNull('purged_at')).toHaveLength(5);
  } finally { deletion.mockRestore(); }
});
test('.print-sales is in every default backup path list', async () => {
  const { DEFAULT_PATHS } = require('../../migrations/core/109_add_backup_paths');
  expect(DEFAULT_PATHS.map(p => p.path)).toContain('.print-sales');
});
test('removing a billing admin closes their shop on both engines', async () => {
  const owner = await newAdmin();
  await db('events').where({ id: event.id }).update({ print_sales_admin_id: owner });
  await require('../../src/services/userManagementService').deleteAdminUser(owner, admin.id);
  expect((await db('events').where({ id: event.id }).first()).print_sales_admin_id).toBeNull();
});

test('quote admission returns queued progress without copying sources or creating an invoice', async () => {
  const invoices = Number((await db('invoices').count({ n: '*' }).first()).n), get = jest.spyOn(storage, 'get');
  try {
    const input = payload(), q = await orders.quote(event.id, customerId, 'client', input);
    expect(q).toMatchObject({ status: 'capturing', renderStatus: 'queued', invoiceId: null, preparation: { stage: 'queued', completed: 0, total: 4, percent: 0 } });
    expect(get).not.toHaveBeenCalled();
    expect(await db('print_sales_assets').where({ order_id: q.id })).toHaveLength(0);
    expect(await orders.quote(event.id, customerId, 'client', input)).toEqual(q);
    await expect(orders.accept(event.id, customerId, 'client', q.id, { snapshotHash: q.snapshotHash, acknowledgeSelection: true })).rejects.toThrow('ready');
    expect(Number((await db('invoices').count({ n: '*' }).first()).n)).toBe(invoices);
    expect(JSON.stringify(q)).not.toMatch(/storage_key|\.print-sales|contentHash|pending|preparationBudget/);
  } finally { get.mockRestore(); }
});
test('progress counts stored files, then grants a fresh review window and keeps their exact version on acceptance', async () => {
  const q = await orders.quote(event.id, customerId, 'client', payload()), old = new Date(Date.now() + 60000).toISOString();
  await db('print_sales_orders').where({ id: q.id }).update({ expires_at: old });
  const stages = [], upload = storage.put.bind(storage);
  const spy = jest.spyOn(storage, 'put').mockImplementation(async (...args) => {
    if (args[0].startsWith('.print-sales/')) stages.push((await orders.status(event.id, customerId, q.id)).preparation);
    return upload(...args);
  });
  try { await worker.runOne(); } finally { spy.mockRestore(); }
  expect(stages.map(p => [p.stage, p.completed])).toEqual([['capturing', 0], ['rendering', 1], ['packaging', 2], ['packaging', 3]]);
  const ready = await orders.status(event.id, customerId, q.id);
  expect(ready).toMatchObject({ status: 'quoted', invoiceId: null, preparation: { stage: 'ready', completed: 4, total: 4, percent: 100 } });
  expect(new Date(ready.expiresAt).getTime() - Date.now()).toBeGreaterThan(29 * 60e3);
  const before = await db('print_sales_assets').where({ order_id: q.id }).orderBy('id');
  const accepted = await orders.accept(event.id, customerId, 'client', q.id, { snapshotHash: ready.snapshotHash, acknowledgeSelection: true });
  expect(accepted).toMatchObject({ renderStatus: 'ready', artworkVersion: ready.artworkVersion });
  expect(await worker.runOne()).toBe(false);
  expect(await db('print_sales_assets').where({ order_id: q.id }).orderBy('id')).toEqual(before);
});
test('preparation review windows cannot extend gallery expiry', async () => {
  const expiry = new Date(Date.now() + 5 * 60e3).toISOString();
  await db('events').where({ id: event.id }).update({ expires_at: expiry });
  const q = await quoted(); expect(new Date(q.expiresAt).toISOString()).toBe(expiry);
});
test('an original replaced after admission fails preparation without an invoice', async () => {
  const q = await orders.quote(event.id, customerId, 'client', payload());
  await storage.put(`events/active/${event.slug}/individual/source.jpg`, Buffer.from('replaced'));
  await worker.runOne();
  expect(await orders.status(event.id, customerId, q.id)).toMatchObject({ status: 'failed', invoiceId: null, preparation: { stage: 'failed' } });
});
test('discarding during upload holds the staging reservation and prevents late publication', async () => {
  const q = await orders.quote(event.id, customerId, 'client', payload()); let entered, unblock;
  const paused = new Promise(r => { entered = r; }), resume = new Promise(r => { unblock = r; });
  const upload = storage.put.bind(storage);
  const spy = jest.spyOn(storage, 'put').mockImplementation(async (...args) => {
    const staged = await db('print_sales_assets').where({ order_id: q.id, storage_key: args[0], kind: 'staging' }).first();
    if (staged) { entered(); await resume; }
    return upload(...args);
  });
  const pending = worker.runOne();
  try {
    await paused;
    expect(await db('print_sales_assets').where({ order_id: q.id, kind: 'staging' })).toHaveLength(1);
    await orders.discard(event.id, customerId, q.id); await fulfilment.cleanup();
    expect(await db('print_sales_assets').where({ order_id: q.id, kind: 'staging' })).toHaveLength(1);
    await orders.quote(event.id, customerId, 'client', payload());
    expect(await worker.runOne()).toBe(false);
    unblock(); await pending; await fulfilment.cleanup();
    expect(await db('print_sales_assets').where({ order_id: q.id })).toHaveLength(0);
    expect(await orders.status(event.id, customerId, q.id)).toMatchObject({ status: 'expired', invoiceId: null, preparation: { stage: 'expired' } });
  } finally { unblock(); await pending; spy.mockRestore(); }
});
test('discard is idempotent and cannot cancel a confirmed native invoice', async () => {
  const q = await quoted();
  await orders.discard(event.id, customerId, q.id); await orders.discard(event.id, customerId, q.id);
  await expect(orders.accept(event.id, customerId, 'client', q.id, { snapshotHash: q.snapshotHash, acknowledgeSelection: true })).rejects.toThrow('expired');
  const a = await accepted(); await expect(orders.discard(event.id, customerId, a.id)).rejects.toThrow('confirmed');
  expect((await fulfilment.order(a.id, admin)).invoice_id).toBe(a.invoiceId);
});
test('status and discard routes enforce current customer assignment and do not expose storage details', async () => {
  const q = await orders.quote(event.id, customerId, 'client', payload()), root = `/api/gallery/${event.slug}/print-sales/orders/${q.id}`;
  expect((await request(galleryApp).get(root).set('Authorization', `Bearer ${galleryToken()}`)).body.preparation.stage).toBe('queued');
  const other = await secondCustomer(); await db('event_customer_assignments').insert({ event_id: event.id, customer_account_id: other });
  for (const method of ['get', 'post']) {
    const path = method === 'get' ? root : `${root}/discard`;
    expect((await request(galleryApp)[method](path).set('Authorization', `Bearer ${galleryToken({ customerId: other })}`)).status).toBe(404);
    expect((await request(galleryApp)[method](path).set('Authorization', `Bearer ${galleryToken({ via: undefined })}`)).status).toBe(403);
  }
  await db('event_customer_assignments').where({ event_id: event.id, customer_account_id: customerId }).del();
  expect((await request(galleryApp).get(root).set('Authorization', `Bearer ${galleryToken()}`)).status).toBe(403);
});
test('expired preparations promptly reclaim files, and cannot report ready while waiting for cleanup', async () => {
  const q = await quoted();
  await db('print_sales_orders').where({ id: q.id }).update({ expires_at: new Date(Date.now() - 1000).toISOString() });
  expect((await orders.status(event.id, customerId, q.id)).preparation.stage).toBe('expired');
  await fulfilment.cleanup();
  expect(await db('print_sales_assets').where({ order_id: q.id })).toHaveLength(0);
  expect((await fulfilment.order(q.id, admin)).purged_at).toBeTruthy();
});
test('an actual oversized encoded image fails before confirmation and invoice creation', async () => {
  const q = await orders.quote(event.id, customerId, 'client', payload());
  const encode = jest.spyOn(require('../../src/services/printSales/output'), 'encode').mockResolvedValue({ extension: 'jpg', bytes: Buffer.alloc(18 * 1024 * 1024) });
  try { await worker.runOne(); } finally { encode.mockRestore(); }
  expect(await orders.status(event.id, customerId, q.id)).toMatchObject({ status: 'failed', invoiceId: null });
  await fulfilment.cleanup(); expect(await db('print_sales_assets').where({ order_id: q.id })).toHaveLength(0);
});
test('uncompressed artwork above the former 64 MiB cap is stored and packaged before an invoice', async () => {
  const manufacturing = { ...definition.manufacturing, trimMm: { width: 508, height: 338.6667 }, resolution: { targetDpi: 300, minimumDpi: 72 },
    output: { format: 'tiff', colourSpace: 'srgb', compression: 'none' } };
  await P.save(db, { ...config, profiles: [{ definition: { ...definition, manufacturing }, cataloguePresetId: config.profiles[0].cataloguePresetId }] });
  const original = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#3578a2' } }).jpeg().toBuffer();
  await storage.put(`events/active/${event.slug}/individual/source.jpg`, original);
  await db('photos').where({ id: photoId }).update({ content_sha256: V.hash(original) });
  const input = payload();
  const q = await orders.quote(event.id, customerId, 'client', input), isolated = require('../../src/services/isolatedSharp');
  try { await require('../../src/services/printSales/worker').createWorker({ db, storage, sharp: isolated, orders }).runOne(); }
  finally { await isolated.shutdown(); }
  const row = await fulfilment.order(q.id, admin); expect(row.render_status).toBe('ready');
  const artwork = await db('print_sales_assets').where({ order_id: q.id, kind: 'artwork' }).first();
  expect(artwork.size).toBeGreaterThan(64 * 1024 * 1024);
  const pack = await db('print_sales_assets').where({ order_id: q.id, kind: 'pack' }).first();
  expect(pack.size).toBeGreaterThan(artwork.size); expect(row.invoice_id).toBeNull();
  await require('../../src/services/printSales/files').verify(storage, pack);
}, 120000);

test('retry retains completed original captures and does not reread a replaced gallery source', async () => {
  const q = await orders.quote(event.id, customerId, 'client', payload()); let once = true;
  const interrupted = require('../../src/services/printSales/worker').createWorker({ db, storage, sharp, orders: { ...orders,
    asset: (...args) => { if (once && args[1] === 'artwork') { once = false; throw new Error('temporary write failure'); } return orders.asset(...args); } } });
  await interrupted.runOne();
  expect((await fulfilment.order(q.id, admin)).render_status).toBe('queued');
  const source = await db('print_sales_assets').where({ order_id: q.id, kind: 'source' }).first();
  await storage.delete(`events/active/${event.slug}/individual/source.jpg`);
  await worker.runOne();
  expect(await orders.status(event.id, customerId, q.id)).toMatchObject({ renderStatus: 'ready', invoiceId: null });
  expect((await db('print_sales_assets').where({ order_id: q.id, kind: 'source' })).map(a => a.id)).toEqual([source.id]);
});
test('confirmed legacy work takes priority over an unconfirmed preparation', async () => {
  const a = await accepted({ repairQueue: true }), q = await orders.quote(event.id, customerId, 'client', payload());
  await worker.runOne();
  expect((await fulfilment.order(a.id, admin)).render_status).toBe('ready');
  expect((await fulfilment.order(q.id, admin)).render_status).toBe('queued');
  await worker.runOne(); expect((await fulfilment.order(q.id, admin)).render_status).toBe('ready');
});
test('installation storage admission includes other customers failed and staging objects', async () => {
  for (let n = 0; n < 3; n++) {
    const other = await secondCustomer(), id = uuid(), stamp = new Date().toISOString();
    await db('print_sales_orders').insert({ id, request_hash: 'capacity-fixture', customer_account_id: other,
      status: 'failed', created_at: stamp, expires_at: stamp });
    for (let a = 0; a < 2; a++) await db('print_sales_assets').insert({ id: uuid(), order_id: id, storage_key: `.print-sales/${id}/${a}`,
      sha256: '', size: 1500 * 1024 * 1024, kind: 'staging', created_at: stamp });
  }
  await expect(orders.quote(event.id, customerId, 'client', payload())).rejects.toThrow('storage is busy');
});
test('failed staged uploads keep their ledger until storage deletion succeeds', async () => {
  const q = await orders.quote(event.id, customerId, 'client', payload()), upload = storage.put.bind(storage);
  const put = jest.spyOn(storage, 'put').mockImplementation(async (...args) => { await upload(...args); throw new Error('write acknowledgement lost'); });
  const remove = jest.spyOn(storage, 'delete').mockRejectedValue(new Error('storage unavailable'));
  try {
    await worker.runOne(); await orders.discard(event.id, customerId, q.id);
    await db('print_sales_orders').where({ id: q.id }).update({ heartbeat: '2000-01-01T00:00:00Z' });
    await fulfilment.cleanup();
    expect(await db('print_sales_assets').where({ order_id: q.id, kind: 'staging' })).toHaveLength(1);
    expect((await fulfilment.order(q.id, admin)).purged_at).toBeNull();
  } finally { put.mockRestore(); remove.mockRestore(); }
  await fulfilment.cleanup();
  expect(await db('print_sales_assets').where({ order_id: q.id })).toHaveLength(0);
  expect((await fulfilment.order(q.id, admin)).purged_at).toBeTruthy();
});

test('an unconfirmed preparation exhausted by interrupted workers releases its reservation for cleanup', async () => {
  const q = await orders.quote(event.id, customerId, 'client', payload());
  await db('print_sales_orders').where({ id: q.id }).update({ attempts: 3, render_status: 'running', claim: uuid(), heartbeat: '2000-01-01T00:00:00Z' });
  await worker.runOne();
  const row = await fulfilment.order(q.id, admin);
  expect(row).toMatchObject({ status: 'failed', render_status: 'failed', invoice_id: null });
  expect(isTrue(row.purge_requested)).toBe(true);
  await fulfilment.cleanup(); expect((await fulfilment.order(q.id, admin)).purged_at).toBeTruthy();
});

test('concurrent customers cannot reserve the same remaining installation space', async () => {
  const other = await secondCustomer(), holder = await secondCustomer(), retained = uuid(), stamp = new Date().toISOString();
  await db('event_customer_assignments').insert({ event_id: event.id, customer_account_id: other });
  const plan = await require('../../src/services/printSales/domain').plan(db, payload().items, { country: 'IE' });
  const { preparationBudget, MAX_PENDING_BYTES } = require('../../src/services/printSales/limits');
  const reservation = preparationBudget(plan.items, sourceBytes.length).totalBytes;
  await db('print_sales_orders').insert({ id: retained, request_hash: 'capacity-fixture', customer_account_id: holder,
    status: 'failed', created_at: stamp, expires_at: stamp });
  let remaining = MAX_PENDING_BYTES - Math.floor(reservation * 1.5);
  for (let n = 0; remaining > 0; n++) {
    const size = Math.min(2147483647, remaining); remaining -= size;
    await db('print_sales_assets').insert({ id: uuid(), order_id: retained, storage_key: `.print-sales/${retained}/${n}`,
      sha256: '', size, kind: 'staging', created_at: stamp });
  }
  const results = await Promise.allSettled([orders.quote(event.id, customerId, 'client', payload()), orders.quote(event.id, other, 'client', payload())]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  const refused = results.find(r => r.status === 'rejected'); expect(refused.reason.message).toContain('storage is busy');
  expect(await db('print_sales_orders').where({ status: 'capturing' })).toHaveLength(1);
});

test('backup references skip unfinished uploads and keep completed private files', async () => {
  const q = await quoted(), key = `.print-sales/${q.id}/${uuid()}.zip`;
  await db('print_sales_assets').insert({ id: uuid(), order_id: q.id, storage_key: key, kind: 'staging', sha256: '', size: 100, created_at: new Date().toISOString() });
  const recovery = require('../../src/services/recoveryFiles'), refs = await recovery.requiredKeys(db, () => true);
  expect(refs.has(key)).toBe(false); expect([...refs].some(k => k.startsWith(`.print-sales/${q.id}/`))).toBe(true);
  const snapshot = new Map([['print_sales_assets', await db('print_sales_assets')]]);
  expect((await recovery.requiredKeys(snapshot, () => true)).has(key)).toBe(false);
});
test('S3 backup inventory handles discard, late publication and genuinely missing retained files', async () => {
  const q = await quoted(), recovery = require('../../src/services/recoveryFiles'), adapter = require('../../src/services/storage');
  const refs = (await db('print_sales_assets').where({ order_id: q.id })).map(asset => asset.storage_key);
  const fake = { kind: () => 's3', list: async () => [], stat: storage.stat.bind(storage), get: storage.get.bind(storage) };
  adapter.setStorageForTesting(fake);
  try {
    // All uploads landed after the listing: HEAD confirms their committed keys.
    expect(await recovery.adapterInventory(db, ['.print-sales'], undefined, refs)).toHaveLength(refs.length);
    const a = await db('print_sales_assets').where({ order_id: q.id, kind: 'pack' }).first();
    await storage.delete(a.storage_key);
    await expect(recovery.adapterInventory(db, ['.print-sales'], undefined, refs)).rejects.toThrow('missing from the backup inventory');
    await db('print_sales_assets').where({ id: a.id }).del();
    expect(await recovery.adapterInventory(db, ['.print-sales'], undefined, refs)).toHaveLength(refs.length - 1);
  } finally { adapter.setStorageForTesting(storage); }
});
test('S3 export capture tolerates an unconfirmed basket removed after inventory', async () => {
  const q = await quoted(), recovery = require('../../src/services/recoveryFiles'), adapter = require('../../src/services/storage');
  const fake = { kind: () => 's3', list: async prefix => storage.list(prefix.replace(/\/$/, '')), stat: storage.stat.bind(storage), get: storage.get.bind(storage) };
  const dir = await require('fs').promises.mkdtemp(require('path').join(require('os').tmpdir(), 'print-export-test-'));
  adapter.setStorageForTesting(fake);
  try {
    const inventory = await recovery.adapterInventory(db, ['.print-sales']);
    await orders.discard(event.id, customerId, q.id); await fulfilment.cleanup();
    expect(await recovery.materialize(inventory, dir, Number.MAX_SAFE_INTEGER, db)).toHaveLength(0);
  } finally { adapter.setStorageForTesting(storage); await require('fs').promises.rm(dir, { recursive: true, force: true }); }
});
test('finished preparations release unused reserved space while queued work keeps its allocation', async () => {
  const q = await quoted(), limits = require('../../src/services/printSales/limits');
  const actual = Number((await db('print_sales_assets').where({ order_id: q.id }).sum({ bytes: 'size' }).first()).bytes);
  const reserve = require('../../src/services/printSales/limits').budgetOf(P.parse((await fulfilment.order(q.id, admin)).snapshot)).totalBytes;
  expect(reserve).toBeGreaterThan(actual);
  // Leave exactly enough space for the actual finished files, not the estimate.
  await expect(db.transaction(async tx => {
    await tx('print_sales_settings').where({ id: 1 }).forUpdate().first();
    await require('../../src/services/printSales/capacity').admit(tx, customerId, limits.MAX_CUSTOMER_PENDING_BYTES - actual);
  })).resolves.toBeUndefined();
  await db('print_sales_orders').where({ id: q.id }).update({ render_status: 'queued' });
  await expect(db.transaction(tx => require('../../src/services/printSales/capacity').admit(tx, customerId, limits.MAX_CUSTOMER_PENDING_BYTES - actual)))
    .rejects.toThrow('storage is busy');
});
test('confirmed damaged artwork can be repaired without changing the invoice or frozen selections', async () => {
  const row = await paidAndReady(), original = row.snapshot;
  await fulfilment.action(row.id, admin, { action: 'review', artworkVersion: row.artwork_version });
  const a = await db('print_sales_assets').where({ order_id: row.id, kind: 'artwork' }).first(); await storage.delete(a.storage_key);
  expect((await download(row.id, admin, 'sheet')).subarray(0, 4).toString()).toBe('%PDF');
  await expect(fulfilment.action(row.id, admin, { action: 'review', artworkVersion: row.artwork_version })).rejects.toThrow('missing');
  await fulfilment.action(row.id, admin, { action: 'repair' });
  expect(await fulfilment.order(row.id, admin)).toMatchObject({ invoice_id: row.invoice_id, snapshot: original, render_status: 'queued', reviewed_at: null, artwork_version: null });
  await worker.runOne(); const repaired = await fulfilment.order(row.id, admin);
  expect(repaired.render_status).toBe('ready'); expect(repaired.artwork_version).not.toBe(row.artwork_version);
  expect((await db('invoices').where({ id: row.invoice_id }).first()).status).toBe('paid');
  await expect(fulfilment.action(row.id, admin, { action: 'submit', artworkVersion: repaired.artwork_version, supplierReference: 'LAB-REPAIR' })).rejects.toThrow('Check');
  expect(await db('activity_logs').where({ activity_type: 'print_order_repair' }).first()).toBeTruthy();
});
test('repair refuses a missing frozen source and never substitutes the gallery original', async () => {
  const row = await paidAndReady();
  for (const kind of ['pack', 'source']) await storage.delete((await db('print_sales_assets').where({ order_id: row.id, kind }).first()).storage_key);
  const get = jest.spyOn(storage, 'get');
  try {
    await expect(fulfilment.action(row.id, admin, { action: 'repair' })).rejects.toThrow('missing');
    expect(get.mock.calls.some(([key]) => key.startsWith('events/'))).toBe(false);
    expect((await fulfilment.order(row.id, admin)).render_status).toBe('ready');
  } finally { get.mockRestore(); }
});
test('repair cannot rebuild files already submitted to the lab', async () => {
  const row = await submitted(); await storage.delete((await db('print_sales_assets').where({ order_id: row.id, kind: 'pack' }).first()).storage_key);
  await expect(fulfilment.action(row.id, admin, { action: 'repair' })).rejects.toThrow('not yet submitted');
});
test('dispatch records a paid lab shipment even if its retained pack was subsequently lost', async () => {
  const row = await submitted();
  await storage.delete((await db('print_sales_assets').where({ order_id: row.id, kind: 'pack' }).first()).storage_key);
  const get = jest.spyOn(storage, 'get');
  try {
    await fulfilment.action(row.id, admin, { action: 'dispatch', artworkVersion: row.artwork_version, tracking: 'TRACK-1' });
    expect(await fulfilment.order(row.id, admin)).toMatchObject({ status: 'dispatched', tracking: 'TRACK-1' });
    expect(get).not.toHaveBeenCalled();
    expect((await db('invoices').where({ id: row.invoice_id }).first()).status).toBe('paid');
  } finally { get.mockRestore(); }
});
test.each(['healthy', 'queued'])('repair reports its %s outcome through the actual admin projection', async outcome => {
  const row = await paidAndReady();
  if (outcome === 'queued') await storage.delete((await db('print_sales_assets').where({ order_id: row.id, kind: 'pack' }).first()).storage_key);
  const result = await authed(request(adminApp).post(`/api/admin/print-sales/orders/${row.id}/actions`)).send({ action: 'repair' });
  expect(result.status).toBe(200); expect(result.body).toMatchObject({ id: row.id, repair: outcome, artworkVersion: outcome === 'healthy' ? row.artwork_version : null });
});
test('download status migration reruns and repairs an interrupted index without changing orders', async () => {
  const row = await paidAndReady(), migration = require('../../migrations/core/342_print_download_status');
  const attempt = await require('../../src/services/printSales/downloadStatus').createService(db).create(row.id, admin, 'pack');
  await db.raw('DROP INDEX print_sales_downloads_expires_at_index');
  await migration.up(db); await migration.up(db);
  const index = db.client.config.client === 'pg'
    ? await db('pg_indexes').where({ indexname: 'print_sales_downloads_expires_at_index' }).first()
    : await db('sqlite_master').where({ type: 'index', name: 'print_sales_downloads_expires_at_index' }).first();
  expect(index).toBeTruthy(); expect((await db('print_sales_downloads').where({ id: attempt.id }).first()).status).toBe('pending');
  await migration.down(db); await migration.up(db);
  expect(await db('print_sales_downloads')).toHaveLength(0);
  expect((await fulfilment.order(row.id, admin)).invoice_id).toBe(row.invoice_id);
});
test.each(['missing', 'capacity', 'success'])('the status API reports the actual native GET outcome: %s', async reason => {
  const row = await paidAndReady(), path = `/api/admin/print-sales/orders/${row.id}/files/pack`;
  const get = jest.spyOn(storage, 'get'); let release, active = [];
  try {
    const created = await authed(request(adminApp).post(`${path}/downloads`));
    expect(created.status).toBe(201); expect(created.body.status).toBe('pending'); expect(get).not.toHaveBeenCalled();
    const id = created.body.id;
    const status = () => authed(request(adminApp).get(`${path}/downloads/${id}`));
    await expect(require('../../src/services/printSales/downloadStatus').createService(db).read(id, row.id, { id: admin.id + 1000 }, 'pack')).rejects.toThrow('not found');
    expect((await authed(request(adminApp).get(`${path.replace('/pack', '/sheet')}/downloads/${id}`))).status).toBe(404);
    if (reason === 'missing') await storage.delete((await db('print_sales_assets').where({ order_id: row.id, kind: 'pack' }).first()).storage_key);
    if (reason === 'capacity') {
      let entered = 0, ready;
      const started = new Promise(r => { ready = r; }), held = new Promise(r => { release = r; });
      const consume = async () => { if (++entered === 2) ready(); await held; };
      active = [fulfilment.download(row.id, admin, 'pack', consume), fulfilment.download(row.id, admin, 'sheet', consume)];
      await started;
    }
    const response = await authed(request(adminApp).get(path).query({ downloadId: id }));
    expect(response.status).toBe(reason === 'success' ? 200 : reason === 'missing' ? 409 : 503);
    const state = await status(); expect(state.status).toBe(200);
    expect(state.body.status).toBe(reason === 'success' ? 'complete' : 'failed');
    if (reason !== 'success') expect(state.body.error).toMatch(reason === 'missing' ? /missing/ : /already in progress/);
    expect((await authed(request(adminApp).get(path).query({ downloadId: id }))).status).toBe(409);
    if (reason === 'success') expect(get).toHaveBeenCalledTimes(1);
    expect(Object.keys(state.body).sort()).toEqual(['error', 'id', 'status']);
    await db('print_sales_downloads').where({ id }).update({ expires_at: '2000-01-01T00:00:00Z' });
    await require('../../src/services/printSales/downloadStatus').createService(db).cleanup();
    expect((await status()).status).toBe(404);
  } finally { release?.(); await Promise.all(active); get.mockRestore(); }
});
test('HEAD authorises from metadata and GET reads only the requested file once', async () => {
  const row = await paidAndReady(), get = jest.spyOn(storage, 'get');
  try {
    const reply = await authed(request(adminApp).head(`/api/admin/print-sales/orders/${row.id}/files/pack`));
    expect(reply.status).toBe(200); expect(Number(reply.headers['content-length'])).toBeGreaterThan(0); expect(get).not.toHaveBeenCalled();
    await download(row.id, admin, 'pack'); expect(get).toHaveBeenCalledTimes(1);
  } finally { get.mockRestore(); }
});
test('a third download is refused before reading any file bytes', async () => {
  const row = await paidAndReady(); let release, entered = 0, ready;
  const held = new Promise(r => { release = r; }), started = new Promise(r => { ready = r; });
  const consume = async () => { if (++entered === 2) ready(); await held; };
  const active = [fulfilment.download(row.id, admin, 'pack', consume), fulfilment.download(row.id, admin, 'sheet', consume)];
  try {
    await started; const get = jest.spyOn(storage, 'get');
    try { await expect(download(row.id, admin, 'pack')).rejects.toMatchObject({ statusCode: 503 }); expect(get).not.toHaveBeenCalled(); }
    finally { get.mockRestore(); }
  } finally { release(); await Promise.all(active); }
});
test.each(['discard', 'expiry', 'claim'])('the heartbeat aborts an active upload after %s', async reason => {
  const q = await orders.quote(event.id, customerId, 'client', payload()); let entered;
  const started = new Promise(r => { entered = r; });
  const put = jest.spyOn(storage, 'put').mockImplementation(async (_key, _body, { signal }) => {
    entered(); await new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  const job = require('../../src/services/printSales/worker').createWorker({ db, storage, sharp, orders, heartbeatMs: 20 }).runOne();
  try {
    await started;
    if (reason === 'discard') await orders.discard(event.id, customerId, q.id);
    else await db('print_sales_orders').where({ id: q.id }).update(reason === 'expiry' ? { expires_at: '2000-01-01T00:00:00Z' } : { claim: uuid(), render_status: 'queued' });
    await job;
    expect(await db('print_sales_assets').where({ order_id: q.id })).toHaveLength(0);
    expect((await fulfilment.order(q.id, admin)).invoice_id).toBeNull();
  } finally { put.mockRestore(); await job; }
});
test('permanent isolated-image refusals stop after one attempt', async () => {
  const q = await orders.quote(event.id, customerId, 'client', payload());
  const refusal = require('../../src/services/printSales/worker').createWorker({ db, storage, sharp: () => { throw Object.assign(new Error('Permanent image limit'), { status: 422 }); }, orders });
  await refusal.runOne();
  expect(await fulfilment.order(q.id, admin)).toMatchObject({ status: 'failed', render_status: 'failed', attempts: 1, invoice_id: null });
});
test('a transient child crash retries with a fresh attempt and stops at the bounded limit', async () => {
  const q = await orders.quote(event.id, customerId, 'client', payload());
  const crash = () => { throw Object.assign(new Error('Child exited'), { code: 'IMAGE_WORKER_FAILED', status: 422 }); };
  const crashing = require('../../src/services/printSales/worker').createWorker({ db, storage, sharp: crash, orders });
  await crashing.runOne();
  expect(await fulfilment.order(q.id, admin)).toMatchObject({ render_status: 'queued', attempts: 1, invoice_id: null });
  await crashing.runOne(); await crashing.runOne();
  expect(await fulfilment.order(q.id, admin)).toMatchObject({ status: 'failed', render_status: 'failed', attempts: 3, invoice_id: null });
});
test.each(['temporary', 'lease exhausted'])('heartbeat database errors are bounded by the lease: %s', async reason => {
  const q = await orders.quote(event.id, customerId, 'client', payload());
  let entered, failed, release, blocked = false, failures = 0;
  const started = new Promise(r => { entered = r; }), failure = new Promise(r => { failed = r; });
  const held = new Promise(r => { release = r; });
  const originalPut = storage.put.bind(storage), originalQuery = db.client.query.bind(db.client);
  const put = jest.spyOn(storage, 'put').mockImplementationOnce(async (key, body, options) => {
    blocked = true; entered();
    await Promise.race([held, new Promise((_r, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))]);
    return originalPut(key, body, options);
  });
  const query = jest.spyOn(db.client, 'query').mockImplementation((connection, statement) => {
    if (blocked && /^select \*/i.test(statement.sql) && statement.sql.includes('print_sales_orders') && (reason !== 'temporary' || failures === 0)) {
      failures++; failed(); return Promise.reject(Object.assign(new Error('Transient database disconnect'), { code: 'ECONNRESET' }));
    }
    return originalQuery(connection, statement);
  });
  const task = require('../../src/services/printSales/worker').createWorker({ db, storage, sharp, orders, heartbeatMs: 20, leaseMs: reason === 'temporary' ? 300000 : 160 }).runOne();
  try {
    await started; await failure;
    if (reason === 'temporary') release();
    await task; blocked = false;
    const row = await fulfilment.order(q.id, admin);
    expect(row).toMatchObject({ render_status: reason === 'temporary' ? 'ready' : 'queued', attempts: 1, invoice_id: null });
  } finally { blocked = false; release(); query.mockRestore(); put.mockRestore(); await task; }
});
test('mathematically oversized uncompressed TIFF baskets are refused before retaining or rendering', async () => {
  const manufacturing = { ...definition.manufacturing, trimMm: { width: 600, height: 400 }, resolution: { targetDpi: 300, minimumDpi: 72 },
    output: { format: 'tiff', colourSpace: 'srgb', compression: 'none' } };
  await P.save(db, { ...config, profiles: [{ definition: { ...definition, manufacturing }, cataloguePresetId: config.profiles[0].cataloguePresetId }] });
  const input = payload(); input.items = Array.from({ length: 11 }, () => ({ ...input.items[0] }));
  await expect(orders.quote(event.id, customerId, 'client', input)).rejects.toThrow('Uncompressed TIFF');
  expect(await db('print_sales_orders')).toHaveLength(0); expect(await db('print_sales_assets')).toHaveLength(0);
});

const sdkTest = process.env.PICPEAK_PRINT_S3_TEST_URL ? test : test.skip;
async function withPrintS3(run) {
  const sdk = require('@aws-sdk/client-s3'), bucket = `print-fixture-${uuid()}`;
  const endpoint = process.env.PICPEAK_PRINT_S3_TEST_URL;
  const config = { endpoint, bucket, region: 'us-east-1', forcePathStyle: true, sslEnabled: false,
    accessKeyId: crypto.randomBytes(16).toString('hex'), secretAccessKey: crypto.randomBytes(24).toString('hex'), partSize: 5 * 1024 * 1024 };
  const client = new sdk.S3Client({ endpoint, region: config.region, forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } });
  await client.send(new sdk.CreateBucketCommand({ Bucket: bucket }));
  const s3 = new (require('../../src/services/storage/S3StorageBackend'))({ ...config, indexDatabase: db });
  try {
    await s3.init(); require('../../src/services/storage').setStorageForTesting(s3);
    await run(s3, client, bucket, sdk);
  } finally {
    require('../../src/services/storage').setStorageForTesting(storage);
    for (const file of await s3.list('')) await s3.delete(file.key);
    await client.send(new sdk.DeleteBucketCommand({ Bucket: bucket })); client.destroy(); s3.adapter.s3Client.destroy();
  }
}
sdkTest('S3 SDK export works during a real multipart preparation and includes the completed order files', async () => {
  await withPrintS3(async s3 => {
    const bytes = await sharp(crypto.randomBytes(2400 * 3600 * 3), { raw: { width: 2400, height: 3600, channels: 3 } }).jpeg({ quality: 100 }).toBuffer();
    await s3.put(`events/active/${event.slug}/individual/source.jpg`, bytes);
    await db('photos').where({ id: photoId }).update({ content_sha256: V.hash(bytes) });
    const service = require('../../src/services/printSales/orders').createService({ db, storage: s3, sharp });
    const q = await service.quote(event.id, customerId, 'client', payload()); let entered, resume, once = false;
    const started = new Promise(r => { entered = r; }), held = new Promise(r => { resume = r; });
    s3.adapter.s3Client.middlewareStack.add((next, context) => async args => {
      const result = await next(args);
      if (!once && context.commandName === 'UploadPartCommand' && args.input.Key.startsWith('.print-sales/')) { once = true; entered(); await held; }
      return result;
    }, { step: 'initialize', name: 'pausePrintMultipartFixture' });
    const job = require('../../src/services/printSales/worker').createWorker({ db, storage: s3, sharp, orders: service }).runOne();
    const exports = [];
    try {
      await started;
      const stage = await db('print_sales_assets').where({ order_id: q.id, kind: 'staging' }).first();
      expect(await s3.stat(stage.storage_key)).toBeNull();
      exports.push(await require('../../src/services/picpeakExportService').createPicpeak({ includePhotos: false }));
      resume(); await job;
      expect((await service.status(event.id, customerId, q.id)).renderStatus).toBe('ready');
      exports.push(await require('../../src/services/picpeakExportService').createPicpeak({ includePhotos: false }));
      const archive = new (require('node-stream-zip').async)({ file: exports[1].filePath });
      try { expect(Object.keys(await archive.entries()).filter(key => key.startsWith(`files/.print-sales/${q.id}/`))).toHaveLength(4); }
      finally { await archive.close(); }
    } finally {
      resume(); await job;
      for (const result of exports) await require('fs').promises.rm(require('path').dirname(result.filePath), { recursive: true, force: true });
    }
  });
}, 120000);
sdkTest('S3 SDK cancellation finishes multipart cleanup before releasing the staging asset', async () => {
  await withPrintS3(async (s3, client, bucket, sdk) => {
    await s3.put(`events/active/${event.slug}/individual/source.jpg`, sourceBytes);
    const service = require('../../src/services/printSales/orders').createService({ db, storage: s3, sharp });
    const q = await service.quote(event.id, customerId, 'client', payload()), claim = uuid(), controller = new AbortController();
    await db('print_sales_orders').where({ id: q.id }).update({ claim, render_status: 'running', heartbeat: new Date().toISOString() });
    let entered, sent = false; const started = new Promise(r => { entered = r; });
    s3.adapter.s3Client.middlewareStack.add((next, context) => async args => {
      const result = await next(args); if (context.commandName === 'UploadPartCommand') entered(); return result;
    }, { step: 'initialize', name: 'observePrintMultipartFixture' });
    const body = new (require('stream').Readable)({ read() { if (!sent) { sent = true; this.push(Buffer.alloc(6 * 1024 * 1024)); } } });
    const uploading = service.asset(q.id, 'pack', body, claim, 'zip', { signal: controller.signal, maxBytes: 9 * 1024 * 1024 });
    const failure = expect(uploading).rejects.toMatchObject({ name: 'AbortError' });
    await started; controller.abort(); await failure;
    expect((await client.send(new sdk.ListMultipartUploadsCommand({ Bucket: bucket }))).Uploads || []).toHaveLength(0);
    expect(await db('print_sales_assets').where({ order_id: q.id })).toHaveLength(0);
  });
}, 120000);

sdkTest('S3 SDK retries transient part failures without reusing a completed Upload object', async () => {
  await withPrintS3(async s3 => {
    let injected = false;
    s3.adapter.s3Client.middlewareStack.add((next, context) => async args => {
      if (!injected && context.commandName === 'UploadPartCommand') {
        injected = true;
        throw Object.assign(new Error('Synthetic temporary part failure'), { name: 'ServiceUnavailable', $metadata: { httpStatusCode: 503 }, $retryable: {} });
      }
      return next(args);
    }, { step: 'deserialize', name: 'transientPrintPartFixture' });
    const bytes = crypto.randomBytes(6 * 1024 * 1024), key = '.print-sales/retry-fixture/artwork.bin';
    await s3.put(key, bytes);
    expect(injected).toBe(true);
    const digest = require('crypto').createHash('sha256');
    for await (const chunk of await s3.get(key)) digest.update(chunk);
    expect(digest.digest('hex')).toBe(V.hash(bytes));
  });
}, 120000);
sdkTest('S3 SDK cancellation during multipart completion leaves neither parts nor a published asset', async () => {
  await withPrintS3(async (s3, client, bucket, sdk) => {
    await s3.put(`events/active/${event.slug}/individual/source.jpg`, sourceBytes);
    const service = require('../../src/services/printSales/orders').createService({ db, storage: s3, sharp });
    const q = await service.quote(event.id, customerId, 'client', payload()), claim = uuid(), controller = new AbortController();
    await db('print_sales_orders').where({ id: q.id }).update({ claim, render_status: 'running', heartbeat: new Date().toISOString() });
    let entered, resume;
    const started = new Promise(r => { entered = r; }), held = new Promise(r => { resume = r; });
    s3.adapter.s3Client.middlewareStack.add((next, context) => async args => {
      if (context.commandName === 'CompleteMultipartUploadCommand') { entered(); await held; }
      return next(args);
    }, { step: 'initialize', name: 'pausePrintCompletionFixture' });
    const uploading = service.asset(q.id, 'pack', crypto.randomBytes(6 * 1024 * 1024), claim, 'zip', { signal: controller.signal, maxBytes: 9 * 1024 * 1024 });
    const failure = expect(uploading).rejects.toMatchObject({ name: 'AbortError' });
    try { await started; controller.abort(); } finally { resume(); }
    await failure;
    expect((await client.send(new sdk.ListMultipartUploadsCommand({ Bucket: bucket }))).Uploads || []).toHaveLength(0);
    expect((await s3.list(`.print-sales/${q.id}/`))).toHaveLength(0);
    expect(await db('print_sales_assets').where({ order_id: q.id })).toHaveLength(0);
  });
}, 120000);
