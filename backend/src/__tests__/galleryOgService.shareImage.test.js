/**
 * Unit tests for the per-event social-share preview opt-in (#474).
 *
 * Pins three contracts on `buildOgMetadata`:
 *   - opt-in OFF (or missing)            → og:image is the brand logo
 *   - opt-in ON without a hero photo     → og:image is the brand logo
 *   - opt-in ON + hero + thumbnail       → og:image is the public
 *                                          /og/gallery/<slug>/cover URL
 *
 * Plus the `handleGalleryOgCover` 404 path so we can't accidentally
 * widen the unauthenticated cover endpoint to expose a hero photo
 * the admin hasn't opted into sharing.
 */

jest.mock('../database/db', () => {
  const mockDb = jest.fn();
  return { db: mockDb };
});

jest.mock('../utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

jest.mock('../services/imageProcessor', () => ({
  ensureThumbnail: jest.fn(),
}));

jest.mock('../services/storage', () => ({
  getStorage: jest.fn(),
}));

const { db } = require('../database/db');
const { ensureThumbnail } = require('../services/imageProcessor');
const { getStorage } = require('../services/storage');
const {
  buildOgMetadata,
  handleGalleryOgCover,
  isSocialCrawler,
} = require('../services/galleryOgService');

// The service hits two tables in sequence:
//   1. events (slug lookup → may then hit event_slug_redirects)
//   2. app_settings (branding lookup)
// then optionally a third query when og_image_share_enabled is true:
//   3. photos (validate hero exists + has thumbnail)
//
// Each test queues responses on the shared mock in the order the
// service calls them.
function chain(result) {
  const q = {};
  ['where', 'whereIn', 'andWhere', 'select', 'orderBy', 'limit', 'first']
    .forEach((m) => { q[m] = jest.fn().mockReturnValue(q); });
  q.first = jest.fn().mockResolvedValue(result?.first);
  q.then = (resolve) => Promise.resolve(result?.rows ?? []).then(resolve);
  q.catch = () => q;
  return q;
}

function mockResolveSlug(event) {
  // events table query → return event row (or null + no redirects).
  db.mockImplementationOnce(() => chain({ first: event || null }));
  if (!event) {
    // event_slug_redirects fallback — unused here, return null.
    db.schema = db.schema || {};
    db.schema.hasTable = jest.fn().mockResolvedValue(false);
  }
}

function mockBranding() {
  // app_settings → fetchBranding rows. Empty = pure defaults.
  db.mockImplementationOnce(() => chain({ rows: [] }));
}

function mockHeroPhoto(photo) {
  db.mockImplementationOnce(() => chain({ first: photo }));
}

beforeEach(() => {
  db.mockReset();
  ensureThumbnail.mockReset();
  getStorage.mockReset();
  process.env.FRONTEND_URL = 'https://gallery.example.com';
});

// ---- buildOgMetadata: cover-vs-logo decision ---------------------------

describe('buildOgMetadata — share-image opt-in', () => {
  it('uses the brand logo when og_image_share_enabled is false (default)', async () => {
    mockResolveSlug({
      id: 1,
      slug: 'wedding-2026',
      event_name: 'Wedding 2026',
      event_date: '2026-06-12',
      welcome_message: null,
      hero_photo_id: 99,                  // hero IS picked
      og_image_share_enabled: false,      // ...but opt-in is off
    });
    mockBranding();

    const meta = await buildOgMetadata('wedding-2026', '/gallery/wedding-2026');

    // Falls back to the default logo URL — the picpeak-logo asset
    // since branding has no logo configured.
    expect(meta.image).toBe('https://gallery.example.com/picpeak-logo-transparent.png');
    // Confirm the photos table was NOT queried — opt-in off means no
    // hero lookup at all.
    expect(db).toHaveBeenCalledTimes(2); // events + app_settings only
  });

  it('uses the brand logo when opt-in is on but no hero photo is picked', async () => {
    mockResolveSlug({
      id: 2,
      slug: 'engagement',
      event_name: 'Engagement',
      event_date: null,
      welcome_message: null,
      hero_photo_id: null,                // no hero
      og_image_share_enabled: true,       // opt-in IS on
    });
    mockBranding();

    const meta = await buildOgMetadata('engagement', '/gallery/engagement');

    expect(meta.image).toBe('https://gallery.example.com/picpeak-logo-transparent.png');
    // photos table NOT queried — service short-circuits when hero_photo_id
    // is falsy, even with opt-in on.
    expect(db).toHaveBeenCalledTimes(2);
  });

  it('uses the cover URL when opt-in is on AND hero exists with a thumbnail', async () => {
    mockResolveSlug({
      id: 3,
      slug: 'birthday-2026',
      event_name: 'Birthday 2026',
      event_date: '2026-04-15',
      welcome_message: null,
      hero_photo_id: 42,
      og_image_share_enabled: true,
    });
    mockBranding();
    mockHeroPhoto({
      id: 42,
      thumbnail_path: 'thumbnails/thumb_birthday_42.jpg',
    });

    const meta = await buildOgMetadata('birthday-2026', '/gallery/birthday-2026');

    expect(meta.image).toBe('https://gallery.example.com/og/gallery/birthday-2026/cover');
  });

  it('falls back to the brand logo if the hero photo row is missing', async () => {
    // Defensive: hero_photo_id points to a photo that no longer
    // exists (e.g. deleted after admin enabled the toggle). The OG
    // page must still render with the logo, never a broken image
    // src in WhatsApp previews.
    mockResolveSlug({
      id: 4,
      slug: 'orphan',
      event_name: 'Orphan',
      hero_photo_id: 999,
      og_image_share_enabled: true,
    });
    mockBranding();
    mockHeroPhoto(null); // photo deleted

    const meta = await buildOgMetadata('orphan', '/gallery/orphan');

    expect(meta.image).toBe('https://gallery.example.com/picpeak-logo-transparent.png');
  });

  it('falls back to the brand logo if the hero photo has no thumbnail yet', async () => {
    // The hero exists but the background processor hasn't generated
    // its thumbnail yet (or the regenerate failed). Same fallback.
    mockResolveSlug({
      id: 5,
      slug: 'just-uploaded',
      event_name: 'Just Uploaded',
      hero_photo_id: 7,
      og_image_share_enabled: true,
    });
    mockBranding();
    mockHeroPhoto({ id: 7, thumbnail_path: null });

    const meta = await buildOgMetadata('just-uploaded', '/gallery/just-uploaded');

    expect(meta.image).toBe('https://gallery.example.com/picpeak-logo-transparent.png');
  });
});

// ---- handleGalleryOgCover: unauthenticated 404 contract ----------------

function makeRes() {
  const res = { headers: {} };
  res.status = jest.fn().mockReturnValue(res);
  res.type = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  res.set = jest.fn((kv) => { Object.assign(res.headers, kv); return res; });
  res.setHeader = jest.fn((k, v) => { res.headers[k] = v; });
  res.end = jest.fn().mockReturnValue(res);
  return res;
}

describe('handleGalleryOgCover — 404 unless explicitly opted in', () => {
  it('returns 400 on an invalid slug shape', async () => {
    const req = { params: { slug: '../../etc/passwd' }, headers: {} };
    const res = makeRes();
    await handleGalleryOgCover(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 404 when the event has og_image_share_enabled = false', async () => {
    mockResolveSlug({
      id: 1,
      slug: 'wedding-2026',
      hero_photo_id: 99,
      og_image_share_enabled: false,
    });
    const req = { params: { slug: 'wedding-2026' }, headers: {} };
    const res = makeRes();
    await handleGalleryOgCover(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    // Crucial: ensureThumbnail must NOT be called — we never want to
    // touch the storage backend for a non-opted-in gallery.
    expect(ensureThumbnail).not.toHaveBeenCalled();
  });

  it('returns 404 when the event opts in but has no hero_photo_id', async () => {
    mockResolveSlug({
      id: 2,
      slug: 'engagement',
      hero_photo_id: null,
      og_image_share_enabled: true,
    });
    const req = { params: { slug: 'engagement' }, headers: {} };
    const res = makeRes();
    await handleGalleryOgCover(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(ensureThumbnail).not.toHaveBeenCalled();
  });
});

// Regression for #521 — WhatsApp Business API + 3rd-party preview
// services use UAs that aren't "WhatsApp/X.Y.Z". If isSocialCrawler
// misses them, those requests fall through to the static SPA shell
// and the link preview ends up unbranded.
describe('isSocialCrawler — extended bot coverage (#521)', () => {
  it('matches every UA the README/changelog claims to support', () => {
    // Pin the contract: each listed UA must hit the crawler path so the
    // nginx rewrite + backend OG handler stay in sync. Adding a new UA
    // here without also adding it to nginx.conf would silently regress.
    const knownBots = [
      // Main WhatsApp app
      'WhatsApp/2.23.20.0',
      // WhatsApp Business / Cloud API variants
      'WhatsAppBot/1.0',
      'wa-bot/2.0',
      // Other messaging app crawlers
      'facebookexternalhit/1.1',
      'Twitterbot/1.0',
      'Slackbot-LinkExpanding 1.0',
      'TelegramBot (like TwitterBot)',
      // 3rd-party preview services used by business-messaging stacks
      'LinkPreview/1.0',
      'Slack-ImgProxy/1.0',
    ];
    for (const ua of knownBots) {
      expect(isSocialCrawler(ua)).toBe(true);
    }
  });

  it('does not match a regular browser UA', () => {
    const browsers = [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15',
      // Browser UA that happens to contain "Mobile" — guard against an
      // over-broad regex landing on it.
      'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36',
    ];
    for (const ua of browsers) {
      expect(isSocialCrawler(ua)).toBe(false);
    }
  });

  it('returns false for null/empty/undefined UAs', () => {
    expect(isSocialCrawler(null)).toBe(false);
    expect(isSocialCrawler(undefined)).toBe(false);
    expect(isSocialCrawler('')).toBe(false);
  });
});
