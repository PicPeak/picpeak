/**
 * The external_scan.completed webhook (issue 2357).
 *
 * One delivery per finished pass of a gallery's external folder, whatever
 * started it, listing what the pass changed. A pass that changed nothing, or
 * did not finish, sends nothing.
 *
 * Driven through the real import pass against real files, with the real
 * webhookService writing webhook_deliveries.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const request = require('supertest');
const sharp = require('sharp');

describe('external_scan.completed webhook', () => {
  let tmpDir; let db; let app; let mediaRoot; let webhookId;
  let importExternalFolder; let MAX_SCAN_WEBHOOK_ENTRIES; let jobNameFor;
  let jobState; let watcher; let webhookService; let externalAccess; let generateThumbnail;

  const writeJpeg = async (rel, color = { r: 10, g: 20, b: 30 }) => {
    const full = path.join(mediaRoot, rel);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await sharp({ create: { width: 24, height: 16, channels: 3, background: color } })
      .withExif({ IFD2: { DateTimeOriginal: '2026:06:01 10:00:00' } })
      .jpeg().toFile(full);
    const old = new Date(Date.now() - 600000);
    await fs.promises.utimes(full, old, old);
  };

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-extscan-'));
    mediaRoot = path.join(tmpDir, 'media');
    await fs.promises.mkdir(mediaRoot, { recursive: true });

    process.env.NODE_ENV = 'test';
    process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'data', 'db.sqlite');
    await fs.promises.mkdir(path.dirname(process.env.TEST_DATABASE_PATH), { recursive: true });
    process.env.EXTERNAL_MEDIA_ROOT = mediaRoot;
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'extscan-secret';
    process.env.EXTERNAL_MEDIA_WATCH_STABILITY_MS = '0';

    jest.resetModules();
    jest.doMock('../../src/middleware/auth', () => ({
      adminAuth: (req, _res, next) => { req.admin = { id: 1, username: 'tester', roleName: 'admin' }; next(); },
    }));
    jest.doMock('../../src/middleware/permissions', () => ({
      ...jest.requireActual('../../src/middleware/permissions'),
      requirePermission: () => (_req, _res, next) => next(),
    }));
    jest.doMock('../../src/middleware/ownership', () => ({
      ...jest.requireActual('../../src/middleware/ownership'),
      requireEventOwnership: (_req, _res, next) => next(),
    }));
    jest.doMock('../../src/services/imageProcessor', () => {
      const actual = jest.requireActual('../../src/services/imageProcessor');
      return {
        ...actual,
        generateThumbnail: jest.fn(async (_src, { outputBasename }) => `thumbnails/thumb_${outputBasename}`),
        ensureThumbnail: jest.fn(),
      };
    });
    jest.doMock('../../src/utils/logger', () => ({
      debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    }));

    ({ db } = await require('./helpers/crmDb').bootCrmDb());
    await require('./helpers/externalMediaFixture').seedExternalAdminFixture(db);
    ({ importExternalFolder, MAX_SCAN_WEBHOOK_ENTRIES, jobNameFor } = require('../../src/services/externalImportService'));
    jobState = require('../../src/services/maintenanceJobState');
    watcher = require('../../src/services/externalMediaWatcher');
    webhookService = require('../../src/services/webhookService');
    externalAccess = require('../../src/services/externalMediaAccess');
    ({ generateThumbnail } = require('../../src/services/imageProcessor'));

    app = express();
    app.use(express.json());
    app.use('/api/admin/external-media', require('../../src/routes/adminExternalMedia'));
  }, 180000);

  afterAll(async () => {
    if (db) await db.destroy?.();
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  async function seedEvent({ subscribed = ['external_scan.completed'] } = {}) {
    await db('webhook_deliveries').del();
    await db('webhooks').del();
    await db('photos').del();
    await db('external_import_exclusions').del();
    await db('events').del();
    await fs.promises.rm(mediaRoot, { recursive: true, force: true });
    await fs.promises.mkdir(mediaRoot, { recursive: true });
    const [w] = await db('webhooks').insert({
      name: 'scan', url: 'https://receiver.example.com/', secret: 'whsec_x', secret_preview: 'x',
      events: JSON.stringify(subscribed), active: true, created_by: 1,
    }).returning('id');
    webhookId = typeof w === 'object' ? w.id : w;
    const [e] = await db('events').insert({
      slug: `extscan-${Math.random().toString(36).slice(2, 8)}`,
      event_type: 'wedding', event_name: 'extscan', event_date: '2026-01-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: `extscan-${Math.random()}`, expires_at: new Date().toISOString(),
      source_mode: 'reference', external_path: 'shoot', external_watch: true, created_by: 1,
    }).returning('id');
    return typeof e === 'object' ? e.id : e;
  }

  const scan = (eventId) => importExternalFolder({
    eventId, externalPath: 'shoot', recursive: true, actor: { type: 'admin', id: 1 },
  });
  const deliveries = async () => {
    const rows = await db('webhook_deliveries').where({ webhook_id: webhookId, event_type: 'external_scan.completed' }).orderBy('id');
    return rows.map((r) => (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload));
  };
  const photoId = async (eventId, relpath) => (await db('photos').where({ event_id: eventId, external_relpath: relpath }).first()).id;

  it('delivers what an import brought in, in the usual envelope, without the host path', async () => {
    const eventId = await seedEvent();
    await writeJpeg('shoot/a.jpg');
    await writeJpeg('shoot/sub/b.jpg', { r: 200, g: 10, b: 10 });

    await scan(eventId);

    const sent = await deliveries();
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('external_scan.completed');
    expect(sent[0].id).toEqual(expect.any(String));
    const { data } = sent[0];
    expect(data).toMatchObject({
      event_id: eventId, source: 'shoot', trigger: 'manual', moved: [], missing: [],
      counts: { imported: 2, moved: 0, missing: 0, returned: 0, refreshed: 0 }, truncated: false,
    });
    expect(data.imported).toEqual(expect.arrayContaining([
      { photo_id: await photoId(eventId, 'shoot/a.jpg'), relpath: 'shoot/a.jpg' },
      { photo_id: await photoId(eventId, 'shoot/sub/b.jpg'), relpath: 'shoot/sub/b.jpg' },
    ]));
    expect(new Date(data.finished_at).toISOString()).toBe(data.finished_at);
    expect(JSON.stringify(sent[0])).not.toContain(mediaRoot);
  });

  it('stays off for a webhook not subscribed to it', async () => {
    const eventId = await seedEvent({ subscribed: ['event.published'] });
    await writeJpeg('shoot/a.jpg');
    const fire = jest.spyOn(webhookService, 'fire');

    expect(await scan(eventId)).toMatchObject({ imported: 1 });

    // The pass announced itself; nobody listens.
    expect(fire).toHaveBeenCalledTimes(1);
    fire.mockRestore();
    expect(await db('webhook_deliveries')).toHaveLength(0);
  });

  it('sends nothing for a pass that changed nothing, by any trigger', async () => {
    const eventId = await seedEvent();
    await writeJpeg('shoot/a.jpg');
    await scan(eventId);
    expect(await deliveries()).toHaveLength(1);

    await scan(eventId);
    await watcher.runImport(eventId, 'sweep');
    await watcher.runImport(eventId, 'change');

    expect(await deliveries()).toHaveLength(1);
  });

  it('lists a vanished file once, not on every later pass, and counts its return', async () => {
    const eventId = await seedEvent();
    await writeJpeg('shoot/a.jpg');
    await writeJpeg('shoot/b.jpg', { r: 200, g: 10, b: 10 });
    await scan(eventId);
    const id = await photoId(eventId, 'shoot/a.jpg');
    const kept = path.join(tmpDir, 'kept.jpg');
    await fs.promises.rename(path.join(mediaRoot, 'shoot/a.jpg'), kept);

    await scan(eventId);
    await scan(eventId);

    let sent = await deliveries();
    expect(sent).toHaveLength(2);
    expect(sent[1].data).toMatchObject({
      imported: [], moved: [], missing: [{ photo_id: id, relpath: 'shoot/a.jpg' }],
      counts: { imported: 0, moved: 0, missing: 1, returned: 0 },
    });

    await fs.promises.rename(kept, path.join(mediaRoot, 'shoot/a.jpg'));
    await scan(eventId);

    sent = await deliveries();
    expect(sent).toHaveLength(3);
    expect(sent[2].data).toMatchObject({ imported: [], moved: [], missing: [], counts: { returned: 1 } });
  });

  it('lists a renamed file as moved, not as missing plus imported', async () => {
    const eventId = await seedEvent();
    await writeJpeg('shoot/a.jpg');
    await writeJpeg('shoot/b.jpg', { r: 200, g: 10, b: 10 });
    await scan(eventId);
    const id = await photoId(eventId, 'shoot/a.jpg');
    await fs.promises.mkdir(path.join(mediaRoot, 'shoot/sorted'));
    await fs.promises.rename(path.join(mediaRoot, 'shoot/a.jpg'), path.join(mediaRoot, 'shoot/sorted/a2.jpg'));

    await scan(eventId);

    const sent = await deliveries();
    expect(sent).toHaveLength(2);
    expect(sent[1].data).toMatchObject({
      imported: [], missing: [], moved: [{ photo_id: id, from: 'shoot/a.jpg', to: 'shoot/sorted/a2.jpg' }],
      counts: { imported: 0, moved: 1, missing: 0 },
    });
  });

  it('names what started the pass, through each path into the import', async () => {
    const triggerOf = async (run) => {
      const eventId = await seedEvent();
      await writeJpeg('shoot/a.jpg');
      await run(eventId);
      const sent = await deliveries();
      expect(sent).toHaveLength(1);
      return sent[0].data.trigger;
    };

    expect(await triggerOf((id) => watcher.runImport(id, 'change'))).toBe('watch');
    expect(await triggerOf((id) => watcher.runImport(id, 'sweep'))).toBe('sweep');
    expect(await triggerOf((id) => watcher.runImport(id, 'start'))).toBe('sweep');
    expect(await triggerOf(async (id) => {
      await request(app).post(`/api/admin/external-media/events/${id}/import-external`).send({}).expect(200);
    })).toBe('manual');
  });

  it('caps each list and keeps the true counts', async () => {
    const eventId = await seedEvent();
    const total = MAX_SCAN_WEBHOOK_ENTRIES + 5;
    for (let i = 0; i < total; i += 1) await writeJpeg(`shoot/${String(i).padStart(4, '0')}.jpg`);

    expect(await scan(eventId)).toMatchObject({ imported: total });

    const [{ data }] = await deliveries();
    expect(data.imported).toHaveLength(MAX_SCAN_WEBHOOK_ENTRIES);
    expect(data.counts.imported).toBe(total);
    expect(data.truncated).toBe(true);
  }, 120000);

  it('never lets a failing webhook touch the scan', async () => {
    const eventId = await seedEvent();
    await writeJpeg('shoot/a.jpg');
    const fire = jest.spyOn(webhookService, 'fire').mockRejectedValueOnce(new Error('receiver gone'));

    expect(await scan(eventId)).toMatchObject({ imported: 1 });

    expect(fire).toHaveBeenCalledTimes(1);
    fire.mockRestore();
    const state = await jobState.read(jobNameFor(eventId));
    expect(state.isRunning).toBe(false);
    expect(state.lastResult).toMatchObject({ imported: 1 });
    expect(state.lastResult.failed).toBeUndefined();
  });

  it('does not announce a pass that failed; the next one does', async () => {
    const eventId = await seedEvent();
    await writeJpeg('shoot/a.jpg');
    const real = externalAccess.authorizeImport;
    const authorize = jest.spyOn(externalAccess, 'authorizeImport')
      .mockImplementationOnce(real)
      .mockRejectedValueOnce(new Error('source revoked mid-run'));

    await expect(scan(eventId)).rejects.toThrow('source revoked mid-run');
    authorize.mockRestore();
    expect(await deliveries()).toHaveLength(0);

    await scan(eventId);
    expect((await deliveries()).map((d) => d.data.counts.imported)).toEqual([1]);
  });

  it('does not announce a pass that lost its claim to another runner', async () => {
    const eventId = await seedEvent();
    await writeJpeg('shoot/a.jpg');
    generateThumbnail.mockImplementationOnce(async (_src, { outputBasename }) => {
      await db('maintenance_jobs').where({ job_name: jobNameFor(eventId) }).update({ claim_token: 'other-runner' });
      return `thumbnails/thumb_${outputBasename}`;
    });

    expect(await scan(eventId)).toMatchObject({ imported: 1 });
    expect(await deliveries()).toHaveLength(0);

    await jobState.release(jobNameFor(eventId), 'other-runner');
    await writeJpeg('shoot/b.jpg', { r: 200, g: 10, b: 10 });
    await scan(eventId);
    expect((await deliveries()).map((d) => d.data.imported.map((i) => i.relpath))).toEqual([['shoot/b.jpg']]);
  });
});
