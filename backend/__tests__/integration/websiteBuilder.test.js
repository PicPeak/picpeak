/**
 * Website builder (issue 2618) against SQLite with every core migration:
 * the admin API, the public renderer, the public image endpoint and the
 * contact form, including the security rules each of them carries.
 */
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const sharp = require('sharp');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, setFeatureFlags,
} = require('./helpers/crmDb');

jest.setTimeout(120000);

// ffmpeg is not part of the test run: the hero video's remux is stood in for
// by a copy, the probe by a fixed answer.
const mockProbe = jest.fn();
jest.mock('../../src/services/videoRenditionService', () => ({
  probe: (...args) => mockProbe(...args),
  playsInBrowser: () => true,
  transcode: (src, out) => require('fs').promises.copyFile(src, out),
}));

let db; let cleanup; let app;
let adminId; let viewerId;
let service; let media; let cache;

async function insertId(table, row) {
  const [inserted] = await db(table).insert(row).returning('id');
  return inserted?.id ?? inserted;
}

async function setSetting(key, value, type = 'general') {
  await db('app_settings').where({ setting_key: key }).del();
  await db('app_settings').insert({ setting_key: key, setting_value: JSON.stringify(value), setting_type: type, updated_at: new Date().toISOString() });
}

let seq = 0;
async function insertEvent(over = {}) {
  seq += 1;
  return insertId('events', {
    slug: `site-${seq}`, event_type: 'wedding', event_name: `Gallery ${seq}`, event_date: '2026-06-01',
    host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x', require_password: 0,
    share_link: `/gallery/site-${seq}/tok${seq}`, share_token: `secret-share-token-${seq}`,
    expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
    is_active: 1, is_archived: 0, is_draft: 0, show_on_website: 1,
    created_at: new Date().toISOString(),
    ...over,
  });
}

async function insertPhoto(eventId) {
  seq += 1;
  const rel = `site/${seq}.jpg`;
  const abs = path.join(process.env.STORAGE_PATH, 'events/active', rel);
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  await sharp({ create: { width: 1600, height: 1000, channels: 3, background: { r: 40, g: 90, b: 160 } } }).jpeg().toFile(abs);
  return insertId('photos', {
    event_id: eventId, filename: `${seq}.jpg`, original_filename: `${seq}.jpg`, path: rel, type: 'individual',
    width: 1600, height: 1000, processing_status: 'complete', source_origin: 'managed', rendition_version: 1,
    mime_type: 'image/jpeg', media_type: 'photo',
  });
}

const auth = (id) => ({ Authorization: `Bearer ${mintAdminToken(id)}` });

function photoUrl(id, width = 640) {
  return `${media.mediaBase({ source: 'photo', id })}/${width}`;
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ adminId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  viewerId = await insertId('admin_users', { username: 'viewer', email: 'viewer@example.com', password_hash: 'x', must_change_password: false, created_at: new Date().toISOString() });
  await assignAdminRole(db, viewerId, 'viewer');
  require('../../src/middleware/permissions').clearPermissionCache();

  service = require('../../src/services/website/service');
  media = require('../../src/services/website/media');
  cache = require('../../src/services/website/cache');

  app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  app.use('/api/admin/website', require('../../src/routes/adminWebsite'));
  app.use('/api/public/website', require('../../src/routes/publicWebsite'));
  app.use('/site-media', require('../../src/routes/publicWebsiteMedia'));
  app.use('/api/admin/events', require('../../src/routes/adminEvents'));
  app.use('/api/admin/settings', require('../../src/routes/adminSettings'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ error: err.message, code: err.code, details: err.details }));
});

afterAll(async () => { if (cleanup) await cleanup(); });

beforeEach(() => cache.clearWebsiteCache());

