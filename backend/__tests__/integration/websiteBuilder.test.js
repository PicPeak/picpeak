/**
 * Website builder (issue 2618) against SQLite with every core migration:
 * the admin API, the public renderer, the public image endpoint and the
 * contact form, including the security rules each of them carries.
 */
const path = require('path');
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
  let openEvent; let openPhoto; let lockedEvent; let lockedPhoto; let optedOutPhoto;

  beforeAll(async () => {
    openEvent = await insertEvent();
    openPhoto = await insertPhoto(openEvent);
    lockedEvent = await insertEvent({ require_password: 1 });
    lockedPhoto = await insertPhoto(lockedEvent);
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

  test('only photos of opted-in, open galleries are rendered', async () => {
    const { html } = await service.resolvePublicPage('');
    expect(html).toContain(`/site-media/p${openPhoto}.`);
    expect(html).not.toContain(`/site-media/p${lockedPhoto}.`);
    expect(html).not.toContain(`/site-media/p${optedOutPhoto}.`);
    const openSlug = (await db('events').where({ id: openEvent }).first()).slug;
    expect(html).toContain(`href="/gallery/${openSlug}"`);
    expect(html).not.toContain('secret-share-token');
    const lockedSlug = (await db('events').where({ id: lockedEvent }).first()).slug;
    expect(html).not.toContain(`/gallery/${lockedSlug}"`);
  });

  test('the image endpoint serves a rendition of an eligible photo, nothing else', async () => {
    const ok = await request(app).get(photoUrl(openPhoto));
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('image/jpeg');
    const meta = await sharp(ok.body).metadata();
    expect(meta.width).toBe(640);

    expect((await request(app).get(photoUrl(lockedPhoto))).status).toBe(404);
    expect((await request(app).get(photoUrl(optedOutPhoto))).status).toBe(404);
    expect((await request(app).get(photoUrl(openPhoto, 999))).status).toBe(404);
    expect((await request(app).get(`/site-media/p${openPhoto}.${'0'.repeat(32)}/640`)).status).toBe(404);
    // A signature for one photo does not open another.
    const sig = photoUrl(openPhoto).split('.')[1].split('/')[0];
    expect((await request(app).get(`/site-media/p${lockedPhoto}.${sig}/640`)).status).toBe(404);
    expect((await request(app).get(`${media.mediaBase({ source: 'photo', id: openPhoto })}/video`)).status).toBe(404);
  });

  test('turning the gallery off removes its photos at once, cached page or not', async () => {
    const before = await service.resolvePublicPage('');
    expect(before.html).toContain(`/site-media/p${openPhoto}.`);
    const res = await request(app).put(`/api/admin/website/galleries/${openEvent}`).set(auth(adminId)).send({ showOnWebsite: false });
    expect(res.status).toBe(200);
    expect((await request(app).get(photoUrl(openPhoto))).status).toBe(404);
    expect((await service.resolvePublicPage('')).html).not.toContain(`/site-media/p${openPhoto}.`);
    await request(app).put(`/api/admin/website/galleries/${openEvent}`).set(auth(adminId)).send({ showOnWebsite: true }).expect(200);
    expect((await request(app).get(photoUrl(openPhoto))).status).toBe(200);
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

  test('the picker lists eligible galleries and refuses the photos of others', async () => {
    const list = await request(app).get('/api/admin/website/galleries').set(auth(adminId));
    const locked = list.body.galleries.find((g) => g.id === lockedEvent);
    expect(locked).toMatchObject({ showOnWebsite: true, eligible: false, reason: 'password' });
    expect((await request(app).get(`/api/admin/website/galleries/${lockedEvent}/photos`).set(auth(adminId))).status).toBe(409);
    const photos = await request(app).get(`/api/admin/website/galleries/${openEvent}/photos`).set(auth(adminId));
    expect(photos.status).toBe(200);
    expect(photos.body.photos.map((p) => p.id)).toEqual([openPhoto]);
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
    for (const key of Object.values(keys)) expect(key).toMatch(/^previews\/preview_(w\d+_)?site_[0-9a-f]{24}\.jpg$/);
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
