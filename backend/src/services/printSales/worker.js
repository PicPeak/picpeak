'use strict';
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const archiver = require('archiver');
const V = require('../albumProducts/validation');
const { parse } = require('./profiles');
const { verified } = require('./orders');
const { isTrue } = require('../../utils/galleryLifecycle');
const work = require('../activeApplicationWork');
const now = () => new Date().toISOString();
const MAX_PACK_BYTES = 80 * 1024 * 1024;
async function zip(entries) {
  const archive = archiver('zip', { zlib: { level: 1 } }), chunks = []; let size = 0;
  const result = new Promise((resolve, reject) => {
    archive.on('data', c => { size += c.length; if (size > MAX_PACK_BYTES) archive.destroy(new Error('Supplier pack exceeds 80 MB')); else chunks.push(c); });
    archive.on('error', reject); archive.on('end', () => resolve(Buffer.concat(chunks)));
  });
  for (const entry of entries) archive.append(entry.bytes, { name: entry.name });
  archive.finalize().catch(() => {});
  return result;
}
function sheet(row, snapshot, contact, entries) {
  const pdf = new PDFDocument({ size: 'A4', margin: 40 }), chunks = [];
  const done = new Promise((resolve, reject) => { pdf.on('data', b => chunks.push(b)); pdf.on('end', () => resolve(Buffer.concat(chunks))); pdf.on('error', reject); });
  pdf.fontSize(18).text('Studio print order sheet');
  pdf.fontSize(10).text(`Order ${row.id}\nSelection ${row.snapshot_hash}\nInvoice ${row.invoice_id}`);
  pdf.moveDown().text('PRIVATE STUDIO CHECKLIST — verify settlement and exact files before manual lab submission.');
  pdf.moveDown().text(`Deliver to: ${Object.values(contact.delivery).filter(Boolean).join(', ')}\nBuyer: ${contact.buyerEmail}`);
  if (snapshot.shipping?.zoneName) pdf.text(`Delivery zone: ${snapshot.shipping.zoneName}`);
  pdf.text(`Retail total: ${snapshot.totalMinor} minor units (${snapshot.currency}); VAT ${snapshot.vatMinor}`);
  for (let n = 0; n < snapshot.items.length; n++) {
    const i = snapshot.items[n], p = i.profile, e = entries[n];
    pdf.addPage();
    pdf.fontSize(14).text(`${n + 1}. ${p.selection.product.name} — ${i.quantity} copies`);
    pdf.fontSize(10).text(`File: ${e.name}\nSource: ${i.source.filename}\nSource SHA-256: ${i.source.sha256}\nArtwork SHA-256: ${V.hash(e.bytes)}`);
    pdf.text(`Trim: ${p.manufacturing.trimMm.width} × ${p.manufacturing.trimMm.height} mm\nArtwork: ${p.artwork.widthMm} × ${p.artwork.heightMm} mm\nBleed (top/right/bottom/left): ${Object.values(p.manufacturing.bleedMm).join('/')} mm\nProfile: ${p.id} revision ${p.revision}\nLab reference: ${p.labReference || '(not provided)'}`);
    pdf.text(p.selection.attributes.map(a => `${a.name}: ${a.options.map(o => o.name).join(', ')}`).join('\n'));
    pdf.text(`Supplier: ${p.supplierName || '(studio configured)'}\nOutput: sRGB ${p.manufacturing.output.format.toUpperCase()}. Single rectangular face; no wrapping, folds or imposition.`);
    if (p.instructions) pdf.moveDown().text(`Supplier instructions:\n${p.instructions}`);
    if (pdf.y + 270 > pdf.page.height - pdf.page.margins.bottom) pdf.addPage();
    pdf.image(e.thumbnail, { fit: [250, 250] });
    pdf.moveDown().text('[ ] Correct file, crop, product, finish and quantities\n[ ] Delivery and actual lab destination checked\nLab reference / operator notes: ______________________________');
  }
  pdf.end(); return done;
}
function createWorker({ db, storage, sharp, orders }) {
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
        outputBytes += image.length;
        if (outputBytes > 64 * 1024 * 1024) throw new Error('Production artwork exceeds the 64 MB order limit');
        const thumbnail = await sharp(image).resize(320, 320, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer();
        const asset = await orders.asset(row.id, 'artwork', image, row.claim, encoded.extension);
        entries.push({ name: `${String(n + 1).padStart(3, '0')}.${encoded.extension}`, bytes: image, thumbnail, assetId: asset.id });
      }
      const report = await sheet(row, s, contact, entries);
      await orders.asset(row.id, 'sheet', report, row.claim, 'pdf');
      const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, orderId: row.id, selectionHash: row.snapshot_hash,
        invoiceId: row.invoice_id, shipping: s.shipping ?? null, items: s.items.map((i, n) => ({ file: entries[n].name, sha256: V.hash(entries[n].bytes),
          sourceFilename: i.source.filename, sourceSha256: i.source.sha256, quantity: i.quantity,
          crop: i.crop, fit: i.fit, profile: i.profile, invoiceLinePosition: i.linePosition })) }, null, 2));
      const pack = await zip([...entries, { name: 'manifest.json', bytes: manifest }, { name: 'order-sheet.pdf', bytes: report }]);
      await orders.asset(row.id, 'pack', pack, row.claim, 'zip');
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
    })().catch(error => require('../../utils/logger').error('Print worker failed', { error: error.message }))
      .finally(() => { running = null; });
  };
  timer = setInterval(tick, 10000); timer.unref();
}
async function stop() { stopped = true; clearInterval(timer); if (running) await running; }
module.exports = { createWorker, start, stop };