describe('admin API', () => {
  test('refuses every route while the flag is off', async () => {
    await setFeatureFlags(db, { websiteBuilder: false });
    const res = await request(app).get('/api/admin/website').set(auth(adminId));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WEBSITE_BUILDER_DISABLED');
    expect((await request(app).post('/api/admin/website/preview').set(auth(adminId)).send({ document: {} })).status).toBe(403);
  });

  test('every in-page link of the starter site leads somewhere', async () => {
    await setFeatureFlags(db, { websiteBuilder: true });
    // A fresh install: the template migration 043 seeded, site switched off.
    const { document: raw, imported } = await service._internal.initialDocument();
    expect(imported).toBe(false);
    const { document } = require('../../src/services/website/document').normalizeDocument(raw);
    const page = document.pages[0];
    const html = (await request(app).post('/api/admin/website/preview').set(auth(adminId)).send({ document, pageId: page.id })).body.html;
    const anchors = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
    expect(anchors.length).toBeGreaterThan(0);
    for (const anchor of anchors) expect(html).toContain(`id="${anchor}"`);
  });

  test('the seeded template is imported only when visitors see it', async () => {
    await setSetting('general_public_site_enabled', true);
    expect((await service._internal.initialDocument()).imported).toBe(true);
    await setSetting('general_public_site_enabled', false);
  });

  test('imports the single-page site into the first draft', async () => {
    await setSetting('general_public_site_html', '<section class="hero"><h1>Old site {{company_name}}</h1></section>');
    await setSetting('general_public_site_custom_css', '.legacy-rule{color:red}');
    await setFeatureFlags(db, { websiteBuilder: true });
    const res = await request(app).get('/api/admin/website').set(auth(adminId));
    expect(res.status).toBe(200);
    const [home] = res.body.document.pages;
    expect(home).toMatchObject({ isHome: true, slug: 'home' });
    expect(home.blocks).toHaveLength(1);
    expect(home.blocks[0]).toMatchObject({ type: 'customHtml' });
    expect(home.blocks[0].html).toContain('Old site');
    expect(res.body.document.customCss).toContain('.legacy-rule{color:red}');
    expect(res.body.published).toBeNull();
    // The editor warns that publishing shows nothing while the site is off.
    expect(res.body.publicSiteEnabled).toBe(false);
    // Imported once: a second open keeps the draft as it is.
    await setSetting('general_public_site_html', '<p>changed</p>');
    const again = await request(app).get('/api/admin/website').set(auth(adminId));
    expect(again.body.document.pages[0].blocks[0].html).toContain('Old site');
  });

  test('a viewer may read but not change the site', async () => {
    expect((await request(app).get('/api/admin/website').set(auth(viewerId))).status).toBe(200);
    const res = await request(app).put('/api/admin/website/draft').set(auth(viewerId)).send({ document: { pages: [] } });
    expect(res.status).toBe(403);
    expect((await request(app).post('/api/admin/website/publish').set(auth(viewerId)).send({})).status).toBe(403);
  });

  test('refuses reserved and cms-owned slugs, and a stale revision', async () => {
    await db('cms_pages').insert({ slug: 'faq', title_en: 'FAQ', title_de: 'FAQ', content_en: '', content_de: '' });
    const state = (await request(app).get('/api/admin/website').set(auth(adminId))).body;
    const pages = [{ id: 'home', title: 'Home', slug: 'home', isHome: true }, { id: 'x', title: 'X', slug: 'admin' }, { id: 'y', title: 'Y', slug: 'faq' }];
    const bad = await request(app).put('/api/admin/website/draft').set(auth(adminId)).send({ document: { pages }, revision: state.draft.revision });
    expect(bad.status).toBe(422);
    expect(bad.body.details.map((d) => d.code).sort()).toEqual(['SLUG_RESERVED', 'SLUG_TAKEN_BY_CMS_PAGE']);

    const stale = await request(app).put('/api/admin/website/draft').set(auth(adminId))
      .send({ document: { pages: [pages[0]] }, revision: state.draft.revision - 1 });
    expect(stale.status).toBe(409);
  });

  test('saves, previews without caching, and publishes atomically', async () => {
    const state = (await request(app).get('/api/admin/website').set(auth(adminId))).body;
    const document = {
      pages: [
        { id: 'home', title: 'Home', slug: 'home', isHome: true, blocks: [{ id: 'h1', type: 'hero', heading: 'Published hero' }] },
        { id: 'about', title: 'About', slug: 'about', blocks: [{ id: 't1', type: 'text', body: 'About us' }] },
        { id: 'hidden', title: 'Hidden', slug: 'hidden', hidden: true, blocks: [] },
      ],
    };
    const saved = await request(app).put('/api/admin/website/draft').set(auth(adminId)).send({ document, revision: state.draft.revision });
    expect(saved.status).toBe(200);
    expect(saved.body.hasUnpublishedChanges).toBe(true);

    const published = await request(app).post('/api/admin/website/publish').set(auth(adminId)).send({ revision: saved.body.draft.revision });
    expect(published.status).toBe(200);
    expect(published.body.hasUnpublishedChanges).toBe(false);
    expect(published.body.published.publishedAt).toBeTruthy();

    // A later draft edit is visible in the preview only.
    const draft = { ...document, pages: [{ ...document.pages[0], blocks: [{ id: 'h1', type: 'hero', heading: 'Draft hero' }] }, ...document.pages.slice(1)] };
    await request(app).put('/api/admin/website/draft').set(auth(adminId)).send({ document: draft, revision: published.body.draft.revision }).expect(200);
    const preview = await request(app).post('/api/admin/website/preview').set(auth(adminId)).send({ document: draft, pageId: 'home' });
    expect(preview.status).toBe(200);
    expect(preview.headers['cache-control']).toBe('no-store');
    expect(preview.body.html).toContain('Draft hero');
    expect(preview.body.html).toContain('data-block-id="h1"');

    await setSetting('general_public_site_enabled', true);
    const live = await service.resolvePublicPage('');
    expect(live.html).toContain('Published hero');
    expect(live.html).not.toContain('Draft hero');
    expect(live.html).not.toContain('data-block-id');
  });

  test('a document over a limit is refused whole, not shortened', async () => {
    const state = (await request(app).get('/api/admin/website').set(auth(adminId))).body;
    const blocks = Array.from({ length: 61 }, (_, i) => ({ id: `s${i}`, type: 'spacer' }));
    const res = await request(app).put('/api/admin/website/draft').set(auth(adminId))
      .send({ document: { pages: [{ id: 'home', title: 'Home', slug: 'home', isHome: true, blocks }] }, revision: state.draft.revision });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('WEBSITE_LIMIT_EXCEEDED');
    expect(res.body.details).toEqual([expect.objectContaining({ code: 'TOO_MANY_BLOCKS', pageId: 'home', max: 60 })]);
    const after = (await request(app).get('/api/admin/website').set(auth(adminId))).body;
    expect(after.draft.revision).toBe(state.draft.revision);
  });

  test('package prices resolve hourly and daily items like the catalogue does', async () => {
    await setFeatureFlags(db, { quotes: true });
    const now = new Date().toISOString();
    const preset = (row) => insertId('quote_line_item_presets', { currency: 'CHF', quantity_default: 1, is_active: true, created_at: now, updated_at: now, ...row });
    const pkg = async (name, items) => {
      const id = await insertId('quote_packages', { name, currency: 'CHF', display_order: 0, is_active: true, created_at: now, updated_at: now });
      let position = 1;
      for (const [presetId, quantity] of items) {
        // eslint-disable-next-line no-await-in-loop
        await db('quote_package_items').insert({ package_id: id, preset_id: presetId, quantity, position: position++, created_at: now, updated_at: now });
      }
      return id;
    };
    await db('business_profile').update({ default_day_rate_minor: 200000, default_hourly_rate_minor: null });
    const fixed = await preset({ name: 'Album', unit_price_minor: 100000, price_mode: 'fixed' });
    // Hour and day items carry unit_price_minor 0: the price is their rate.
    const hourly = await preset({ name: 'Coverage', unit_price_minor: 0, price_mode: 'hour', pinned_rate_minor: 15000 });
    const daily = await preset({ name: 'Second shooter', unit_price_minor: 0, price_mode: 'day' });
    const hourlyNoRate = await preset({ name: 'Editing', unit_price_minor: 0, price_mode: 'hour' });
    const hourPkg = await pkg('Hourly', [[hourly, 4]]);
    const dayPkg = await pkg('Daily', [[daily, 2]]);
    const mixed = await pkg('Mixed', [[fixed, 1], [hourly, 4], [daily, 2]]);
    const unpriced = await pkg('No rate', [[fixed, 1], [hourlyNoRate, 3]]);
    const packages = await service._internal.loadPackages([hourPkg, dayPkg, mixed, unpriced]);
    expect(packages.get(hourPkg).totalMinor).toBe(60000);
    expect(packages.get(dayPkg).totalMinor).toBe(400000);
    expect(packages.get(mixed).totalMinor).toBe(560000);
    // An hourly item without any rate has no price; the package shows none
    // rather than a sum that leaves it out.
    expect(packages.get(unpriced).totalMinor).toBeNull();
    await setFeatureFlags(db, { quotes: false });
  });

  test('packages are unavailable while quotes are off', async () => {
    await setFeatureFlags(db, { quotes: false });
    const res = await request(app).get('/api/admin/website/packages').set(auth(adminId));
    expect(res.body).toEqual({ available: false, packages: [] });
  });
});

