/**
 * Archiving an event bounds and reclaims its storage reads.
 *
 * archiveService opened a storage read per photo in a loop and handed each
 * body to archiver, which drains them one at a time, so a large S3-backed
 * event parked every other body on a socket of the shared agent pool until
 * its turn and starved uploads and gallery reads (the PR 1402 shape). Nothing
 * destroyed the open bodies when the build failed. The builder now goes
 * through createArchiveStreamGuard like the download builders: two reads in
 * flight, every open read destroyed on failure.
 */

const crypto = require('crypto');
const { Readable } = require('stream');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'archive-stream-guard-secret';

const SLUG = 'archive-guard';
const bodies = new Map();
const open = new Set();
let maxOpen = 0;
let failingKey = null;

const mockStorage = {
  kind: () => 's3',
  list: jest.fn(async (prefix) => [...bodies.keys()]
    .filter((key) => key.startsWith(prefix))
    .map((key) => ({ key, size: bodies.get(key).length, mtime: new Date() }))),
  get: jest.fn(async (key) => {
    const body = bodies.get(key);
    const failing = key === failingKey;
    const stream = Readable.from((async function* read() {
      for (let offset = 0; offset < body.length; offset += 4096) {
        await new Promise((r) => setTimeout(r, 2));
        yield body.subarray(offset, offset + 4096);
      }
    })());
    open.add(stream);
    maxOpen = Math.max(maxOpen, open.size);
    const done = () => open.delete(stream);
    stream.once('end', done);
    stream.once('close', done);
    // The socket dies while the read is still queued behind another.
    if (failing) setTimeout(() => stream.destroy(Object.assign(new Error('socket reset by peer'), { code: 'ECONNRESET' })), 10);
    return stream;
  }),
  stat: jest.fn(async (key) => (bodies.has(key) ? { size: bodies.get(key).length, mtime: new Date() } : null)),
  exists: jest.fn(async () => true),
  putFromFile: jest.fn(async () => undefined),
  put: jest.fn(async () => undefined),
  delete: jest.fn(async () => undefined),
  resolveLocalPath: () => { throw new Error('not local'); },
};
jest.mock('../../src/services/storage', () => ({
  getStorage: () => mockStorage,
  initStorage: async () => mockStorage,
}));
jest.mock('../../src/services/emailProcessor', () => ({
  queueEmail: jest.fn(async () => undefined),
  getSupportEmail: jest.fn(async () => 'support@example.com'),
}));

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

describe('archiveService storage reads', () => {
  let db; let cleanup; let archiveEvent;

  const unwrap = (rows) => (typeof rows[0] === 'object' && rows[0] !== null ? rows[0].id : rows[0]);

  async function makeEvent(slug, photoCount) {
    const id = unwrap(await db('events').insert({
      slug,
      event_type: 'wedding',
      event_name: `Archive ${slug}`,
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      admin_email: null,
      password_hash: 'x',
      share_link: `/gallery/${slug}/share`,
      share_token: `${slug}-share`,
      expires_at: new Date(Date.now() - 864e5).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id'));
    for (let i = 0; i < photoCount; i += 1) {
      const filename = `photo-${i}.jpg`;
      bodies.set(`events/active/${slug}/${filename}`, crypto.randomBytes(64 * 1024));
      await db('photos').insert({
        event_id: id, filename, path: `events/active/${slug}/${filename}`, type: 'individual',
        source_origin: 'managed', mime_type: 'image/jpeg', uploaded_at: new Date().toISOString(),
      });
    }
    return db('events').where({ id }).first();
  }

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    ({ archiveEvent } = require('../../src/services/archiveService'));
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(() => {
    open.clear();
    maxOpen = 0;
    failingKey = null;
  });

  it('keeps at most two storage reads open while building the archive', async () => {
    const event = await makeEvent(SLUG, 6);

    await archiveEvent(event);

    expect(maxOpen).toBeLessThanOrEqual(2);
    expect(mockStorage.get).toHaveBeenCalledTimes(6);
    expect(open.size).toBe(0);
    const row = await db('events').where({ id: event.id }).first();
    expect(Boolean(row.is_archived)).toBe(true);
    expect(mockStorage.putFromFile).toHaveBeenCalledWith(`events/archived/${SLUG}.zip`, expect.any(String), expect.anything());
  });

  it('destroys every open read when a queued read dies, and archives nothing', async () => {
    const event = await makeEvent(`${SLUG}-fail`, 4);
    failingKey = `events/active/${SLUG}-fail/photo-1.jpg`;

    await expect(archiveEvent(event)).rejects.toThrow('socket reset by peer');

    await new Promise((r) => setImmediate(r));
    expect(open.size).toBe(0);
    const row = await db('events').where({ id: event.id }).first();
    expect(Boolean(row.is_archived)).toBe(false);
    expect(mockStorage.putFromFile).not.toHaveBeenCalledWith(`events/archived/${SLUG}-fail.zip`, expect.any(String), expect.anything());
  });
});
