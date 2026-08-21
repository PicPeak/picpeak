/**
 * "The scan finished" is not a thing this queue is told (#1107).
 *
 * It claims photos one at a time, so a backfill is just a lot of independent
 * claims and the only available signal is a worker finding nothing left. That
 * signal is NOT sufficient on its own — with concurrency above one the other
 * workers may still be busy, and a photo released back to `pending` by a down
 * sidecar is still owed — so the drain is tested against the queue directly.
 *
 * These are the cases that decide whether consolidation runs too early (a
 * wasted pass over half-formed clusters) or never (the feature silently does
 * nothing, which is the state #1107 was filed about).
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-facedrain-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'facedrain-test-secret';

const { bootCrmDb } = require('./helpers/crmDb');

let db; let cleanup; let faceQueue; let clustering;

async function seedEvent(slug) {
  const [row] = await db('events').insert({
    slug,
    event_type: 'wedding',
    event_name: slug,
    event_date: '2026-01-01',
    host_email: 'h@example.com',
    admin_email: 'a@example.com',
    password_hash: 'x',
    share_link: `${slug}-share`,
    expires_at: new Date().toISOString(),
  }).returning('id');
  return typeof row === 'object' ? row.id : row;
}

async function insertPhoto(eventId, faceStatus) {
  const [row] = await db('photos').insert({
    event_id: eventId,
    filename: `${Math.random()}.jpg`,
    path: '/tmp/x.jpg',
    type: 'individual',
    face_status: faceStatus,
  }).returning('id');
  return typeof row === 'object' ? row.id : row;
}

describe('faceQueue drain consolidation (#1107)', () => {
  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    faceQueue = require('../../src/services/faceQueue');
    clustering = require('../../src/services/faceClustering');
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(() => {
    faceQueue.touchedEvents.clear();
    jest.restoreAllMocks();
  });

  it('does nothing at all when no photo has been scanned', async () => {
    const spy = jest.spyOn(clustering, 'consolidate');
    await faceQueue.drainConsolidation();
    expect(spy).not.toHaveBeenCalled();
  });

  it('waits while the event still has photos queued', async () => {
    const eventId = await seedEvent('drain-pending');
    await insertPhoto(eventId, 'done');
    await insertPhoto(eventId, 'pending');
    faceQueue.touchedEvents.add(eventId);

    const spy = jest.spyOn(clustering, 'consolidate');
    await faceQueue.drainConsolidation();

    expect(spy).not.toHaveBeenCalled();
    // Still owed, so it must keep its place for the next idle tick — dropping
    // it here would mean the gallery never consolidates at all.
    expect(faceQueue.touchedEvents.has(eventId)).toBe(true);
  });

  it('waits while a photo is still being processed by another worker', async () => {
    const eventId = await seedEvent('drain-processing');
    await insertPhoto(eventId, 'done');
    await insertPhoto(eventId, 'processing');
    faceQueue.touchedEvents.add(eventId);

    const spy = jest.spyOn(clustering, 'consolidate');
    await faceQueue.drainConsolidation();

    expect(spy).not.toHaveBeenCalled();
    expect(faceQueue.touchedEvents.has(eventId)).toBe(true);
  });

  it('consolidates once the queue is empty, and does not repeat itself', async () => {
    const eventId = await seedEvent('drain-empty');
    await insertPhoto(eventId, 'done');
    await insertPhoto(eventId, 'failed');
    await insertPhoto(eventId, 'skipped');
    faceQueue.touchedEvents.add(eventId);

    const spy = jest.spyOn(clustering, 'consolidate').mockResolvedValue([]);
    await faceQueue.drainConsolidation();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(eventId);
    // Drained and handled, so a second idle tick must not pay for it again.
    expect(faceQueue.touchedEvents.has(eventId)).toBe(false);

    await faceQueue.drainConsolidation();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a failing consolidation never propagates into the worker loop', async () => {
    const eventId = await seedEvent('drain-throws');
    await insertPhoto(eventId, 'done');
    faceQueue.touchedEvents.add(eventId);

    jest.spyOn(clustering, 'consolidate').mockRejectedValue(new Error('boom'));

    await expect(faceQueue.drainConsolidation()).resolves.toBeUndefined();
  });

  it('treats events independently — a busy gallery does not hold up a finished one', async () => {
    const busy = await seedEvent('drain-busy');
    const done = await seedEvent('drain-done');
    await insertPhoto(busy, 'pending');
    await insertPhoto(done, 'done');
    faceQueue.touchedEvents.add(busy);
    faceQueue.touchedEvents.add(done);

    const spy = jest.spyOn(clustering, 'consolidate').mockResolvedValue([]);
    await faceQueue.drainConsolidation();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(done);
    expect(faceQueue.touchedEvents.has(busy)).toBe(true);
  });
});