describe('public pages', () => {
  test('resolve only while the flag is on and the public site is enabled', async () => {
    expect(await service.resolvePublicPage('')).toMatchObject({ status: 200 });
    expect((await service.resolvePublicPage('about')).html).toContain('About us');
    expect(await service.resolvePublicPage('home')).toEqual({ status: 301, location: '/' });
    expect(await service.resolvePublicPage('hidden')).toBeNull();
    expect(await service.resolvePublicPage('nope')).toBeNull();

    await setFeatureFlags(db, { websiteBuilder: false });
    cache.clearWebsiteCache();
    expect(await service.resolvePublicPage('')).toBeNull();
    expect(await service.resolvePublicPage('about')).toBeNull();
    await setFeatureFlags(db, { websiteBuilder: true });

    await setSetting('general_public_site_enabled', false);
    cache.clearWebsiteCache();
    expect(await service.resolvePublicPage('')).toBeNull();
    await setSetting('general_public_site_enabled', true);
  });

  test('the booking block links the booking page only while booking is on with a bookable service', async () => {
    const state = (await request(app).get('/api/admin/website').set(auth(adminId))).body;
    const document = {
      pages: [
        { id: 'home', title: 'Home', slug: 'home', isHome: true, blocks: [{ id: 'bk', type: 'booking', heading: 'Book a session' }] },
        { id: 'about', title: 'About', slug: 'about', blocks: [] },
      ],
    };
    const saved = await request(app).put('/api/admin/website/draft').set(auth(adminId)).send({ document, revision: state.draft.revision }).expect(200);
    await request(app).post('/api/admin/website/publish').set(auth(adminId)).send({ revision: saved.body.draft.revision }).expect(200);
    await setFeatureFlags(db, { calendarBooking: true });
    cache.clearWebsiteCache();
    // On, but nothing can be booked yet: the page would only say so.
    expect((await service.resolvePublicPage('')).html).not.toContain('href="/book"');
    await db('quote_line_item_presets').insert({ name: 'Portrait session', unit_price_minor: 45000, currency: 'CHF', bookable: true, is_active: true, created_at: new Date().toISOString() });
    cache.clearWebsiteCache();
    expect((await service.resolvePublicPage('')).html).toContain('href="/book"');
    await setFeatureFlags(db, { calendarBooking: false });
    cache.clearWebsiteCache();
    expect((await service.resolvePublicPage('')).html).not.toContain('Book a session');
  });

  test('sitemap lists the visible pages once indexing is on and the origin known', async () => {
    await setSetting('seo_allow_indexing', true, 'seo');
    await setSetting('general_site_url', 'https://studio.example');
    require('../../src/utils/frontendUrl').invalidateSiteUrlCache();
    await require('../../src/utils/frontendUrl').primeSiteUrlCache();
    const xml = await service.sitemapXml();
    expect(xml).toContain('<loc>https://studio.example/</loc>');
    expect(xml).toContain('<loc>https://studio.example/about</loc>');
    expect(xml).not.toContain('hidden');
  });
});

