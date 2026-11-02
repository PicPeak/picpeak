'use strict';
const crypto = require('crypto');
const sheet = require('./sheet');
const zip = require('./pack');
const V = require('../albumProducts/validation');
const { parse } = require('./profiles');
const { verified } = require('./orders');
const { budgetOf, imageAllowance, QUOTE_TTL_MS } = require('./limits');
const { deadline } = require('./orders');
const { isTrue } = require('../../utils/galleryLifecycle');
const work = require('../activeApplicationWork');
const logger = require('../../utils/logger');
const now = () => new Date().toISOString();
const LEASE_MS = 5 * 60e3;
function createWorker({ db, storage, sharp, orders, heartbeatMs = 15000, leaseMs = LEASE_MS }) {
  /** Interrupted or failed attempts leave artwork no later release can use. */
  async function dropEarlierClaims(row) {
    const sourceIds = new Set((parse(row.snapshot)?.items || []).map(i => i.source?.assetId).filter(Boolean));
    const stale = await db('print_sales_assets').where({ order_id: row.id }).where(q => q.where(w => w.whereNotNull('claim').whereNot({ claim: row.claim }))
      .orWhere(w => w.where({ kind: 'source' }).whereNotIn('id', [...sourceIds])));
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
    let row = await db.transaction(async tx => {
      await tx('print_sales_settings').where({ id: 1 }).forUpdate().first();
      if (!isTrue((await tx('feature_flags').where({ key: 'printSales' }).first())?.value)) return null;
      const cutoff = new Date(Date.now() - leaseMs).toISOString();
      await tx('print_sales_orders').whereIn('status', ['capturing', 'quoted', 'accepted']).where({ render_status: 'running' })
        .where(q => q.where('heartbeat', '<', cutoff).orWhereNull('heartbeat'))
        .update({ render_status: 'queued', claim: null, error: 'Interrupted preparation recovered' });
      // Discard stops publication immediately, but the current image/upload may
      // still be finishing. Its live lease holds the single rendering slot.
      if (await tx('print_sales_orders').whereNotNull('claim').where('heartbeat', '>=', cutoff).first()) return null;
      // Repair of confirmed orders takes priority over new baskets.
      const next = await tx('print_sales_orders').whereIn('status', ['capturing', 'quoted', 'accepted'])
        .where({ render_status: 'queued' })
        .where(q => q.whereNotNull('accepted_at').orWhere('expires_at', '>', now()))
        .orderByRaw('CASE WHEN status = \'accepted\' THEN 0 ELSE 1 END').orderBy('created_at').first();
      if (!next) return null;
      if (next.attempts >= 3) {
        await tx('print_sales_orders').where({ id: next.id }).update({ render_status: 'failed', error: 'Preparation needs studio attention',
          ...(!next.accepted_at ? { status: 'failed', purge_requested: true } : {}) });
        return null;
      }
      const claim = crypto.randomUUID(), updates = { claim, render_status: 'running', heartbeat: now(), attempts: next.attempts + 1 };
      const changed = await tx('print_sales_orders').where({ id: next.id, render_status: next.render_status }).update(updates);
      return changed ? { ...next, ...updates } : null;
    });
    if (!row) return false;
    const controller = new AbortController(), signal = controller.signal, workDeadline = Date.now() + QUOTE_TTL_MS;
    let heartbeat = Promise.resolve(), lastLeaseAt = Date.now(), heartbeatFailed = false;
    const check = async () => {
      const current = await db('print_sales_orders').where({ id: row.id }).first();
      if (Date.now() >= workDeadline || !current || current.claim !== row.claim || current.render_status !== 'running' || !['capturing', 'quoted', 'accepted'].includes(current.status) ||
          (!current.accepted_at && new Date(current.expires_at).getTime() <= Date.now())) {
        controller.abort(Object.assign(new Error('Print preparation was cancelled or expired'), { statusCode: 409 }));
        return;
      }
      const renewedAt = Date.now();
      const changed = await db('print_sales_orders').where({ id: row.id, claim: row.claim, render_status: 'running' }).update({ heartbeat: new Date(renewedAt).toISOString() });
      if (!changed) controller.abort(Object.assign(new Error('Print preparation ownership changed'), { statusCode: 409 }));
      else { lastLeaseAt = renewedAt; heartbeatFailed = false; }
    };
    const timer = setInterval(() => {
      // A transient DB error must not waste an otherwise healthy render. Stop
      // before another worker can reclaim our lease, even if a DB call hangs.
      if (Date.now() >= workDeadline || Date.now() - lastLeaseAt >= leaseMs - Math.min(heartbeatMs, leaseMs / 2))
        controller.abort(Object.assign(new Error('Print preparation lease could not be maintained'), { statusCode: 503 }));
      heartbeat = heartbeat.then(() => { if (!signal.aborted) return check(); }).catch(error => {
        if (!heartbeatFailed) logger.warn('Print preparation heartbeat failed; retrying within its lease', { orderId: row.id, error: error.message });
        heartbeatFailed = true;
      });
    }, heartbeatMs);
    timer.unref();
    try {
      await dropEarlierClaims(row);
      if (V.hash(row.snapshot) !== row.snapshot_hash || !row.contact || V.hash(parse(row.contact)) !== parse(row.snapshot).contactHash)
        throw new Error('Frozen order identity changed or delivery was erased');
      if (row.status === 'capturing') row = await orders.capture(row, { signal });
      const s = parse(row.snapshot), contact = parse(row.contact), entries = [], budget = budgetOf(s); let outputBytes = 0;
      if (V.hash(row.snapshot) !== row.snapshot_hash || !contact || V.hash(contact) !== s.contactHash)
        throw new Error('Frozen order identity changed or delivery was erased');
      for (let n = 0; n < s.items.length; n++) {
        const item = s.items[n], source = await db('print_sales_assets').where({ id: item.source.assetId, order_id: row.id }).first();
        if (![1, 2].includes(item.profile.schemaVersion)) throw new Error('Unsupported frozen manufacturing profile version');
        if (!source || source.sha256 !== item.source.sha256) throw new Error('Retained original identity changed');
        const bytes = await verified(storage, source, { signal }), geometry = require('./domain').geometry(item.source, item);
        let raster = sharp(bytes, { signal }).rotate();
        if (item.fit === 'cover') raster = raster.extract({ left: geometry.left, top: geometry.top, width: geometry.width, height: geometry.height });
        const m = item.profile.manufacturing;
        raster = raster.resize(item.profile.artwork.widthPx, item.profile.artwork.heightPx,
          { fit: item.fit === 'contain' ? 'contain' : 'cover', background: m.background ?? '#ffffff' });
        // Version-one accepted profiles retain their original transparency behaviour.
        if (m.background !== undefined) raster = raster.flatten({ background: m.background });
        const encoded = await require('./output').encode(raster, m.output, m.resolution.targetDpi), image = encoded.bytes;
        if (m.output.profileSha256) require('./colourProfiles').verify(await sharp(image, { signal }).metadata(), m.output);
        outputBytes += image.length;
        if (outputBytes > budget.artworkBytes) throw Object.assign(new Error('Production artwork exceeds the reserved order space'), { statusCode: 400 });
        const thumbnail = await sharp(image, { signal }).resize(320, 320, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer();
        const asset = await orders.asset(row.id, 'artwork', image, row.claim, encoded.extension, { maxBytes: imageAllowance(item), signal });
        entries.push({ name: `${String(n + 1).padStart(3, '0')}.${encoded.extension}`, asset, thumbnail });
      }
      const report = await sheet(row, s, contact, entries);
      await orders.asset(row.id, 'sheet', report, row.claim, 'pdf', { signal });
      const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, orderId: row.id, selectionHash: row.snapshot_hash,
        invoiceId: row.invoice_id, shipping: s.shipping ?? null, items: s.items.map((i, n) => ({ file: entries[n].name, sha256: entries[n].asset.sha256,
          sourceFilename: i.source.filename, sourceSha256: i.source.sha256, quantity: i.quantity,
          crop: i.crop, fit: i.fit, profile: i.profile, invoiceLinePosition: i.linePosition })) }, null, 2));
      // The sheet carries the buyer's email and retail total: it stays with the studio.
      await orders.asset(row.id, 'pack', zip(entries, manifest, storage, { signal }), row.claim, 'zip', { maxBytes: budget.packBytes, signal });
      const assets = await db('print_sales_assets').where({ order_id: row.id, claim: row.claim }).orderBy('id');
      const version = V.hash(assets.map(a => ({ id: a.id, sha256: a.sha256, size: a.size })));
      signal.throwIfAborted();
      await db.transaction(async tx => {
        await tx('print_sales_settings').where({ id: 1 }).forUpdate().first();
        const current = await tx('print_sales_orders').where({ id: row.id }).forUpdate().first();
        signal.throwIfAborted();
        if ((!current.accepted_at && new Date(current.expires_at).getTime() <= Date.now()) || current.claim !== row.claim || current.render_status !== 'running' || !['capturing', 'quoted', 'accepted'].includes(current.status)) return;
        if (!current.accepted_at) {
          await orders.buyer(tx, current.event_id, current.customer_account_id);
          const event = await tx('events').where({ id: current.event_id }).first();
          await tx('print_sales_orders').where({ id: row.id }).update({ status: 'quoted', render_status: 'ready', artwork_version: version,
            expires_at: deadline(event), error: null });
        } else await tx('print_sales_orders').where({ id: row.id }).update({ render_status: 'ready', artwork_version: version, error: null });
      });
    } catch (error) {
      logger.warn('Print preparation failed', { orderId: row.id, error: error.message });
      const status = error.statusCode ?? error.status;
      const transient = error.code === 'IMAGE_WORKER_FAILED' || require('../imageResourcePolicy').isTransient(error);
      const terminal = !transient && status >= 400 && status < 500 || row.attempts >= 3;
      await db('print_sales_orders').where({ id: row.id, claim: row.claim, render_status: 'running' })
        .whereIn('status', ['capturing', 'quoted', 'accepted']).update({
          ...(!row.accepted_at && terminal ? { status: 'failed', purge_requested: true } : {}),
          render_status: terminal ? 'failed' : 'queued', error: 'Preparation could not finish; review a new basket or contact the studio' });
    } finally {
      clearInterval(timer); await heartbeat;
      await db('print_sales_orders').where({ id: row.id, claim: row.claim }).update({ heartbeat: null });
    }
    return true;
  }
  return { runOne: () => work.track('print artwork preparation', runOne) };
}
let timer, running, cleaning, stopped = true, lastTempSweep = 0;
function start() {
  if (!stopped) return;
  stopped = false;
  const tick = () => {
    if (stopped) return;
    const db = require('../../database/db').db, storage = require('../storage').getStorage();
    if (!running) running = (async () => {
      if (!await db.schema.hasTable('print_sales_orders')) return;
      await createWorker({ db, storage, sharp: require('../isolatedSharp'), orders: require('./orders').application() }).runOne();
    })().catch(error => logger.error('Print worker failed', { error: error.message })).finally(() => { running = null; });
    // Expiry and deletion must continue even during a long render.
    if (!cleaning) cleaning = (async () => {
      if (Date.now() - lastTempSweep > 60000) {
        lastTempSweep = Date.now();
        await work.track('print download cleanup', () => require('./files').sweepDownloads())
          .catch(error => logger.error('Print download cleanup failed', { error: error.message }));
        await work.track('print download status cleanup', () => require('./downloadStatus').createService(db).cleanup())
          .catch(error => logger.error('Print download status cleanup failed', { error: error.message }));
      }
      if (await db.schema.hasTable('print_sales_orders'))
        await work.track('print retention', () => require('./fulfilment').createService({ db, storage }).cleanup());
    })().catch(error => logger.error('Print retention failed', { error: error.message })).finally(() => { cleaning = null; });
  };
  timer = setInterval(tick, 10000); timer.unref();
}
async function stop() { stopped = true; clearInterval(timer); await Promise.all([running, cleaning]); }
module.exports = { createWorker, start, stop };
