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
let db, cleanup, storage, orders, fulfilment, worker, admin, customerId, event, photoId, config, definition, product,
  sourceBytes, adminApp, galleryApp, adminToken;
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
  galleryApp = buildRouteApp('/api/gallery', require('../../src/routes/gallery/printSales'));
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
const payload = () => ({ requestId: uuid(), items: [{ profileId: definition.id, photoId, quantity: 2,
  crop: { x: 0, y: 0, width: 1, height: 1 }, fit: 'cover' }],
delivery: { country: 'IE', name: 'Synthetic Buyer', line1: '1 Test Lane', city: 'Dublin', postalCode: 'D01 TEST' } });
async function quoted(input = payload()) { return orders.quote(event.id, customerId, 'client', input); }
async function accepted() {
  const q = await quoted();
  return orders.accept(event.id, customerId, 'client', q.id, { snapshotHash: q.snapshotHash, acknowledgeSelection: true });
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
test('refuses mismatched crops and insufficient effective resolution', async () => {
  const a = payload(); a.items[0].crop.width = .5;
  await expect(quoted(a)).rejects.toThrow('ratio');
  const b = payload(); b.items[0].crop = { x: 0, y: 0, width: .1, height: .1 };
  await expect(quoted(b)).rejects.toThrow('insufficient');
});
test('retained sources survive gallery deletion and produce sRGB artwork plus neutral pack', async () => {
  const a = await accepted();
  await require('../../src/routes/adminEvents/helpers').deleteEventCascade(event.id, { ...admin, username: 'Synthetic admin' });
  await storage.delete(`events/active/${event.slug}/individual/source.jpg`);
  expect(await worker.runOne()).toBe(true);
  const row = await db('print_sales_orders').where({ id: a.id }).first();
  expect(row.render_status).toBe('ready');
  const image = await db('print_sales_assets').where({ order_id: a.id, kind: 'artwork', claim: row.claim }).first();
  const meta = await sharp(await require('../../src/services/printSales/orders').verified(storage, image)).metadata();
  expect(meta).toMatchObject({ format: 'jpeg', width: 100, height: 150, density: 100 }); expect(meta.icc).toBeTruthy();
  expect(await db('print_sales_assets').where({ order_id: a.id, kind: 'pack' }).first()).toBeTruthy();
});
test('payment before rendering holds files, then manual review/submission/dispatch records exact artwork', async () => {
  const a = await accepted(); await pay(a);
  await expect(fulfilment.download(a.id, admin, 'pack')).rejects.toThrow('not ready');
  await worker.runOne();
  const row = await fulfilment.order(a.id, admin), details = { artworkVersion: row.artwork_version };
  await expect(fulfilment.action(a.id, admin, { ...details, action: 'submit', supplierReference: 'LAB-001' })).rejects.toThrow('Check');
  await fulfilment.action(a.id, admin, { ...details, action: 'review' });
  const pack = await fulfilment.download(a.id, admin, 'pack'); expect(pack.subarray(0, 2).toString()).toBe('PK');
  await fulfilment.action(a.id, admin, { ...details, action: 'submit', supplierReference: 'LAB-001' });
  await fulfilment.action(a.id, admin, { ...details, action: 'dispatch', tracking: 'Test tracking' });
  expect(await fulfilment.order(a.id, admin)).toMatchObject({ status: 'dispatched', supplier_reference: 'LAB-001', tracking: 'Test tracking' });
});
test('rendering before payment and partial payments do not release supplier files', async () => {
  const a = await accepted(); await worker.runOne(); await pay(a, 1);
  await expect(fulfilment.download(a.id, admin, 'pack')).rejects.toThrow('fully settled');
  await pay(a, a.totalMinor - 1);
  await expect(fulfilment.download(a.id, admin, 'pack')).resolves.toBeInstanceOf(Buffer);
});
test('changing a production file holds release even when its byte length is unchanged', async () => {
  const a = await accepted(); await worker.runOne(); await pay(a);
  const file = await db('print_sales_assets').where({ order_id: a.id, kind: 'artwork' }).first();
  await storage.put(file.storage_key, Buffer.alloc(file.size));
  await expect(fulfilment.download(a.id, admin, 'pack')).rejects.toThrow('file changed');
});
test('editing the native invoice after acceptance holds fulfilment', async () => {
  const a = await accepted(); await worker.runOne(); await pay(a);
  await require('../../src/services/accountingHistory').auditedUpdate(db, 'invoice_line_items', { invoice_id: a.invoiceId }, { description: 'Changed product' }, { actor: admin.id, source: 'test.invoice.edit' });
  await expect(fulfilment.download(a.id, admin, 'pack')).rejects.toThrow('fully settled');
});
test('preparation failure preserves the paid invoice and requires controlled retry after three failures', async () => {
  const a = await accepted(); await pay(a);
  const source = await db('print_sales_assets').where({ order_id: a.id, kind: 'source' }).first();
  await storage.delete(source.storage_key);
  for (let n = 0; n < 3; n++) await worker.runOne();
  expect((await fulfilment.order(a.id, admin)).render_status).toBe('failed');
  expect((await db('invoices').where({ id: a.invoiceId }).first()).status).toBe('paid');
  await fulfilment.action(a.id, admin, { action: 'retry' });
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
  const a = await accepted();
  const results = await Promise.all([worker.runOne(), worker.runOne()]);
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(await db('print_sales_assets').where({ order_id: a.id, kind: 'pack' })).toHaveLength(1);
});
test('an interrupted older worker cannot publish over a newer attempt', async () => {
  const a = await accepted(); let entered, unblock;
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
  const a = await accepted();
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
  await expect(require('../../migrations/core/334_print_sales').down(db)).rejects.toThrow('destructive rollback');
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
    status: 'capturing', render_status: 'pending', created_at: new Date().toISOString(), expires_at: new Date().toISOString() });
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
