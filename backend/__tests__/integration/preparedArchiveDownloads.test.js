const crypto = require('crypto');
const path = require('path');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const StreamZip = require('node-stream-zip');
const { bootCrmDb } = require('./helpers/crmDb');

process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');

describe('native prepared archive downloads (#1966)', () => {
  let db; let cleanup; let app; let jobs; let storage;
  let sequence = 0;
  const idOf = (rows) => rows[0]?.id ?? rows[0];
  const token = (event, extra = {}) => jwt.sign({
    type: 'gallery', eventId: event.id, eventSlug: event.slug, ...extra,
  }, process.env.JWT_SECRET, { issuer: 'picpeak-auth', expiresIn: '1h' });
  const api = (event, method, suffix, extra) => request(app)[method](`/api/gallery/${event.slug}/${suffix}`)
    .set('Authorization', `Bearer ${token(event, extra)}`);
  const client = { accessLevel: 'client' };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    storage = require('../../src/services/storage').getStorage();
    jobs = require('../../src/services/downloadJobService');
    app = express(); app.use(express.json());
    app.use('/api/gallery', require('../../src/routes/gallery'));
  });
  afterAll(async () => {
    if (jobs) await Promise.all(jobs.liveBuilds.values());
    if (cleanup) await cleanup();
  });

  async function fixture(overrides = {}, count = 3) {
    const slug = `prepared-archive-${++sequence}`;
    const id = idOf(await db('events').insert({
      slug, event_type: 'wedding', event_name: slug, event_date: '2026-08-01',
      host_email: 'host@example.test', password_hash: crypto.randomBytes(32).toString('hex'),
      share_link: `/gallery/${slug}/share`, share_token: crypto.randomBytes(24).toString('hex'),
      expires_at: new Date(Date.now() + 864e5).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, allow_downloads: 1,
      download_standard_resolution: 'original', download_resolution_picker_enabled: 0,
      created_at: new Date().toISOString(), ...overrides,
    }).returning('id'));
    const ids = [];
    for (let i = 0; i < count; i += 1) {
      const filename = `photo-${i}.jpg`;
      const key = `events/active/${slug}/individual/${filename}`;
      const preview = `previews/preview_${slug}-${i}.jpg`;
      const image = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#689abc' } }).jpeg().toBuffer();
      await storage.put(key, image);
      await storage.put(preview, await sharp(image).resize(800, 600).jpeg().toBuffer());
      ids.push(idOf(await db('photos').insert({
        event_id: id, filename, path: key, preview_path: preview, type: 'individual',
        media_type: 'image', mime_type: 'image/jpeg', size_bytes: image.length,
        source_origin: 'managed', uploaded_at: new Date(Date.now() - i * 1000).toISOString(),
      }).returning('id')));
    }
    return { event: await db('events').where({ id }).first(), ids };
  }

  async function prepare(event, body = {}, extra) {
    const created = await api(event, 'post', 'download-jobs', extra).send(body);
    expect(created.status).toBe(202);
    const job = await jobs.getStatus(created.body.token);
    await jobs.liveBuilds.get(job.id);
    const ready = await jobs.getStatus(job.token);
    expect(ready.status).toBe('ready');
    return ready;
  }
  async function entries(job) {
    const zip = new StreamZip.async({ file: path.join(process.env.STORAGE_PATH, job.zip_path) });
    try {
      const result = [];
      for (const entry of Object.values(await zip.entries())) result.push(await zip.entryData(entry.name));
      return result;
    } finally { await zip.close(); }
  }
  const grants = (event) => db('event_download_grants').where({ event_id: event.id });

  it('builds the server standard with the picker off, deduplicates, and returns a native file', async () => {
    const { event, ids } = await fixture();
    const job = await prepare(event, { photo_ids: ids.slice(0, 2) });
    expect(JSON.parse(job.delivered_photo_ids)).toEqual(ids.slice(0, 2));
    expect(await entries(job)).toHaveLength(2);
    expect(JSON.parse(job.entry_manifest)).toEqual([
      expect.objectContaining({ photoId: ids[0], start: 0 }),
      expect.objectContaining({ photoId: ids[1] }),
    ]);
    expect((await prepare(event, { photo_ids: ids.slice(0, 2) })).token).toBe(job.token);
    const file = await api(event, 'get', `download-jobs/${job.token}/file`);
    expect(file.status).toBe(200);
    expect(Number(file.headers['content-length'])).toBe(Number(job.size_bytes));
    expect(file.headers['content-type']).toBe('application/zip');
    const part = await api(event, 'head', `download-jobs/${job.token}/file?part=1&parts=2`);
    expect(part.headers['content-disposition']).toContain(`${event.slug}-selected-1-of-2.zip`);
    expect((await api(event, 'post', 'download-jobs').send({ resolution: 'original' })).status).toBe(400);
  });

  it.each([[], null, 'all', [0], ['1x'], [2147483648]])('refuses invalid selection %p instead of preparing all', async (photo_ids) => {
    const { event } = await fixture();
    expect((await api(event, 'post', 'download-jobs').send({ photo_ids })).status).toBe(400);
    expect(await db('download_jobs').where({ event_id: event.id })).toHaveLength(0);
  });

  it('does not charge preparation, polling, HEAD or repeat downloads', async () => {
    const { event, ids } = await fixture({ download_limit: 3 });
    const job = await prepare(event, {}, client);
    expect(await grants(event)).toHaveLength(0);
    expect((await api(event, 'get', `download-jobs/${job.token}`, client)).body.unavailable).toBeUndefined();
    expect((await api(event, 'head', `download-jobs/${job.token}/file`, client)).status).toBe(200);
    expect(await grants(event)).toHaveLength(0);
    for (let i = 0; i < 2; i += 1) {
      expect((await api(event, 'get', `download-jobs/${job.token}/file`, client)).status).toBe(200);
    }
    expect((await grants(event)).map((r) => r.photo_id).sort()).toEqual(ids.sort());
  });

  it('reserves disjoint sets atomically when two native downloads race', async () => {
    const { event, ids } = await fixture({ download_limit: 5 }, 8);
    const first = await prepare(event, { photo_ids: ids.slice(0, 4) }, client);
    const second = await prepare(event, { photo_ids: ids.slice(4) }, client);
    const files = await Promise.all([first, second].map((job) =>
      api(event, 'get', `download-jobs/${job.token}/file`, client)));
    expect(files.map((res) => res.status).sort()).toEqual([200, 403]);
    expect(await grants(event)).toHaveLength(4);
  });

  it('charges a partly transferred entry and releases entries that never started', async () => {
    const { event, ids } = await fixture({ download_limit: 3 });
    const first = await db('photos').where({ id: ids[0] }).first();
    await storage.put(first.path, Buffer.alloc(8 * 1024 * 1024, 87));
    const job = await prepare(event, {}, client);
    const server = app.listen(0, '127.0.0.1');
    await require('events').once(server, 'listening');
    try {
      await new Promise((resolve, reject) => {
        const req = require('http').get({
          host: '127.0.0.1', port: server.address().port,
          path: `/api/gallery/${event.slug}/download-jobs/${job.token}/file`,
          headers: { Authorization: `Bearer ${token(event, client)}` },
        }, (res) => {
          if (res.statusCode !== 200) {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => reject(new Error(`Download refused: ${res.statusCode} ${body}`)));
            return;
          }
          res.once('data', () => { res.destroy(); req.destroy(); resolve(); });
          res.on('error', () => {});
        });
        req.on('error', reject);
      });
      let rows;
      for (let i = 0; i < 200; i += 1) {
        rows = await grants(event);
        if (rows.length === 1 && Number(rows[0].pending_holders) === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(rows.map((row) => row.photo_id)).toEqual([ids[0]]);
      expect(Number(rows[0].pending_holders)).toBe(0);
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });

  it('refuses a corrupt entry manifest before reserving allowance', async () => {
    const { event } = await fixture({ download_limit: 3 });
    const job = await prepare(event, {}, client);
    await db('download_jobs').where({ id: job.id }).update({ entry_manifest: '[]' });
    expect((await api(event, 'get', `download-jobs/${job.token}/file`, client)).status).toBe(409);
    expect(await grants(event)).toHaveLength(0);
  });

  it('never lets a quota guest collect a portal original job in the same public scope', async () => {
    const { event } = await fixture({ download_limit: 3 });
    const customerId = idOf(await db('customer_accounts').insert({
      email: `archive-customer-${sequence}@example.test`, is_active: 1,
      password_hash: crypto.randomBytes(32).toString('hex'),
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).returning('id'));
    await db('event_customer_assignments').insert({ event_id: event.id, customer_account_id: customerId });
    const portal = { via: 'customer', customerId };
    const job = await prepare(event, {}, portal);
    expect(job.visibility_scope).toBe('public');
    expect((await api(event, 'get', `download-jobs/${job.token}`)).body.unavailable).toBe(true);
    expect((await api(event, 'get', `download-jobs/${job.token}/file`)).status).toBe(403);
    expect(await grants(event)).toHaveLength(0);
    expect((await api(event, 'get', `download-jobs/${job.token}/file`, portal)).status).toBe(200);
    expect(await grants(event)).toHaveLength(3);
  });

  it('reports a vanished archive before offering the native download', async () => {
    const { event } = await fixture();
    const job = await prepare(event);
    await storage.delete(job.zip_path);
    expect((await api(event, 'get', `download-jobs/${job.token}`)).body.unavailable).toBe(true);
    expect((await api(event, 'get', `download-jobs/${job.token}/file`)).status).toBe(410);
  });

  it('fails a lost worker once its lease expires after startup', async () => {
    const { event } = await fixture();
    const job = await prepare(event);
    await db('download_jobs').where({ id: job.id }).update({
      status: 'building', heartbeat_at: new Date(Date.now() - 6 * 60e3).toISOString(),
    });
    expect((await api(event, 'get', `download-jobs/${job.token}`)).body.status).toBe('failed');
  });

  it('fails an output write error without leaving its build slot occupied', async () => {
    const { event } = await fixture();
    const fs = require('fs');
    const realWrite = fs.createWriteStream;
    const write = jest.spyOn(fs, 'createWriteStream').mockImplementation((file, ...args) => {
      if (!String(file).endsWith('.zip')) return realWrite(file, ...args);
      const output = new (require('stream').PassThrough)();
      setImmediate(() => output.destroy(Object.assign(new Error('Synthetic disk full'), { code: 'ENOSPC' })));
      return output;
    });
    try {
      const created = await api(event, 'post', 'download-jobs').send({});
      const job = await jobs.getStatus(created.body.token);
      await jobs.liveBuilds.get(job.id);
      expect((await jobs.getStatus(job.token)).status).toBe('failed');
      expect(jobs.liveBuilds.has(job.id)).toBe(false);
      expect(jobs.running).toBe(0);
    } finally { write.mockRestore(); }
  });

  it('separates quota guest previews from client originals and skips videos', async () => {
    const { event, ids } = await fixture({ download_limit: 3 });
    await db('photos').where({ id: ids[2] }).update({ media_type: 'video', mime_type: 'video/mp4' });
    const preview = await prepare(event);
    const original = await prepare(event, {}, client);
    expect(preview.token).not.toBe(original.token);
    expect(JSON.parse(preview.delivered_photo_ids)).toEqual(ids.slice(0, 2));
    for (const bytes of await entries(preview)) expect((await sharp(bytes).metadata()).width).toBe(800);
    const file = await api(event, 'get', `download-jobs/${preview.token}/file`);
    expect(file.status).toBe(200);
    expect(file.headers['content-disposition']).toContain(`${event.slug}-previews.zip`);
    expect((await api(event, 'get', `download-jobs/${original.token}/file`)).status).toBe(404);
    expect(await grants(event)).toHaveLength(0);
  });

  it('keeps priced archives on the preview path assumed from #2233, including quota guests', async () => {
    const { event, ids } = await fixture({ download_limit: 3, is_priced: 1 });
    const job = await prepare(event);
    const content = await entries(job);
    expect(content).toHaveLength(3);
    for (const bytes of content) expect((await sharp(bytes).metadata()).width).toBe(800);
    await db('events').where({ id: event.id }).update({ watermark_text: 'Updated studio watermark' });
    expect((await api(event, 'get', `download-jobs/${job.token}`)).body.unavailable).toBe(true);
    // No original substitutes for a missing preview.
    const photo = await db('photos').where({ id: ids[0] }).first();
    await storage.delete(photo.preview_path);
    await storage.delete(photo.path);
    const created = await api(event, 'post', 'download-jobs').send({ photo_ids: [ids[0]] });
    const missing = await jobs.getStatus(created.body.token);
    await jobs.liveBuilds.get(missing.id);
    expect((await jobs.getStatus(missing.token)).status).toBe('failed');
  });

  it.each([
    ['resolution', { download_standard_resolution: '800x600' }],
    ['pricing', { is_priced: 1 }],
    ['downloads', { allow_downloads: 0 }],
  ])('refuses a ready archive after changing %s', async (_label, change) => {
    const { event } = await fixture();
    const job = await prepare(event);
    await db('events').where({ id: event.id }).update(change);
    const status = await api(event, 'get', `download-jobs/${job.token}`);
    expect(status.body.unavailable).toBe(true);
    expect((await api(event, 'get', `download-jobs/${job.token}/file`)).status).toBeGreaterThanOrEqual(400);
  });

  it('protects live builds past their initial retention and gives a finished job its full retention', async () => {
    const { event } = await fixture();
    const realPut = storage.putFromFile.bind(storage);
    let proceed; let entered;
    const held = new Promise((resolve) => { proceed = resolve; });
    const reached = new Promise((resolve) => { entered = resolve; });
    const spy = jest.spyOn(storage, 'putFromFile').mockImplementation(async (...args) => {
      entered(); await held; return realPut(...args);
    });
    try {
      const created = await api(event, 'post', 'download-jobs').send({});
      const job = await jobs.getStatus(created.body.token);
      await reached;
      await db('download_jobs').where({ id: job.id }).update({ expires_at: new Date(Date.now() - 1000).toISOString() });
      await jobs.sweepExpired();
      expect(await jobs.getStatus(job.token)).toBeDefined();
      expect((await api(event, 'post', 'download-jobs').send({})).body.token).toBe(job.token);
      proceed(); await jobs.liveBuilds.get(job.id);
      const ready = await jobs.getStatus(job.token);
      expect(Date.parse(ready.expires_at)).toBeGreaterThan(Date.now() + 3590e3);
    } finally { proceed(); spy.mockRestore(); }
  });
});