describe('gallery photos on the website', () => {
  let openEvent; let openPhoto; let lockedEvent; let lockedPhoto; let lockedOther; let optedOutPhoto; let expiredEvent;

  beforeAll(async () => {
    openEvent = await insertEvent();
    openPhoto = await insertPhoto(openEvent);
    // Opted in although it has a password: the opt-in is the owner's consent
    // for the photos they pick, not for the rest of the gallery.
    lockedEvent = await insertEvent({ require_password: 1 });
    lockedPhoto = await insertPhoto(lockedEvent);
    lockedOther = await insertPhoto(lockedEvent);
    expiredEvent = await insertEvent({ expires_at: new Date(Date.now() - 86400000).toISOString() });
    optedOutPhoto = await insertPhoto(await insertEvent({ show_on_website: 0 }));
    const state = (await request(app).get('/api/admin/website').set(auth(adminId))).body;
    const document = {
      pages: [{
        id: 'home', title: 'Home', slug: 'home', isHome: true,
        blocks: [
          { id: 'g1', type: 'gallery', images: [openPhoto, lockedPhoto, optedOutPhoto].map((id) => ({ source: 'photo', id })) },
          { id: 'f1', type: 'featuredGalleries', galleries: [{ id: openEvent }, { id: lockedEvent }] },
          { id: 'c1', type: 'contact' },
        ],
      }],
    };
    const saved = await request(app).put('/api/admin/website/draft').set(auth(adminId)).send({ document, revision: state.draft.revision }).expect(200);
    await request(app).post('/api/admin/website/publish').set(auth(adminId)).send({ revision: saved.body.draft.revision }).expect(200);
  });

  test('picked photos of opted-in galleries are rendered, with or without a password; nothing else is', async () => {
    const { html } = await service.resolvePublicPage('');
    expect(html).toContain(`/site-media/p${openPhoto}.`);
    expect(html).toContain(`/site-media/p${lockedPhoto}.`);
    // The protected gallery has no cover of its own: its card shows none
    // rather than one of the photos nobody picked.
    expect(html).not.toContain(`/site-media/p${lockedOther}.`);
    expect(html).not.toContain(`/site-media/p${optedOutPhoto}.`);
    const openSlug = (await db('events').where({ id: openEvent }).first()).slug;
    expect(html).toContain(`href="/gallery/${openSlug}"`);
    // Its card links to the gallery, where the password still applies.
    const lockedSlug = (await db('events').where({ id: lockedEvent }).first()).slug;
    expect(html).toContain(`href="/gallery/${lockedSlug}"`);
    expect(html).not.toContain('secret-share-token');
  });

  test('a protected gallery card shows the cover its owner chose', async () => {
    await db('events').where({ id: lockedEvent }).update({ hero_photo_id: lockedOther });
    cache.clearWebsiteCache();
    expect((await service.resolvePublicPage('')).html).toContain(`/site-media/p${lockedOther}.`);
    await db('events').where({ id: lockedEvent }).update({ hero_photo_id: null });
    cache.clearWebsiteCache();
  });

  test('the image endpoint serves a rendition of an eligible photo, nothing else', async () => {
    const ok = await request(app).get(photoUrl(openPhoto));
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('image/jpeg');
    const meta = await sharp(ok.body).metadata();
    expect(meta.width).toBe(640);

    expect((await request(app).get(photoUrl(lockedPhoto))).status).toBe(200);
    expect((await request(app).get(photoUrl(optedOutPhoto))).status).toBe(404);
    expect((await request(app).get(photoUrl(openPhoto, 999))).status).toBe(404);
    expect((await request(app).get(`/site-media/p${openPhoto}.${'0'.repeat(32)}/640`)).status).toBe(404);
    // A signature for one photo does not open another: the protected
    // gallery's unpicked photos have no URL anyone was given.
    const sig = photoUrl(lockedPhoto).split('.')[1].split('/')[0];
    expect((await request(app).get(`/site-media/p${lockedOther}.${sig}/640`)).status).toBe(404);
    expect((await request(app).get(`${media.mediaBase({ source: 'photo', id: openPhoto })}/video`)).status).toBe(404);
  });

  test('turning the gallery off removes its photos at once, cached page or not', async () => {
    const before = await service.resolvePublicPage('');
    expect(before.html).toContain(`/site-media/p${lockedPhoto}.`);
    const res = await request(app).put(`/api/admin/website/galleries/${lockedEvent}`).set(auth(adminId)).send({ showOnWebsite: false });
    expect(res.status).toBe(200);
    expect((await request(app).get(photoUrl(lockedPhoto))).status).toBe(404);
    expect((await service.resolvePublicPage('')).html).not.toContain(`/site-media/p${lockedPhoto}.`);
    await request(app).put(`/api/admin/website/galleries/${lockedEvent}`).set(auth(adminId)).send({ showOnWebsite: true }).expect(200);
    expect((await request(app).get(photoUrl(lockedPhoto))).status).toBe(200);
  });

  test('an expired or archived gallery and a disabled flag close the endpoint', async () => {
    await db('events').where({ id: openEvent }).update({ expires_at: new Date(Date.now() - 86400000).toISOString() });
    expect((await request(app).get(photoUrl(openPhoto))).status).toBe(404);
    await db('events').where({ id: openEvent }).update({ expires_at: new Date(Date.now() + 86400000).toISOString(), is_archived: 1 });
    expect((await request(app).get(photoUrl(openPhoto))).status).toBe(404);
    await db('events').where({ id: openEvent }).update({ is_archived: 0 });
    await setFeatureFlags(db, { websiteBuilder: false });
    expect((await request(app).get(photoUrl(openPhoto))).status).toBe(404);
    await setFeatureFlags(db, { websiteBuilder: true });
    expect((await request(app).get(photoUrl(openPhoto))).status).toBe(200);
  });

  test('the picker lists eligible galleries, flags a password, and refuses the photos of others', async () => {
    const list = await request(app).get('/api/admin/website/galleries').set(auth(adminId));
    expect(list.body.galleries.find((g) => g.id === lockedEvent)).toMatchObject({ showOnWebsite: true, eligible: true, reason: null, hasPassword: true });
    expect(list.body.galleries.find((g) => g.id === expiredEvent)).toMatchObject({ showOnWebsite: true, eligible: false, reason: 'unavailable' });
    expect((await request(app).get(`/api/admin/website/galleries/${expiredEvent}/photos`).set(auth(adminId))).status).toBe(409);
    const photos = await request(app).get(`/api/admin/website/galleries/${lockedEvent}/photos`).set(auth(adminId));
    expect(photos.status).toBe(200);
    expect(photos.body.photos.map((p) => p.id)).toEqual([lockedPhoto, lockedOther]);
  });

  test('the opt-in reads "false" and "0" as off, not as a truthy string', async () => {
    const put = (value) => request(app).put(`/api/admin/website/galleries/${lockedEvent}`).set(auth(adminId)).send({ showOnWebsite: value });
    const stored = async () => Boolean((await db('events').where({ id: lockedEvent }).first()).show_on_website);
    for (const [value, expected] of [['false', false], ['true', true], ['0', false], ['1', true], [false, false], [true, true]]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await put(value);
      expect(res.status).toBe(200);
      expect(res.body.showOnWebsite).toBe(expected);
      // eslint-disable-next-line no-await-in-loop
      expect(await stored()).toBe(expected);
    }
  });

  test('a viewer cannot opt a gallery in', async () => {
    const res = await request(app).put(`/api/admin/website/galleries/${lockedEvent}`).set(auth(viewerId)).send({ showOnWebsite: true });
    expect(res.status).toBe(403);
  });
});

