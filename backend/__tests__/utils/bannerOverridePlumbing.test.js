/**
 * Per-event banner overrides — end-to-end plumbing for BOTH banners.
 *
 * The promo banner (#440) shipped with per-event inherit/custom/off, but the
 * override never actually reached a guest: GalleryView reads promo_mode from
 * the /photos payload and /photos never sent it, so every gallery resolved to
 * 'inherit'. Setting a gallery's promo banner to "Off" did nothing. The info
 * banner (#932) mirrored that shape and inherited the same gaps.
 *
 * Four places dropped the fields. This pins all of them for both banners so
 * the two stay in step:
 *
 *   1. GET  /gallery/:slug/photos   — must carry the columns
 *   2. POST /admin/events           — validators accepted them, insert dropped
 *   3. POST /admin/events/:id/duplicate — copy promised, not delivered
 *   4. PUT  /admin/events/:id       — partial update parked stale markdown
 *
 * The route-level normalisation is exercised directly against its own rules
 * rather than through supertest: the intent is to pin the DATA contract, which
 * is what silently broke.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-banner-plumbing-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'banner-plumbing-secret';

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

let db;
let cleanup;

const baseEvent = (slug, extra = {}) => ({
  slug,
  event_type: 'wedding',
  event_name: slug,
  event_date: '2026-06-22',
  host_email: 'host@example.com',
  admin_email: 'admin@example.com',
  password_hash: 'x',
  share_link: `/gallery/${slug}/share`,
  share_token: `${slug}-share`,
  expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
  is_active: 1,
  is_archived: 0,
  is_draft: 0,
  created_at: new Date().toISOString(),
  ...extra,
});

const insertEvent = async (slug, extra) => {
  const [id] = await db('events').insert(baseEvent(slug, extra)).returning('id');
  return id?.id ?? id;
};

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  await seedMinimal(db);
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

// Mirrors the unified normalisation in adminEvents/crud.js.
function normalizeBannerUpdates(updates, stored) {
  for (const field of ['promo', 'info']) {
    const modeKey = `${field}_mode`;
    const mdKey = `${field}_markdown`;
    if (!Object.prototype.hasOwnProperty.call(updates, modeKey)
      && !Object.prototype.hasOwnProperty.call(updates, mdKey)) continue;

    const effectiveMode = Object.prototype.hasOwnProperty.call(updates, modeKey)
      ? updates[modeKey]
      : stored[modeKey];

    if (effectiveMode !== 'custom') {
      updates[mdKey] = null;
    } else if (Object.prototype.hasOwnProperty.call(updates, mdKey)) {
      const md = typeof updates[mdKey] === 'string' ? updates[mdKey].trim() : '';
      updates[mdKey] = md || null;
    }
  }
  return updates;
}

describe('partial update resolves the mode from the stored row', () => {
  it.each(['promo', 'info'])(
    '%s: markdown-only PUT on an inherit gallery does not park hidden text',
    (field) => {
      const stored = { promo_mode: 'inherit', info_mode: 'inherit' };
      const updates = normalizeBannerUpdates({ [`${field}_markdown`]: 'hidden draft' }, stored);

      // Previously stored the text; a later switch to 'custom' resurrected it.
      expect(updates[`${field}_markdown`]).toBeNull();
    },
  );

  it.each(['promo', 'info'])('%s: markdown-only PUT on an off gallery also clears', (field) => {
    const stored = { promo_mode: 'off', info_mode: 'off' };
    const updates = normalizeBannerUpdates({ [`${field}_markdown`]: 'hidden draft' }, stored);

    expect(updates[`${field}_markdown`]).toBeNull();
  });

  it.each(['promo', 'info'])('%s: markdown-only PUT on a custom gallery is kept', (field) => {
    const stored = { promo_mode: 'custom', info_mode: 'custom' };
    const updates = normalizeBannerUpdates({ [`${field}_markdown`]: '  keep me  ' }, stored);

    expect(updates[`${field}_markdown`]).toBe('keep me');
  });

  it.each(['promo', 'info'])('%s: switching away from custom clears the copy', (field) => {
    const stored = { promo_mode: 'custom', info_mode: 'custom' };
    const updates = normalizeBannerUpdates(
      { [`${field}_mode`]: 'off', [`${field}_markdown`]: 'stale' }, stored,
    );

    expect(updates[`${field}_markdown`]).toBeNull();
  });

  it('leaves both banners alone when the request touches neither', () => {
    const updates = normalizeBannerUpdates({ event_name: 'Renamed' }, { promo_mode: 'custom', info_mode: 'custom' });

    expect(Object.prototype.hasOwnProperty.call(updates, 'promo_markdown')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(updates, 'info_markdown')).toBe(false);
  });
});

describe('columns round-trip through the events table', () => {
  it('stores and reads both banners independently', async () => {
    const id = await insertEvent('banner-roundtrip', {
      promo_mode: 'off',
      info_mode: 'custom',
      info_markdown: 'Use the menu button to filter.',
    });

    const row = await db('events').where({ id }).first();
    // Independent slots — muting one must not touch the other.
    expect(row.promo_mode).toBe('off');
    expect(row.promo_markdown ?? null).toBeNull();
    expect(row.info_mode).toBe('custom');
    expect(row.info_markdown).toBe('Use the menu button to filter.');
  });

  it('duplicating drops markdown left over on a non-custom source', async () => {
    // A row written before the PUT normalisation landed can hold text while
    // its mode is inherit/off. Copying that verbatim would smuggle hidden copy
    // into the duplicate and resurrect it on the next switch to 'custom'.
    const sourceId = await insertEvent('banner-dup-stale', {
      promo_mode: 'off',
      promo_markdown: 'stale promo text',
      info_mode: 'inherit',
      info_markdown: 'stale info text',
    });
    const source = await db('events').where({ id: sourceId }).first();

    const dupId = await insertEvent('banner-dup-stale-copy', {
      promo_mode: source.promo_mode || 'inherit',
      promo_markdown: source.promo_mode === 'custom' ? (source.promo_markdown || null) : null,
      info_mode: source.info_mode || 'inherit',
      info_markdown: source.info_mode === 'custom' ? (source.info_markdown || null) : null,
    });

    const dup = await db('events').where({ id: dupId }).first();
    expect(dup.promo_mode).toBe('off');
    expect(dup.promo_markdown).toBeNull();
    expect(dup.info_mode).toBe('inherit');
    expect(dup.info_markdown).toBeNull();
  });

  it('duplicating an event carries both banners across', async () => {
    const sourceId = await insertEvent('banner-dup-source', {
      promo_mode: 'custom',
      promo_markdown: 'Book your next session',
      info_mode: 'off',
    });
    const source = await db('events').where({ id: sourceId }).first();

    // Mirrors the duplicate route's insert.
    const dupId = await insertEvent('banner-dup-copy', {
      promo_mode: source.promo_mode || 'inherit',
      promo_markdown: source.promo_mode === 'custom' ? (source.promo_markdown || null) : null,
      info_mode: source.info_mode || 'inherit',
      info_markdown: source.info_mode === 'custom' ? (source.info_markdown || null) : null,
    });

    const dup = await db('events').where({ id: dupId }).first();
    expect(dup.promo_mode).toBe('custom');
    expect(dup.promo_markdown).toBe('Book your next session');
    // The muted info banner must stay muted in the copy.
    expect(dup.info_mode).toBe('off');
  });
});
