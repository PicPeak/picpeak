/**
 * The other direction of the mark race (#1044 follow-up, review of #1137).
 *
 * setMark reads the row, then writes it. #1137 fixed the case where two calls
 * both write — each now writes only the half it was asked about, so neither
 * clobbers the other. This is the case where one call CLEARS while another
 * SETS: the clear empties the row, the row is deleted for being empty, and the
 * setter's update then matches nothing. Its value lands nowhere and the old
 * code reported "no mark" — a keystroke lost silently, which is precisely what
 * the sibling fix exists to prevent.
 *
 * The window is inside setMark, between its read and its write, so it cannot
 * be driven from outside by ordinary concurrency — natural ordering resolves
 * it correctly. The db handle the service captures is wrapped here to delete
 * the row at exactly that point, which is the only way to pin the behaviour
 * rather than argue about it.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-mark-vanish-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'mark-vanish-secret';

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

const ADMIN = 11;

let db;
let cleanup;
let marks;
let eventId;
let photoId;

/** Deletes the row the next time the service updates it, then lets it proceed. */
let deleteBeforeNextUpdate = null;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  await seedMinimal(db);

  const inserted = await db('events').insert({
    slug: 'mark-vanish-event',
    event_type: 'wedding',
    event_name: 'Mark Vanish',
    event_date: '2026-07-20',
    host_email: 'host@example.com',
    admin_email: 'admin@example.com',
    password_hash: 'x',
    share_link: '/gallery/mark-vanish/share',
    share_token: 'mark-vanish-share',
    expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    is_active: 1,
    is_archived: 0,
    is_draft: 0,
    created_at: new Date().toISOString(),
  }).returning('id');
  eventId = inserted[0]?.id ?? inserted[0];

  const photo = await db('photos').insert({
    event_id: eventId,
    filename: 'vanish.jpg',
    path: 'events/vanish/0.jpg',
    type: 'individual',
    uploaded_at: new Date().toISOString(),
  }).returning('id');
  photoId = photo[0]?.id ?? photo[0];

  // Wrap the handle BEFORE the service is required, since it destructures `db`
  // at load time and keeps that reference.
  const dbModule = require('../../src/database/db');
  const real = dbModule.db;
  dbModule.db = new Proxy(real, {
    apply(target, thisArg, args) {
      const qb = Reflect.apply(target, thisArg, args);
      if (args[0] !== 'photo_admin_marks' || !deleteBeforeNextUpdate) return qb;
      const originalUpdate = qb.update.bind(qb);
      qb.update = (...updateArgs) => {
        if (!deleteBeforeNextUpdate) return originalUpdate(...updateArgs);
        const rowId = deleteBeforeNextUpdate;
        deleteBeforeNextUpdate = null;
        const pending = originalUpdate(...updateArgs);
        // The concurrent clear commits here — after the service read the row,
        // before its own write runs.
        return real('photo_admin_marks').where('id', rowId).delete().then(() => pending);
      };
      return qb;
    },
  });

  marks = require('../../src/services/photoAdminMarksService');
}, 120000);

afterAll(async () => {
  if (cleanup) await cleanup();
});

beforeEach(async () => {
  deleteBeforeNextUpdate = null;
  await db('photo_admin_marks').where({ photo_id: photoId }).delete();
});

describe('a mark whose row is deleted mid-write', () => {
  it('still lands the value instead of reporting no mark', async () => {
    await marks.setMark(eventId, photoId, ADMIN, { rating: 3 });
    const row = await db('photo_admin_marks')
      .where({ photo_id: photoId, admin_id: ADMIN }).first();

    // A concurrent clear will delete this row inside the next setMark's window.
    deleteBeforeNextUpdate = row.id;

    const result = await marks.setMark(eventId, photoId, ADMIN, { colorLabel: 'blue' });

    // Before the fix the update matched zero rows and this came back null, with
    // nothing written anywhere — the colour keystroke gone without a trace.
    expect(result).toEqual({ rating: null, color_label: 'blue' });

    const after = await db('photo_admin_marks')
      .where({ photo_id: photoId, admin_id: ADMIN }).first();
    expect(after).toBeTruthy();
    expect(after.color_label).toBe('blue');
  });

  it('does not resurrect a row when the call was itself a clear', async () => {
    await marks.setMark(eventId, photoId, ADMIN, { rating: 3 });
    const row = await db('photo_admin_marks')
      .where({ photo_id: photoId, admin_id: ADMIN }).first();

    deleteBeforeNextUpdate = row.id;

    // Retrying must not turn "clear it" into "create an empty row".
    const result = await marks.setMark(eventId, photoId, ADMIN, { rating: null });

    expect(result).toBeNull();
    expect(await db('photo_admin_marks')
      .where({ photo_id: photoId, admin_id: ADMIN }).first()).toBeUndefined();
  });
});
