'use strict';
const crypto = require('crypto');
const sheet = require('./sheet');
const zip = require('./pack');
const V = require('../albumProducts/validation');
const { parse } = require('./profiles');
const { verified } = require('./orders');
const { MAX_ORDER_ARTWORK_BYTES } = require('./output');
const { isTrue } = require('../../utils/galleryLifecycle');
const work = require('../activeApplicationWork');
const logger = require('../../utils/logger');
const now = () => new Date().toISOString();
function createWorker({ db, storage, sharp, orders }) {
  /** Interrupted or failed attempts leave artwork no later release can use. */
  async function dropEarlierClaims(row) {
    const stale = await db('print_sales_assets').where({ order_id: row.id }).whereNotNull('claim').whereNot({ claim: row.claim });
    for (const a of stale) {
      try {
        await storage.delete(a.storage_key);
        await db('print_sales_assets').where({ id: a.id }).del();
      } catch (error) {
        // The purge retries it; preparation must not depend on the tidy-up.
        logger.error('Print asset cleanup failed', { orderId: row.id, assetId: a.id, error: error.message });
      }
    }
  }
  async function runOne() {
    const row = await db.transaction(async tx => {
      await tx('print_sales_settings').where({ id: 1 }).forUpdate().first();
      if (!isTrue((await tx('feature_flags').where({ key: 'printSales' }).first())?.value)) return null;
      const cutoff = new Date(Date.now() - 5 * 60e3).toISOString();
      await tx('print_sales_orders').where({ status: 'accepted', render_status: 'running' }).where('heartbeat', '<', cutoff)
        .update({ render_status: 'queued', claim: null, error: 'Interrupted preparation recovered' });
      if (await tx('print_sales_orders').where({ render_status: 'running' }).first()) return null;
      const next = await tx('print_sales_orders').where({ status: 'accepted', render_status: 'queued' }).orderBy('created_at').first();
      if (!next) return null;
      if (next.attempts >= 3) {
        await tx('print_sales_orders').where({ id: next.id }).update({ render_status: 'failed', error: 'Preparation needs studio attention' });
        return null;
      }
      const claim = crypto.randomUUID(), updates = { claim, render_status: 'running', heartbeat: now(), attempts: next.attempts + 1 };
      const changed = await tx('print_sales_orders').where({ id: next.id, render_status: 'queued' }).update(updates);
      return changed ? { ...next, ...updates } : null;
    });
    if (!row) return false;
    let heartbeat = Promise.resolve();
    const timer = setInterval(() => { heartbeat = heartbeat.then(() => db('print_sales_orders')
      .where({ id: row.id, claim: row.claim, render_status: 'running' }).update({ heartbeat: now() })).catch(() => {}); }, 15000);
    timer.unref();
    try {
      await dropEarlierClaims(row);
      const s = parse(row.snapshot), contact = parse(row.contact), entries = []; let outputBytes = 0;
      if (V.hash(row.snapshot) !== row.snapshot_hash || !contact || V.hash(contact) !== s.contactHash)
        throw new Error('Frozen order identity changed or delivery was erased');
      for (let n = 0; n < s.items.length; n++) {
        const item = s.items[n], source = await db('print_sales_assets').where({ id: item.source.assetId, order_id: row.id }).first();
        if (![1, 2].includes(item.profile.schemaVersion)) throw new Error('Unsupported frozen manufacturing profile version');
        if (!source || source.sha256 !== item.source.sha256) throw new Error('Retained original identity changed');
        const bytes = await verified(storage, source), geometry = require('./domain').geometry(item.source, item);
        let raster = sharp(bytes).rotate();
        if (item.fit === 'cover') raster = raster.extract({ left: geometry.left, top: geometry.top, width: geometry.width, height: geometry.height });
        const m = item.profile.manufacturing;
        raster = raster.resize(item.profile.artwork.widthPx, item.profile.artwork.heightPx,
          { fit: item.fit === 'contain' ? 'contain' : 'cover', background: m.background ?? '#ffffff' });
        // Version-one accepted profiles retain their original transparency behaviour.
        if (m.background !== undefined) raster = raster.flatten({ background: m.background });
        const encoded = await require('./output').encode(raster, m.output, m.resolution.targetDpi), image = encoded.bytes;
        if (m.output.profileSha256) require('./colourProfiles').verify(await sharp(image).metadata(), m.output);
        outputBytes += image.length;
        if (outputBytes > MAX_ORDER_ARTWORK_BYTES) throw new Error('Production artwork exceeds the 64 MB order limit');
        const thumbnail = await sharp(image).resize(320, 320, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer();
        const asset = await orders.asset(row.id, 'artwork', image, row.claim, encoded.extension);
        entries.push({ name: `${String(n + 1).padStart(3, '0')}.${encoded.extension}`, asset, thumbnail });
      }
      const report = await sheet(row, s, contact, entries);
      await orders.asset(row.id, 'sheet', report, row.claim, 'pdf');
      const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, orderId: row.id, selectionHash: row.snapshot_hash,
        invoiceId: row.invoice_id, shipping: s.shipping ?? null, items: s.items.map((i, n) => ({ file: entries[n].name, sha256: entries[n].asset.sha256,
          sourceFilename: i.source.filename, sourceSha256: i.source.sha256, quantity: i.quantity,
          crop: i.crop, fit: i.fit, profile: i.profile, invoiceLinePosition: i.linePosition })) }, null, 2));
      // The sheet carries the buyer's email and retail total: it stays with the studio.
      await orders.asset(row.id, 'pack', zip(entries, manifest, storage), row.claim, 'zip');
      const assets = await db('print_sales_assets').where({ order_id: row.id, claim: row.claim }).orderBy('id');
      const version = V.hash(assets.map(a => ({ id: a.id, sha256: a.sha256, size: a.size })));
      await db('print_sales_orders').where({ id: row.id, claim: row.claim, status: 'accepted', render_status: 'running' })
        .update({ render_status: 'ready', artwork_version: version, error: null });
    } catch (error) {
      await db('print_sales_orders').where({ id: row.id, claim: row.claim, status: 'accepted', render_status: 'running' })
        .update({ render_status: row.attempts < 3 ? 'queued' : 'failed', error: String(error.message).slice(0, 300) });
    } finally { clearInterval(timer); await heartbeat; }
    return true;
  }
  return { runOne: () => work.track('print artwork preparation', runOne) };
}
let timer, running, stopped = true;
function start() {
  if (!stopped) return;
  stopped = false;
  const tick = () => {
    if (stopped || running) return;
    running = (async () => {
      const db = require('../../database/db').db, storage = require('../storage').getStorage();
      if (!await db.schema.hasTable('print_sales_orders')) return;
      await createWorker({ db, storage, sharp: require('../isolatedSharp'), orders: require('./orders').application() }).runOne();
      await work.track('print retention', () => require('./fulfilment').createService({ db, storage }).cleanup());
    })().catch(error => logger.error('Print worker failed', { error: error.message }))
      .finally(() => { running = null; });
  };
  timer = setInterval(tick, 10000); timer.unref();
}
async function stop() { stopped = true; clearInterval(timer); if (running) await running; }
module.exports = { createWorker, start, stop };