describe('uploads', () => {
  let uploaded;

  test('an uploaded image becomes renditions only, served through the endpoint', async () => {
    const png = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png().toBuffer();
    const res = await request(app).post('/api/admin/website/assets').set(auth(adminId)).attach('file', png, 'red.png');
    expect(res.status).toBe(201);
    uploaded = res.body.asset;
    expect(uploaded).toMatchObject({ kind: 'image', width: 2400, height: 1600 });
    const row = await db('website_assets').where({ public_id: uploaded.id }).first();
    const keys = JSON.parse(row.rendition_keys);
    expect(Object.keys(keys).sort()).toEqual(['1280', '1920', '640']);
    for (const key of Object.values(keys)) expect(key).toMatch(new RegExp(`^website/${uploaded.id}/w(640|1280|1920)\\.jpg$`));
    // The intermediate preview files are gone; the website/ copies are the only ones.
    expect(fs.readdirSync(path.join(process.env.STORAGE_PATH, 'previews')).filter((f) => f.includes(uploaded.id))).toEqual([]);
    const served = await request(app).get(uploaded.previewUrl);
    expect(served.status).toBe(200);
    expect((await sharp(served.body).metadata()).width).toBe(640);
    // Nothing else was kept of the upload.
    expect(fs.readdirSync(path.join(process.env.STORAGE_PATH, 'temp'))).toEqual([]);
  });

  test('a file that is not an image is refused', async () => {
    const res = await request(app).post('/api/admin/website/assets').set(auth(adminId)).attach('file', Buffer.from('<svg onload=alert(1)>'), 'x.png');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('WEBSITE_ASSET_TYPE');
  });

  test('an image used on the site cannot be deleted; an unused one can', async () => {
    const state = (await request(app).get('/api/admin/website').set(auth(adminId))).body;
    const doc = state.document;
    doc.pages[0].blocks.push({ id: 'i1', type: 'imageText', image: { source: 'asset', id: uploaded.id } });
    const saved = await request(app).put('/api/admin/website/draft').set(auth(adminId)).send({ document: doc, revision: state.draft.revision }).expect(200);
    const blocked = await request(app).delete(`/api/admin/website/assets/${uploaded.id}`).set(auth(adminId));
    expect(blocked.status).toBe(409);
    doc.pages[0].blocks.pop();
    await request(app).put('/api/admin/website/draft').set(auth(adminId)).send({ document: doc, revision: saved.body.draft.revision }).expect(200);
    expect((await request(app).delete(`/api/admin/website/assets/${uploaded.id}`).set(auth(adminId))).status).toBe(204);
    expect((await request(app).get(uploaded.previewUrl)).status).toBe(404);
  });
});

describe('hero video', () => {
  // An ISO-BMFF header with an mp4 brand, then filler.
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(4), Buffer.from('mp42isom'), Buffer.alloc(2000, 7)]);

  test('an uploaded video is served with ranges; an over-long one is refused', async () => {
    mockProbe.mockResolvedValue({ duration: 12, width: 1920, height: 1080 });
    const res = await request(app).post('/api/admin/website/assets').set(auth(adminId)).attach('file', mp4, { filename: 'loop.mp4', contentType: 'video/mp4' });
    expect(res.status).toBe(201);
    expect(res.body.asset).toMatchObject({ kind: 'video', width: 1920, previewUrl: null });
    const ranged = await request(app).get(res.body.asset.videoUrl).set('Range', 'bytes=0-9');
    expect(ranged.status).toBe(206);
    expect(ranged.headers['content-range']).toBe(`bytes 0-9/${mp4.length}`);
    expect(ranged.headers['content-type']).toBe('video/mp4');
    // A video is not an image tier, and an image tier is not a video.
    expect((await request(app).get(res.body.asset.videoUrl.replace(/\/video$/, '/640'))).status).toBe(404);

    mockProbe.mockResolvedValue({ duration: 600 });
    const long = await request(app).post('/api/admin/website/assets').set(auth(adminId)).attach('file', mp4, { filename: 'long.mp4', contentType: 'video/mp4' });
    expect(long.status).toBe(400);
    expect(long.body.code).toBe('WEBSITE_ASSET_TOO_LONG');
  });

  test('a file that only claims to be MP4 is refused', async () => {
    const res = await request(app).post('/api/admin/website/assets').set(auth(adminId)).attach('file', Buffer.from('not a video'), { filename: 'x.mp4', contentType: 'video/mp4' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('WEBSITE_ASSET_TYPE');
  });
});

