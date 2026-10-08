/**
 * External-media folder watcher (issue 1187).
 *
 * Drives the real service against a real temp folder and the real import
 * pass (sharp and thumbnail generation mocked, as in the other external
 * import suites). Covers the contracts the feature rests on:
 *
 *   - only events that opted in, are in reference mode, live and not
 *     archived get a watcher, and reconcile() follows the row both ways;
 *   - the timer sweep imports what appeared since the last pass, through the
 *     same code path as the Import button, and never deletes;
 *   - a change in the folder triggers a debounced import on its own;
 *   - a claim held elsewhere makes the watcher stand down rather than walk
 *     the tree a second time;
 *   - quiet system passes stay out of the activity log, real imports go in.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Fixture files are written "in the past": an automatic pass leaves a file
// modified inside the settle window for the next pass (that is the point of
// the check), so anything a test expects to be imported straight away must
// not look like a copy still in flight.
const writeOld = async (file, content) => {
  await fs.promises.writeFile(file, content);
  const old = new Date(Date.now() - 60000);
  await fs.promises.utimes(file, old, old);
};

const waitFor = async (predicate, { timeoutMs = 8000, stepMs = 50 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
};

describe('externalMediaWatcher (issue 1187)', () => {
  let tmpDir; let mediaRoot; let db; let watcher; let jobState;

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-extwatch-'));
    mediaRoot = path.join(tmpDir, 'media');
    await fs.promises.mkdir(path.join(mediaRoot, 'nas', 'individual'), { recursive: true });
    await fs.promises.mkdir(path.join(mediaRoot, 'other'), { recursive: true });
    await writeOld(path.join(mediaRoot, 'nas', 'individual', 'a.jpg'), 'not-a-real-jpeg');

    process.env.NODE_ENV = 'test';
    process.env.EXTERNAL_MEDIA_ROOT = mediaRoot;
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'extwatch-secret';
    // Short timers, and stat-polling so the change test does not depend on
    // the host's inotify/FSEvents behaviour for a temp directory.
    process.env.EXTERNAL_MEDIA_WATCH_DEBOUNCE_MS = '100';
    process.env.EXTERNAL_MEDIA_WATCH_STABILITY_MS = '150';
    process.env.EXTERNAL_MEDIA_WATCH_POLLING = 'true';
    process.env.EXTERNAL_MEDIA_WATCH_POLL_INTERVAL_MS = '100';
    process.env.EXTERNAL_MEDIA_WATCH_SWEEP_INTERVAL_MS = '0';
    process.env.EXTERNAL_MEDIA_WATCH_RECONCILE_INTERVAL_MS = '3600000';

    jest.resetModules();
    jest.doMock('sharp', () => () => ({ metadata: async () => ({ width: 100, height: 200 }) }));
    jest.doMock('../../src/services/imageProcessor', () => ({
      generateThumbnail: jest.fn(async () => 'thumbnails/mock.jpg'),
      extractCaptureDate: jest.fn(async () => null),
      orientedDimensions: (m) => ({ width: m.width, height: m.height }),
      ensureThumbnail: jest.fn(),
    }));
    jest.doMock('../../src/utils/logger', () => ({
      debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    }));

    ({ db } = await require('../integration/helpers/crmDb').bootCrmDb());
    await require('../integration/helpers/externalMediaFixture').seedExternalAdminFixture(db);
    watcher = require('../../src/services/externalMediaWatcher');
    jobState = require('../../src/services/maintenanceJobState');
  }, 180000);

  afterAll(async () => {
    await watcher.stopExternalMediaWatcher();
    if (db) await db.destroy?.();
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(async () => {
    await watcher.stopExternalMediaWatcher();
    await db('activity_logs').del();
    await db('photos').del();
    await db('external_import_exclusions').del();
    await db('events').del();
  });

  async function seedEvent(overrides = {}) {
    const [e] = await db('events').insert({
      slug: `extwatch-${Math.random().toString(36).slice(2, 8)}`,
      event_type: 'wedding',
      event_name: 'extwatch',
      event_date: '2026-01-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_link: `extwatch-${Math.random()}`,
      expires_at: new Date().toISOString(),
      source_mode: 'reference',
      created_by: 1,
      external_path: 'nas',
      external_watch: 1,
      is_active: 1,
      is_archived: 0,
      ...overrides,
    }).returning('id');
    return typeof e === 'object' ? e.id : e;
  }

  const relpaths = async (eventId) => (await db('photos').where({ event_id: eventId }).select('external_relpath'))
    .map((r) => r.external_relpath).sort();

  it('lists only reference events that opted in, are active and not archived', async () => {
    const watched = await seedEvent();
    await seedEvent({ external_watch: 0 });
    await seedEvent({ source_mode: 'managed', external_path: null });
    await seedEvent({ is_archived: 1 });
    await seedEvent({ is_active: 0 });

    const rows = await watcher.listWatchedEvents();
    expect(rows.map((r) => r.id)).toEqual([watched]);
  });

  it('reconcile starts a watcher for an opted-in event, imports once, and stops it when the row changes', async () => {
    const eventId = await seedEvent();

    await watcher.reconcile();
    expect(watcher.watchedEventIds()).toEqual([eventId]);
    // Ticking the box is enough: what is already in the folder comes in now,
    // not at the next sweep.
    expect(await relpaths(eventId)).toEqual([path.join('nas', 'individual', 'a.jpg')]);

    // A folder that does not exist is not watched — and is retried, not failed.
    await db('events').where('id', eventId).update({ external_path: 'does-not-exist' });
    await watcher.reconcile();
    expect(watcher.watchedEventIds()).toEqual([]);

    await db('events').where('id', eventId).update({ external_path: 'nas' });
    await watcher.reconcile();
    expect(watcher.watchedEventIds()).toEqual([eventId]);

    await db('events').where('id', eventId).update({ external_watch: 0 });
    await watcher.reconcile();
    expect(watcher.watchedEventIds()).toEqual([]);
  });

  it('sweep imports new files through the shared import pass and never deletes', async () => {
    const eventId = await seedEvent();
    await watcher.reconcile();

    await watcher.sweep();
    expect(await relpaths(eventId)).toEqual([path.join('nas', 'individual', 'a.jpg')]);

    // An import that changed something is logged, with the system actor ...
    expect(await db('activity_logs').where({ activity_type: 'external_import_completed' }).count('* as n').first())
      .toMatchObject({ n: 1 });

    await writeOld(path.join(mediaRoot, 'nas', 'individual', 'b.jpg'), 'also-not-a-jpeg');
    await fs.promises.unlink(path.join(mediaRoot, 'nas', 'individual', 'a.jpg'));
    await watcher.sweep();

    // ... b.jpg is in, a.jpg's row is kept although the file is gone.
    expect(await relpaths(eventId)).toEqual([
      path.join('nas', 'individual', 'a.jpg'),
      path.join('nas', 'individual', 'b.jpg'),
    ]);

    const logs = await db('activity_logs').where({ activity_type: 'external_import_completed' });
    expect(logs).toHaveLength(2);
    expect(logs.every((l) => l.actor_type === 'system')).toBe(true);

    // ... a quiet pass is not: no third entry.
    await watcher.sweep();
    expect(await db('activity_logs').where({ activity_type: 'external_import_completed' }).count('* as n').first())
      .toMatchObject({ n: 2 });

    // Leave the folder as the next test expects it.
    await fs.promises.unlink(path.join(mediaRoot, 'nas', 'individual', 'b.jpg'));
    await writeOld(path.join(mediaRoot, 'nas', 'individual', 'a.jpg'), 'not-a-real-jpeg');
  });

  it('a file appearing in the folder triggers a debounced import on its own', async () => {
    const eventId = await seedEvent();
    await watcher.reconcile();
    await watcher.sweep();
    expect(await relpaths(eventId)).toEqual([path.join('nas', 'individual', 'a.jpg')]);

    await fs.promises.writeFile(path.join(mediaRoot, 'nas', 'individual', 'c.jpg'), 'new-arrival');

    const arrived = await waitFor(async () => (await relpaths(eventId)).includes(path.join('nas', 'individual', 'c.jpg')));
    expect(arrived).toBe(true);

    await fs.promises.unlink(path.join(mediaRoot, 'nas', 'individual', 'c.jpg'));
  }, 20000);

  it('stands down while another runner holds the claim for the event', async () => {
    const eventId = await seedEvent();

    const { jobNameFor } = require('../../src/services/externalImportService');
    await jobState.ensure(jobNameFor(eventId));
    const token = await jobState.claim(jobNameFor(eventId));
    expect(token).toBeTruthy();

    expect(await watcher.runImport(eventId, 'sweep')).toBeNull();
    expect(await relpaths(eventId)).toEqual([]);

    await jobState.release(jobNameFor(eventId), token);
    const result = await watcher.runImport(eventId, 'sweep');
    expect(result).toMatchObject({ imported: 1 });
  });

  it('does not bring back a photo an admin deleted, until the manual Import asks for it', async () => {
    const eventId = await seedEvent();
    const { importExternalFolder, recordExclusions } = require('../../src/services/externalImportService');

    await watcher.reconcile();
    expect(await relpaths(eventId)).toEqual([path.join('nas', 'individual', 'a.jpg')]);

    // The delete routes record the exclusion before removing the row.
    const [row] = await db('photos').where({ event_id: eventId });
    await recordExclusions(eventId, [row]);
    await db('photos').where({ id: row.id }).del();

    const swept = await watcher.runImport(eventId, 'sweep');
    expect(swept).toMatchObject({ imported: 0, excluded: 1 });
    expect(await relpaths(eventId)).toEqual([]);

    // Pressing Import is the explicit intent: the file comes back and the
    // exclusion is cleared, so later automatic passes keep it.
    const manual = await importExternalFolder({ eventId, externalPath: 'nas', actor: { type: 'admin', id: 1 } });
    expect(manual).toMatchObject({ imported: 1 });
    expect(await db('external_import_exclusions').where({ event_id: eventId })).toHaveLength(0);
  });

  it('leaves a file that is still changing for the next pass', async () => {
    const eventId = await seedEvent();
    const { importExternalFolder } = require('../../src/services/externalImportService');
    const growing = path.join(mediaRoot, 'nas', 'individual', 'growing.jpg');
    await fs.promises.writeFile(growing, 'part-one');

    // mtime is "now", inside the settle window: deferred, not inserted.
    const first = await importExternalFolder({ eventId, externalPath: 'nas', actor: { type: 'system' }, automatic: true, settleMs: 300 });
    expect(first).toMatchObject({ imported: 1, deferred: 1 });
    expect(await relpaths(eventId)).toEqual([path.join('nas', 'individual', 'a.jpg')]);

    // Old mtime but the size moves during the wait: still deferred.
    const old = new Date(Date.now() - 60000);
    await fs.promises.utimes(growing, old, old);
    const grow = setTimeout(() => fs.promises.appendFile(growing, '-part-two').then(() => fs.promises.utimes(growing, old, old)), 100);
    const second = await importExternalFolder({ eventId, externalPath: 'nas', actor: { type: 'system' }, automatic: true, settleMs: 300 });
    clearTimeout(grow);
    expect(second).toMatchObject({ imported: 0, deferred: 1 });

    // Quiet now: imported.
    await fs.promises.utimes(growing, old, old);
    const third = await importExternalFolder({ eventId, externalPath: 'nas', actor: { type: 'system' }, automatic: true, settleMs: 300 });
    expect(third).toMatchObject({ imported: 1, deferred: 0 });

    await fs.promises.unlink(growing);
  });

  it('a photo deleted while the pass is settling stays deleted', async () => {
    const eventId = await seedEvent();
    const { importExternalFolder, recordExclusions } = require('../../src/services/externalImportService');
    await importExternalFolder({ eventId, externalPath: 'nas', actor: { type: 'admin', id: 1 } });
    const [row] = await db('photos').where({ event_id: eventId });

    // A new file makes the pass wait for the settle window; inside that
    // window the admin deletes a.jpg. The snapshot taken before the wait
    // saw a.jpg as present, so only a per-file check can keep it out.
    await writeOld(path.join(mediaRoot, 'nas', 'individual', 'd.jpg'), 'new-file');
    setTimeout(async () => {
      await recordExclusions(eventId, [row]);
      await db('photos').where({ id: row.id }).del();
    }, 100);
    const result = await importExternalFolder({ eventId, externalPath: 'nas', actor: { type: 'system' }, automatic: true, settleMs: 400 });

    expect(result).toMatchObject({ imported: 1, excluded: 1 });
    expect(await relpaths(eventId)).toEqual([path.join('nas', 'individual', 'd.jpg')]);
    await fs.promises.unlink(path.join(mediaRoot, 'nas', 'individual', 'd.jpg'));
  });

  it('records an exclusion for a replaced external photo too', async () => {
    const eventId = await seedEvent();
    const { importExternalFolder, recordExclusions } = require('../../src/services/externalImportService');
    await importExternalFolder({ eventId, externalPath: 'nas', actor: { type: 'admin', id: 1 } });
    const [row] = await db('photos').where({ event_id: eventId });

    // photoReplacementService flips the row to managed but keeps the relpath.
    await db('photos').where({ id: row.id }).update({ source_origin: 'managed' });
    const replaced = await db('photos').where({ id: row.id }).first();
    await recordExclusions(eventId, [replaced]);
    await db('photos').where({ id: row.id }).del();

    expect(await watcher.runImport(eventId, 'sweep')).toMatchObject({ imported: 0, excluded: 1 });
    expect(await relpaths(eventId)).toEqual([]);
  });

  it('an automatic pass stops when the event stopped qualifying since it was scheduled', async () => {
    const eventId = await seedEvent();
    const { importExternalFolder } = require('../../src/services/externalImportService');
    await db('events').where('id', eventId).update({ external_watch: 0 });
    expect(await importExternalFolder({ eventId, externalPath: 'nas', actor: { type: 'system' }, automatic: true }))
      .toMatchObject({ imported: 0 });
    expect(await relpaths(eventId)).toEqual([]);
  });

  it('an automatic pass never rewrites the event folder, and stops if it moved', async () => {
    const eventId = await seedEvent();
    const { importExternalFolder } = require('../../src/services/externalImportService');

    // The pass was started for 'nas' but the admin has since pointed the
    // event at 'other': nothing imported, row untouched.
    await db('events').where('id', eventId).update({ external_path: 'other' });
    const result = await importExternalFolder({ eventId, externalPath: 'nas', actor: { type: 'system' }, automatic: true });
    expect(result).toMatchObject({ imported: 0 });
    expect(await relpaths(eventId)).toEqual([]);
    expect((await db('events').where('id', eventId).first()).external_path).toBe('other');

    // The manual Import is what writes the folder onto the event.
    await importExternalFolder({ eventId, externalPath: 'nas', actor: { type: 'admin', id: 1 } });
    expect((await db('events').where('id', eventId).first()).external_path).toBe('nas');
  });

  it('re-arms itself for a file that was deferred, so a disabled sweep is not needed', async () => {
    const eventId = await seedEvent();
    // Written just now: the pass that starts with the watcher defers it.
    await fs.promises.writeFile(path.join(mediaRoot, 'nas', 'individual', 'e.jpg'), 'fresh');
    await watcher.reconcile();
    expect(await relpaths(eventId)).toEqual([path.join('nas', 'individual', 'a.jpg')]);

    const arrived = await waitFor(async () => (await relpaths(eventId)).includes(path.join('nas', 'individual', 'e.jpg')));
    expect(arrived).toBe(true);
    await fs.promises.unlink(path.join(mediaRoot, 'nas', 'individual', 'e.jpg'));
  }, 20000);

  it('skips an event that was archived or deactivated after it was scheduled', async () => {
    const archived = await seedEvent();
    await db('events').where('id', archived).update({ is_archived: 1 });
    expect(await watcher.runImport(archived, 'change')).toBeNull();

    const inactive = await seedEvent();
    await db('events').where('id', inactive).update({ is_active: 0 });
    expect(await watcher.runImport(inactive, 'sweep')).toBeNull();

    expect(await db('photos').count('* as n').first()).toMatchObject({ n: 0 });
  });

  it('follows the row at run time: an event that opted out since scheduling is skipped', async () => {
    const eventId = await seedEvent();
    await db('events').where('id', eventId).update({ external_watch: 0 });

    expect(await watcher.runImport(eventId, 'change')).toBeNull();
    expect(await relpaths(eventId)).toEqual([]);
  });
});
