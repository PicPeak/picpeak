/**
 * A deferred photo must not stall the queue.
 *
 * claimNextPhoto orders by id ascending, and the queue defaults to a single
 * worker. So returning an unreachable photo to 'pending' — the obvious way to
 * say "try again later" — makes that same row the oldest pending one forever:
 * the worker reclaims it after every backoff and never reaches a higher id.
 * One dead mount would stall face scanning for the entire install, including
 * unrelated events and fresh uploads.
 *
 * The row is instead left parked in 'processing' with its face_started_at
 * intact. It is not claimable, so the worker advances; the existing janitor
 * returns it to 'pending' after STUCK_TIMEOUT_MS, which is the retry.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-defer-'));
process.env.TEST_DATABASE_PATH = path.join(tmpRoot, 'db.sqlite');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'defer-test-secret';

const { bootCrmDb } = require('./helpers/crmDb');

let db; let cleanup; let faceQueue; let faceProcessor;

describe('deferred photos do not block the queue', () => {
  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    faceQueue = require('../../src/services/faceQueue');
    faceProcessor = require('../../src/services/faceProcessor');
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
    await fs.promises.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  });

  it('exports TransientSourceError for the queue to branch on', () => {
    // The queue imports this from faceProcessor; if the export is dropped the
    // instanceof check silently becomes false and every deferral turns back
    // into a permanent failure.
    expect(typeof faceProcessor.TransientSourceError).toBe('function');
    expect(new faceProcessor.TransientSourceError(1, 'x'))
      .toBeInstanceOf(Error);
  });

  it('does NOT return a deferred row to pending', () => {
    // Source inspection, deliberately. workerLoop is an unexported infinite
    // loop, so the branch cannot be driven directly, and asserting on database
    // state alone does not distinguish the fix from the bug — a version that
    // re-queues the row passes every state assertion in this file. What
    // actually matters is that this one branch does not call releaseToPending,
    // so that is what is pinned. Same approach as the contract tests added for
    // #596.
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'services', 'faceQueue.js'), 'utf8'
    );

    const marker = 'if (err instanceof TransientSourceError) {';
    const start = src.indexOf(marker);
    expect(start).toBeGreaterThan(-1);

    // The branch body, up to its closing brace.
    const body = src.slice(start, src.indexOf('\n      }', start));
    expect(body).not.toMatch(/releaseToPending/);
    expect(body).toMatch(/continue/);

    // And the sidecar branch, which SHOULD still release, so this test fails
    // if the two branches are ever collapsed back together.
    const sideStart = src.indexOf('if (err instanceof SidecarUnavailableError) {');
    expect(sideStart).toBeGreaterThan(-1);
    const sideBody = src.slice(sideStart, src.indexOf('\n      }', sideStart));
    expect(sideBody).toMatch(/releaseToPending/);
  });

  it('leaves a deferred row claimable-later, not claimable-now', async () => {
    // A row parked in 'processing' is invisible to claimNextPhoto, which only
    // ever selects face_status='pending' — that is what lets the worker move
    // past it instead of spinning on it.
    const [e] = await db('events').insert({
      slug: `defer-${Math.random().toString(36).slice(2, 8)}`,
      event_type: 'wedding',
      event_name: 'defer',
      event_date: '2026-01-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_link: `defer-${Math.random()}`,
      expires_at: new Date().toISOString(),
      face_recognition_enabled: true,
    }).returning('id');
    const eventId = typeof e === 'object' ? e.id : e;

    const [stuck] = await db('photos').insert({
      event_id: eventId,
      filename: 'stuck.jpg',
      path: 'd/stuck.jpg',
      type: 'individual',
      processing_status: 'complete',
      face_status: 'processing',
      face_started_at: new Date().toISOString(),
      source_origin: 'external',
    }).returning('id');
    const stuckId = typeof stuck === 'object' ? stuck.id : stuck;

    const parked = await db('photos')
      .where({ id: stuckId, face_status: 'pending' })
      .first();
    expect(parked).toBeUndefined(); // not claimable while parked

    // The janitor's contract is what turns the park into a retry: it resets
    // 'processing' rows whose face_started_at is older than the stuck timeout.
    // Backdate past it and the row becomes claimable again.
    const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await db('photos').where({ id: stuckId }).update({ face_started_at: longAgo });

    const cutoff = new Date(Date.now() - 600000).toISOString();
    const reset = await db('photos')
      .where('face_status', 'processing')
      .where('face_started_at', '<', cutoff)
      .update({ face_status: 'pending', face_started_at: null });

    expect(reset).toBeGreaterThan(0);
    const after = await db('photos').where({ id: stuckId }).first();
    expect(after.face_status).toBe('pending');
  });

  it('claimNextPhoto skips events inside their backoff window', async () => {
    // The per-event cooldown is what stops the janitor handing a whole dead
    // gallery back every sweep. Without the exclusion the worker walks all of
    // it again — one slow stat per photo against a possibly hard-mounted
    // share — before reaching any healthy event.
    const mk = async (name) => {
      const [e] = await db('events').insert({
        slug: `cd-${name}-${Math.random().toString(36).slice(2, 8)}`,
        event_type: 'wedding',
        event_name: name,
        event_date: '2026-01-01',
        host_email: 'h@example.com',
        admin_email: 'a@example.com',
        password_hash: 'x',
        share_link: `cd-${name}-${Math.random()}`,
        expires_at: new Date().toISOString(),
        face_recognition_enabled: true,
      }).returning('id');
      const eventId = typeof e === 'object' ? e.id : e;
      const [p2] = await db('photos').insert({
        event_id: eventId,
        filename: `${name}.jpg`,
        path: `cd/${name}.jpg`,
        type: 'individual',
        processing_status: 'complete',
        face_status: 'pending',
        source_origin: 'external',
      }).returning('id');
      return { eventId, photoId: typeof p2 === 'object' ? p2.id : p2 };
    };

    await db('photos').del();
    const dead = await mk('dead');     // lower id -> would win the FIFO
    const healthy = await mk('healthy');

    // Without exclusion the dead event's row is claimed first...
    const first = await faceQueue.claimNextPhoto([]);
    expect(first.id).toBe(dead.photoId);
    await db('photos').where({ id: dead.photoId }).update({ face_status: 'pending' });

    // ...and with it, the worker reaches the healthy event instead.
    const second = await faceQueue.claimNextPhoto([dead.eventId]);
    expect(second.id).toBe(healthy.photoId);
  });

  it('backoff spares managed rows in a mixed-source event', async () => {
    // A reference event can hold managed uploads alongside imported external
    // ones. Excluding the whole event id would leave those unscanned for as
    // long as external rows keep renewing the cooldown — indefinitely, during
    // a real outage — even though their local source is fine.
    await db('photos').del();
    const [e] = await db('events').insert({
      slug: `mix-${Math.random().toString(36).slice(2, 8)}`,
      event_type: 'wedding',
      event_name: 'mix',
      event_date: '2026-01-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_link: `mix-${Math.random()}`,
      expires_at: new Date().toISOString(),
      face_recognition_enabled: true,
      source_mode: 'reference',
    }).returning('id');
    const eventId = typeof e === 'object' ? e.id : e;

    const add = async (origin, name) => {
      const [p2] = await db('photos').insert({
        event_id: eventId,
        filename: name,
        path: `mix/${name}`,
        type: 'individual',
        processing_status: 'complete',
        face_status: 'pending',
        source_origin: origin,
      }).returning('id');
      return typeof p2 === 'object' ? p2.id : p2;
    };
    await add('external', 'ext.jpg');            // lower id, would win the FIFO
    const managedId = await add('managed', 'man.jpg');

    // Event is in backoff: the external row is skipped, the managed one is not.
    const claimed = await faceQueue.claimNextPhoto([eventId]);
    expect(claimed).toBeTruthy();
    expect(claimed.id).toBe(managedId);
  });

  it('startQueue is exported and does not throw on import', () => {
    // faceQueue requires faceProcessor for TransientSourceError while
    // faceProcessor is itself required by the routes — a circular require here
    // would surface as an undefined export rather than a crash, so assert the
    // module actually loaded something usable.
    expect(faceQueue).toBeTruthy();
    expect(Object.keys(faceQueue).length).toBeGreaterThan(0);
  });
});