describe('contact form', () => {
  let ip = 0;
  const post = (fields, headers = {}) => {
    ip += 1;
    const req = request(app).post('/api/public/website/contact').set('X-Forwarded-For', `203.0.113.${ip}`).set('Sec-Fetch-Site', 'same-origin');
    Object.entries(headers).forEach(([k, v]) => req.set(k, v));
    Object.entries(fields).forEach(([k, v]) => req.field(k, v));
    return req;
  };
  const valid = { page: 'home', block: 'c1', name: 'Ada <b>', email: 'ada@example.com', message: '<script>alert(1)</script>\nSee you' };

  test('stores a plain-text message in the customers inbox and sends nothing', async () => {
    const res = await post(valid);
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/#contact-sent-c1');
    const row = await db('received_emails').where('from_address', 'ada@example.com').first();
    expect(row).toMatchObject({ account_key: 'customers', body_html: null, mailbox_state: 'active' });
    expect(row.body_text).toContain('<script>alert(1)</script>\nSee you');
    expect(row.subject).toBe('Website enquiry from Ada <b>');
    expect(await db('email_queue').count({ c: '*' }).first()).toMatchObject({ c: 0 });
  });

  test('the honeypot answers like a success and stores nothing', async () => {
    const res = await post({ ...valid, email: 'bot@example.com', company_website: 'http://spam' });
    expect(res.headers.location).toBe('/#contact-sent-c1');
    expect(await db('received_emails').where('from_address', 'bot@example.com').first()).toBeUndefined();
  });

  test('invalid input returns to the error note', async () => {
    const res = await post({ ...valid, email: 'not-an-email\r\nBcc: x@y.z' });
    expect(res.headers.location).toBe('/#contact-error-c1');
    expect((await post({ ...valid, message: '' })).headers.location).toBe('/#contact-error-c1');
  });

  test('a form that is not on the published site, or a cross-site post, is refused', async () => {
    expect((await post({ ...valid, block: 'nope' })).status).toBe(404);
    expect((await post({ ...valid, page: 'about' })).status).toBe(404);
    const cross = await post(valid, { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.example' });
    expect(cross.status).toBe(403);
  });

  test('is rate-limited per address', async () => {
    const fixed = () => request(app).post('/api/public/website/contact').set('X-Forwarded-For', '198.51.100.7').set('Sec-Fetch-Site', 'same-origin').field('page', 'home').field('block', 'nope');
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect((await fixed()).status).toBe(404);
    }
    const limited = await fixed();
    expect(limited.status).toBe(303);
    expect(limited.headers.location).toBe('/');
  });

  test('is closed while the flag is off', async () => {
    await setFeatureFlags(db, { websiteBuilder: false });
    expect((await post(valid)).status).toBe(404);
    await setFeatureFlags(db, { websiteBuilder: true });
  });
});

describe('what an admin may pick', () => {
  // A second studio admin with the built-in `admin` role: CMS rights, but
  // galleries only of their own or assigned (no events.manage_all).
  let colleagueId; let foreignEvent; let foreignPhoto; let ownEvent; let ownPhoto;
  const colleague = () => auth(colleagueId);

  beforeAll(async () => {
    colleagueId = await insertId('admin_users', { username: 'colleague', email: 'colleague@example.com', password_hash: 'x', must_change_password: false, created_at: new Date().toISOString() });
    await assignAdminRole(db, colleagueId, 'admin');
    require('../../src/middleware/permissions').clearPermissionCache();
    foreignEvent = await insertEvent({ created_by: adminId });
    foreignPhoto = await insertPhoto(foreignEvent);
    ownEvent = await insertEvent({ created_by: colleagueId });
    ownPhoto = await insertPhoto(ownEvent);
  });

  const docWith = (photoIds, galleries = []) => ({
    pages: [{
      id: 'home', title: 'Home', slug: 'home', isHome: true,
      blocks: [
        { id: 'g9', type: 'gallery', images: photoIds.map((id) => ({ source: 'photo', id })) },
        { id: 'f9', type: 'featuredGalleries', galleries: galleries.map((id) => ({ id })) },
      ],
    }],
  });
  const revision = async () => (await request(app).get('/api/admin/website').set(colleague())).body.draft.revision;

  test('the picker lists only galleries the admin may act on', async () => {
    const ids = (await request(app).get('/api/admin/website/galleries').set(colleague())).body.galleries.map((g) => g.id);
    expect(ids).toContain(ownEvent);
    expect(ids).not.toContain(foreignEvent);
    expect((await request(app).get(`/api/admin/website/galleries/${foreignEvent}/photos`).set(colleague())).status).toBe(404);
    expect((await request(app).put(`/api/admin/website/galleries/${foreignEvent}`).set(colleague()).send({ showOnWebsite: false })).status).toBe(404);
  });

  test('a draft may not add photos or galleries the admin cannot access', async () => {
    const bad = await request(app).put('/api/admin/website/draft').set(colleague()).send({ document: docWith([ownPhoto, foreignPhoto]), revision: await revision() });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('WEBSITE_REFERENCE_NOT_ACCESSIBLE');
    const badGallery = await request(app).put('/api/admin/website/draft').set(colleague()).send({ document: docWith([ownPhoto], [foreignEvent]), revision: await revision() });
    expect(badGallery.status).toBe(422);
    const ok = await request(app).put('/api/admin/website/draft').set(colleague()).send({ document: docWith([ownPhoto], [ownEvent]), revision: await revision() });
    expect(ok.status).toBe(200);
  });

  test('a pick another admin made may stay when the colleague edits the page', async () => {
    // The owner picks the photo; the colleague then changes something else.
    const rev = (await request(app).get('/api/admin/website').set(auth(adminId))).body.draft.revision;
    await request(app).put('/api/admin/website/draft').set(auth(adminId)).send({ document: docWith([ownPhoto, foreignPhoto], [foreignEvent]), revision: rev }).expect(200);
    const edited = docWith([foreignPhoto, ownPhoto], [foreignEvent, ownEvent]);
    expect((await request(app).put('/api/admin/website/draft').set(colleague()).send({ document: edited, revision: await revision() })).status).toBe(200);
  });

  test('preview and thumbnails give no URL for a photo the admin may not pick', async () => {
    const other = await insertPhoto(foreignEvent);
    const preview = await request(app).post('/api/admin/website/preview').set(colleague()).send({ document: docWith([ownPhoto, other]), pageId: 'home' });
    expect(preview.body.html).toContain(`/site-media/p${ownPhoto}.`);
    expect(preview.body.html).not.toContain(`/site-media/p${other}.`);
    const urls = (await request(app).post('/api/admin/website/media/resolve').set(colleague())
      .send({ refs: [{ source: 'photo', id: ownPhoto }, { source: 'photo', id: other }, { source: 'photo', id: foreignPhoto }] })).body.urls;
    expect(urls[`photo:${ownPhoto}`]).toMatch(/^\/site-media\//);
    expect(urls[`photo:${other}`]).toBeNull();
    // Already on the site: its thumbnail shows.
    expect(urls[`photo:${foreignPhoto}`]).toMatch(/^\/site-media\//);
  });
});

describe('the opt-in in the gallery settings', () => {
  let event; let photo;

  beforeAll(async () => {
    event = await insertEvent({ show_on_website: 0 });
    photo = await insertPhoto(event);
    const rev = (await request(app).get('/api/admin/website').set(auth(adminId))).body.draft.revision;
    const document = { pages: [{ id: 'home', title: 'Home', slug: 'home', isHome: true, blocks: [{ id: 'g', type: 'gallery', images: [{ source: 'photo', id: photo }] }] }] };
    const saved = await request(app).put('/api/admin/website/draft').set(auth(adminId)).send({ document, revision: rev }).expect(200);
    await request(app).post('/api/admin/website/publish').set(auth(adminId)).send({ revision: saved.body.draft.revision }).expect(200);
  });

  const put = (body, who = adminId) => request(app).put(`/api/admin/events/${event}`).set(auth(who)).send(body);
  const stored = async () => Boolean((await db('events').where({ id: event }).first()).show_on_website);

  test('switches the gallery on and off, and the published page follows at once', async () => {
    expect((await service.resolvePublicPage('')).html).not.toContain(`/site-media/p${photo}.`);
    expect((await put({ show_on_website: true })).status).toBe(200);
    expect(await stored()).toBe(true);
    // No wait for the page cache: the change clears it.
    expect((await service.resolvePublicPage('')).html).toContain(`/site-media/p${photo}.`);
    expect((await put({ show_on_website: false })).status).toBe(200);
    expect(await stored()).toBe(false);
    expect((await service.resolvePublicPage('')).html).not.toContain(`/site-media/p${photo}.`);
  });

  test('reads "false" as off in the gallery update too', async () => {
    expect((await put({ show_on_website: true })).status).toBe(200);
    expect((await put({ show_on_website: 'false' })).status).toBe(200);
    expect(await stored()).toBe(false);
  });

  test('takes a boolean only', async () => {
    expect((await put({ show_on_website: 'yes please' })).status).toBe(400);
  });

  test('needs events.edit, like every gallery setting', async () => {
    expect((await put({ show_on_website: true }, viewerId)).status).toBe(403);
    expect(await stored()).toBe(false);
  });

  test('cannot be changed while the website builder is off', async () => {
    await setFeatureFlags(db, { websiteBuilder: false });
    expect((await put({ show_on_website: true })).status).toBe(200);
    expect(await stored()).toBe(false);
    await setFeatureFlags(db, { websiteBuilder: true });
  });
});

describe('picker inventories page and search', () => {
  beforeAll(async () => {
    for (let i = 0; i < 130; i += 1) {
      // Old, opted-in galleries far past the first page.
      // eslint-disable-next-line no-await-in-loop
      await insertEvent({ event_name: `Archive pick ${String(i).padStart(3, '0')}`, event_date: '2001-01-01' });
    }
    await insertEvent({ event_name: 'Ärger am Ufer', event_date: '2000-01-01' });
    for (let i = 0; i < 60; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await db('website_assets').insert({ public_id: crypto.randomBytes(12).toString('hex'), kind: 'image', original_filename: `upload-${i}.jpg`, rendition_keys: '{}', created_at: new Date(Date.UTC(2020, 0, 1, 0, i)).toISOString() });
    }
  });

  test('galleries come in pages until the last one', async () => {
    const seen = new Set();
    let page = 1;
    let body;
    do {
      // eslint-disable-next-line no-await-in-loop
      body = (await request(app).get('/api/admin/website/galleries').query({ page, pageSize: 50 }).set(auth(adminId))).body;
      expect(body.galleries.length).toBeLessThanOrEqual(50);
      body.galleries.forEach((g) => seen.add(g.id));
      page += 1;
    } while (body.hasMore);
    const total = (await db('events').where((q) => q.where('is_archived', false).orWhereNull('is_archived')).count({ c: '*' }).first()).c;
    expect(seen.size).toBe(Number(total));
  });

  test('galleries are found by name, the oldest included', async () => {
    // Same matching as the gallery list: ASCII case does not matter.
    for (const q of ['Ärger', 'am ufer']) {
      // eslint-disable-next-line no-await-in-loop
      const hit = (await request(app).get('/api/admin/website/galleries').query({ q }).set(auth(adminId))).body;
      expect(hit.galleries.map((g) => g.name)).toEqual(['Ärger am Ufer']);
    }
    const wild = (await request(app).get('/api/admin/website/galleries').query({ q: '%' }).set(auth(adminId))).body;
    expect(wild.galleries).toEqual([]);
  });

  test('the featured-galleries selector lists only galleries on the website and loads chosen ones by id', async () => {
    const some = await insertEvent({ event_name: 'Chosen far back', event_date: '1999-01-01' });
    const onSite = (await request(app).get('/api/admin/website/galleries').query({ onWebsite: 1, pageSize: 100 }).set(auth(adminId))).body;
    expect(onSite.galleries.every((g) => g.showOnWebsite)).toBe(true);
    const chosen = (await request(app).get('/api/admin/website/galleries').query({ ids: String(some) }).set(auth(adminId))).body;
    expect(chosen.galleries.map((g) => g.id)).toEqual([some]);
  });

  test('uploads come in pages and can be searched', async () => {
    const first = (await request(app).get('/api/admin/website/assets').query({ pageSize: 50 }).set(auth(adminId))).body;
    expect(first.assets).toHaveLength(50);
    expect(first.hasMore).toBe(true);
    const second = (await request(app).get('/api/admin/website/assets').query({ pageSize: 50, page: 2 }).set(auth(adminId))).body;
    expect(second.assets.length).toBeGreaterThan(0);
    expect(new Set([...first.assets, ...second.assets].map((a) => a.id)).size).toBe(first.assets.length + second.assets.length);
    const hit = (await request(app).get('/api/admin/website/assets').query({ q: 'upload-7.' }).set(auth(adminId))).body;
    expect(hit.assets.map((a) => a.originalFilename)).toEqual(['upload-7.jpg']);
  });
});

describe('the public site switch as the settings page writes it', () => {
  // On SQLite the settings writer stores the switch as 1, not as JSON true.
  const writeSwitch = (on) => request(app).put('/api/admin/settings/general').set(auth(adminId)).send({ general_public_site_enabled: on });

  test('turns the published website on and off', async () => {
    await setFeatureFlags(db, { websiteBuilder: true });
    const rev = (await request(app).get('/api/admin/website').set(auth(adminId))).body.draft.revision;
    const document = { pages: [{ id: 'home', title: 'Home', slug: 'home', isHome: true, blocks: [{ id: 'h', type: 'hero', heading: 'Switch test' }] }] };
    const saved = await request(app).put('/api/admin/website/draft').set(auth(adminId)).send({ document, revision: rev }).expect(200);
    await request(app).post('/api/admin/website/publish').set(auth(adminId)).send({ revision: saved.body.draft.revision }).expect(200);

    expect((await writeSwitch(true)).status).toBe(200);
    const stored = await db('app_settings').where({ setting_key: 'general_public_site_enabled' }).first();
    cache.clearWebsiteCache();
    expect((await service.resolvePublicPage('')).html).toContain('Switch test');
    expect((await request(app).get('/api/admin/website').set(auth(adminId))).body.publicSiteEnabled).toBe(true);
    // Whatever shape the writer chose, the template counts as visible now.
    expect(stored).toBeTruthy();
    expect((await service._internal.initialDocument()).imported).toBe(true);

    expect((await writeSwitch(false)).status).toBe(200);
    cache.clearWebsiteCache();
    expect(await service.resolvePublicPage('')).toBeNull();
    expect((await request(app).get('/api/admin/website').set(auth(adminId))).body.publicSiteEnabled).toBe(false);
  });
});

describe('save and publish under a concurrent save', () => {
  const doc = (heading) => ({ pages: [{ id: 'home', title: 'Home', slug: 'home', isHome: true, blocks: [{ id: 'h', type: 'hero', heading }] }] });

  test('a save answers with what it wrote, and publish needs that revision', async () => {
    await setFeatureFlags(db, { websiteBuilder: true });
    const base = (await request(app).get('/api/admin/website').set(auth(adminId))).body.draft.revision;
    // Another editor saves right after this save's UPDATE, before it answers.
    let injected = false;
    const onResponse = (_response, query) => {
      if (injected || !/^update/i.test(query.sql) || !/website_documents/.test(query.sql)) return;
      injected = true;
      db('website_documents').where({ state: 'draft' })
        .update({ document: JSON.stringify(doc('Theirs')), revision: base + 2, updated_at: new Date().toISOString() })
        .catch(() => {});
    };
    db.on('query-response', onResponse);
    let mine;
    try {
      mine = await request(app).put('/api/admin/website/draft').set(auth(adminId)).send({ document: doc('Mine'), revision: base });
    } finally {
      db.removeListener('query-response', onResponse);
    }
    expect(injected).toBe(true);
    expect(mine.status).toBe(200);
    expect(mine.body.draft.revision).toBe(base + 1);
    expect(mine.body.document.pages[0].blocks[0].heading).toBe('Mine');
    // Publishing what this editor saved is refused: the draft moved on.
    const publish = await request(app).post('/api/admin/website/publish').set(auth(adminId)).send({ revision: mine.body.draft.revision });
    expect(publish.status).toBe(409);
  });

  test('publish without the saved revision is refused', async () => {
    const res = await request(app).post('/api/admin/website/publish').set(auth(adminId)).send({});
    expect(res.status).toBe(400);
  });
});
