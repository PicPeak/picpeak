/**
 * Ordering and the type filter on GET /admin/events.
 *
 * The list only ever came back `created_at desc`, which for a back-filled
 * archive (import last year's weddings today) is import order, not any order
 * the admin recognises. These cases pin the axes the column menus offer, the
 * two that are expressions rather than columns (photo_count, status), and the
 * null placement the menus promise.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-evsort-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'evsort-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-evsort-storage-'));

const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('../integration/helpers/crmDb');

const DAY = 24 * 60 * 60 * 1000;

describe('admin events list — ordering and type filter', () => {
  let db; let cleanup; let app; let token;

  const now = () => new Date().toISOString();
  const inDays = (n) => new Date(Date.now() + n * DAY).toISOString();

  async function mkEvent(over) {
    const slug = over.slug;
    const rows = await db('events').insert({
      slug,
      event_type: 'wedding',
      event_name: slug,
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_token: `st-${slug}`,
      share_link: `/gallery/${slug}/st-${slug}`,
      expires_at: inDays(30),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      created_at: now(),
      ...over,
    }).returning('id');
    return rows[0]?.id ?? rows[0];
  }

  async function addPhotos(eventId, count) {
    for (let i = 0; i < count; i += 1) {
      await db('photos').insert({
        event_id: eventId,
        filename: `${eventId}-${i}.jpg`,
        path: `events/active/${eventId}-${i}.jpg`,
        type: 'individual',
        size_bytes: 100,
        uploaded_at: now(),
        upload_id: `up-${eventId}-${i}`,
        processing_status: 'complete',
      });
    }
  }

  /** Returns the event_name list in response order. */
  async function listNames(query = {}) {
    const res = await request(app)
      .get('/api/admin/events')
      .query({ limit: 100, ...query })
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return res.body.events.map((e) => e.event_name);
  }

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    await assignAdminRole(db, adminId, 'super_admin');
    token = mintAdminToken(adminId);

    // Deliberately inserted in an order that matches none of the sorts, so a
    // passing case cannot be insertion order in disguise. Names mix case to
    // exercise the case-insensitive comparison.
    const zebra = await mkEvent({ slug: 'zebra', event_name: 'Zebra Hochzeit', event_date: '2024-05-01' });
    await mkEvent({ slug: 'apfel', event_name: 'apfel Taufe', event_date: '2026-01-15', event_type: 'baptism' });
    const mitte = await mkEvent({ slug: 'mitte', event_name: 'Mitte Firma', event_date: '2025-03-20', event_type: 'corporate' });
    await mkEvent({ slug: 'ohnedatum', event_name: 'Ohne Datum', event_date: null });

    await addPhotos(zebra, 3);
    await addPhotos(mitte, 1);

    app = buildRouteApp('/api/admin/events', require('../../src/routes/adminEvents'));
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  describe('name', () => {
    it('sorts A–Z ignoring case, so a lowercase name is not exiled to the end', async () => {
      expect(await listNames({ sortBy: 'event_name', sortOrder: 'asc' }))
        .toEqual(['apfel Taufe', 'Mitte Firma', 'Ohne Datum', 'Zebra Hochzeit']);
    });

    it('sorts Z–A', async () => {
      expect(await listNames({ sortBy: 'event_name', sortOrder: 'desc' }))
        .toEqual(['Zebra Hochzeit', 'Ohne Datum', 'Mitte Firma', 'apfel Taufe']);
    });
  });

  describe('event date', () => {
    it('sorts oldest first with undated galleries last', async () => {
      expect(await listNames({ sortBy: 'event_date', sortOrder: 'asc' }))
        .toEqual(['Zebra Hochzeit', 'Mitte Firma', 'apfel Taufe', 'Ohne Datum']);
    });

    it('sorts newest first, and undated galleries stay last rather than flipping to the top', async () => {
      expect(await listNames({ sortBy: 'event_date', sortOrder: 'desc' }))
        .toEqual(['apfel Taufe', 'Mitte Firma', 'Zebra Hochzeit', 'Ohne Datum']);
    });
  });

  describe('photo count', () => {
    it('orders by the inline count, not by the page that happened to be fetched', async () => {
      expect(await listNames({ sortBy: 'photo_count', sortOrder: 'desc' }).then((n) => n.slice(0, 2)))
        .toEqual(['Zebra Hochzeit', 'Mitte Firma']);
    });

    it('orders fewest first', async () => {
      expect(await listNames({ sortBy: 'photo_count', sortOrder: 'asc' }).then((n) => n.slice(-2)))
        .toEqual(['Mitte Firma', 'Zebra Hochzeit']);
    });
  });

  describe('status', () => {
    // A row per badge, so the rank is checked against the precedence
    // getEventStatus applies rather than against the raw flags.
    beforeAll(async () => {
      await mkEvent({ slug: 'st-draft', event_name: 'S Draft', is_draft: 1 });
      await mkEvent({ slug: 'st-archived', event_name: 'S Archived', is_archived: 1, archived_at: now() });
      await mkEvent({ slug: 'st-inactive', event_name: 'S Inactive', is_active: 0 });
      await mkEvent({ slug: 'st-expired', event_name: 'S Expired', expires_at: inDays(-1) });
      await mkEvent({ slug: 'st-expiring', event_name: 'S Expiring', expires_at: inDays(3) });
      await mkEvent({ slug: 'st-active', event_name: 'S Active', expires_at: inDays(90) });
    });

    it('ranks live galleries first and finished ones last', async () => {
      const names = (await listNames({ sortBy: 'status', sortOrder: 'asc' }))
        .filter((n) => n.startsWith('S '));
      expect(names).toEqual([
        'S Active', 'S Expiring', 'S Expired', 'S Draft', 'S Inactive', 'S Archived',
      ]);
    });

    it('mirrors that order descending', async () => {
      const names = (await listNames({ sortBy: 'status', sortOrder: 'desc' }))
        .filter((n) => n.startsWith('S '));
      expect(names).toEqual([
        'S Archived', 'S Inactive', 'S Draft', 'S Expired', 'S Expiring', 'S Active',
      ]);
    });

    it('reads a draft as a draft even when it is also archived, as the badge does', async () => {
      await mkEvent({
        slug: 'st-draftarch', event_name: 'S DraftArchived', is_draft: 1, is_archived: 1, archived_at: now(),
      });
      const names = (await listNames({ sortBy: 'status', sortOrder: 'asc' }))
        .filter((n) => n.startsWith('S '));
      // Grouped with the draft, ahead of inactive/archived — not pushed to the end.
      expect(names.indexOf('S DraftArchived')).toBeLessThan(names.indexOf('S Inactive'));
      expect(names.indexOf('S DraftArchived')).toBeGreaterThan(names.indexOf('S Expired'));
    });
  });

  describe('expiry', () => {
    it('puts the soonest expiry first and never-expiring galleries last', async () => {
      await mkEvent({ slug: 'no-expiry', event_name: 'X Never', expires_at: null });
      const names = await listNames({ sortBy: 'expires_at', sortOrder: 'asc' });
      expect(names[names.length - 1]).toBe('X Never');
      expect(names.indexOf('S Expired')).toBeLessThan(names.indexOf('S Expiring'));
    });

    it('keeps never-expiring galleries last descending too, not flipped to the top', async () => {
      // The engines disagree about where a NULL lands by default, so both
      // directions are pinned rather than only the one that happens to pass
      // on the database the suite last ran against.
      const names = await listNames({ sortBy: 'expires_at', sortOrder: 'desc' });
      expect(names[names.length - 1]).toBe('X Never');
      expect(names.indexOf('S Expiring')).toBeLessThan(names.indexOf('S Expired'));
    });
  });

  describe('type filter', () => {
    it('narrows the rows and the pagination total together', async () => {
      const res = await request(app)
        .get('/api/admin/events')
        .query({ limit: 100, type: 'baptism' })
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.events.map((e) => e.event_name)).toEqual(['apfel Taufe']);
      // The count is cloned before the ordering but after the filter, so a
      // filtered list must not report the unfiltered total.
      expect(res.body.pagination.total).toBe(1);
    });

    it('treats "all" as no filter', async () => {
      const all = await listNames({ type: 'all' });
      expect(all.length).toBeGreaterThan(1);
    });
  });

  describe('untrusted input', () => {
    // Asserting only "200, some rows" would pin the injection contract (no SQL
    // error) while saying nothing about the order these cases claim to fall
    // back to, so each compares the actual row order against a reference
    // query. Note the resolver falls back PER HALF: an unusable key does not
    // discard a usable direction, and vice versa.
    const expectSameOrder = async (query, reference) => {
      const rows = await listNames(query);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows).toEqual(await listNames(reference));
    };

    it('falls back to the default order when neither half is usable', async () => {
      await expectSameOrder(
        { sortBy: 'event_name); drop table events;--', sortOrder: 'sideways' },
        {},
      );
    });

    it('keeps a recognised column when only the direction is unusable', async () => {
      await expectSameOrder(
        { sortBy: 'event_name', sortOrder: 'sideways' },
        { sortBy: 'event_name', sortOrder: 'desc' },
      );
    });

    it('does not treat an inherited Object property as a sortable column', async () => {
      // The allowlist is an object literal, so a plain `in` or `[key]` lookup
      // would accept 'constructor' and 'toString' and put them into raw SQL.
      // The key falls back to created_at; the valid direction is kept.
      for (const sortBy of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
        await expectSameOrder(
          { sortBy, sortOrder: 'asc' },
          { sortBy: 'created_at', sortOrder: 'asc' },
        );
      }
    });

    it('no longer accepts capture_date, which is a photo column and threw', async () => {
      await expectSameOrder({ sortBy: 'capture_date' }, {});
    });
  });

  describe('mixed expires_at shapes on SQLite (issue 1733)', () => {
    // The extend endpoint bound a Date, which SQLite stored as epoch ms,
    // next to the ISO text normal creation writes. Numbers sort below every
    // text, so the raw column put a later epoch-ms expiry ahead of an
    // earlier ISO one and ranked it wrongly in the status sort.
    beforeAll(async () => {
      await mkEvent({ slug: 'mx-iso-2d', event_name: 'M Iso2d', expires_at: inDays(2) });
      await mkEvent({ slug: 'mx-ms-5d', event_name: 'M Ms5d', expires_at: Date.now() + 5 * DAY });
      await mkEvent({ slug: 'mx-iso-9d', event_name: 'M Iso9d', expires_at: inDays(9) });
      await mkEvent({ slug: 'mx-ms-past', event_name: 'M MsPast', expires_at: Date.now() - DAY });
    });

    it('orders expires_at by the point in time, not by the stored type', async () => {
      const names = (await listNames({ sortBy: 'expires_at', sortOrder: 'asc' }))
        .filter((n) => n.startsWith('M '));
      expect(names).toEqual(['M MsPast', 'M Iso2d', 'M Ms5d', 'M Iso9d']);
    });

    it('ranks an epoch-ms expiry in the status sort like an ISO one', async () => {
      const names = (await listNames({ sortBy: 'status', sortOrder: 'asc' }))
        .filter((n) => n.startsWith('M '));
      // active → expiring (within 7 days, ties by id desc) → expired: the
      // epoch-ms rows land in the same ranks as their ISO neighbours.
      expect(names).toEqual(['M Iso9d', 'M Ms5d', 'M Iso2d', 'M MsPast']);
    });
  });
});
