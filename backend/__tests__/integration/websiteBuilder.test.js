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
const mockTranscode = jest.fn((src, out) => require('fs').promises.copyFile(src, out));
jest.mock('../../src/services/videoRenditionService', () => ({
  probe: (...args) => mockProbe(...args),
  // The gallery web copy's rules: plays as it is when it is H.264/AAC MP4.
  playsInBrowser: (probed) => probed.videoCodec !== 'hevc',
  hasFaststart: async () => true,
  hdrPlan: async (probed, remux) => {
    const hdr = !remux && probed.colorTransfer === 'smpte2084';
    return { hdr, toneMap: hdr };
  },
  transcode: (...args) => mockTranscode(...args),
}));
// The real rendition step, which a test can make fail once.
const mockPreviewStep = jest.fn();
jest.mock('../../src/services/imageProcessor', () => {
  const actual = jest.requireActual('../../src/services/imageProcessor');
  return { ...actual, generatePreviewImage: (...args) => mockPreviewStep(...args) || actual.generatePreviewImage(...args) };
});

const { decodeSettingValue } = require('../helpers/settingValue');
let db; let cleanup; let app;
let adminId; let viewerId;
let service; let media; let cache; let frontendUrl; let realFrontendBaseUrl;

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

const getPhoto = (id, width) => request(app).get(photoUrl(id, width)).redirects(1);
const auth = (id) => ({ Authorization: `Bearer ${mintAdminToken(id)}` });

// The current URL of a photo carries its content version; the helper builds
// the unversioned one, which the endpoint redirects to the current one.
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

  // A pass-through spy the service picks up when it loads: a test can pause
  // a render or the sitemap at this call, after the published document is read.
  frontendUrl = require('../../src/utils/frontendUrl');
  realFrontendBaseUrl = frontendUrl.getFrontendBaseUrl;
  jest.spyOn(frontendUrl, 'getFrontendBaseUrl');
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

  test('an imported landing page renders inside the containers its stylesheet was written for', async () => {
    const { parseDocument, DomUtils } = require('htmlparser2');
    const { DEFAULT_PUBLIC_SITE_CSS } = require('../../src/constants/publicSiteDefaults');
    await setSetting('general_public_site_html', '<section class="hero" id="old-hero"><h1>Old site</h1></section>');
    await setSetting('general_public_site_enabled', true);
    let raw; let imported;
    try {
      ({ document: raw, imported } = await service._internal.initialDocument());
    } finally {
      await setSetting('general_public_site_enabled', false);
    }
    expect(imported).toBe(true);
    const { document } = require('../../src/services/website/document').normalizeDocument(raw);
    expect(document.pages[0].blocks[0]).toMatchObject({ type: 'customHtml', legacy: true });
    const html = (await request(app).post('/api/admin/website/preview').set(auth(adminId)).send({ document, pageId: document.pages[0].id })).body.html;
    const dom = parseDocument(html);
    const byClass = (name) => DomUtils.findAll((el) => (el.attribs?.class || '').split(/\s+/).includes(name), dom.children);
    const [main] = byClass('site-main');
    expect(main).toBeTruthy();
    // The old page sits in .site-main inside .site-shell, as / served it.
    expect(DomUtils.findOne((el) => el.attribs?.id === 'old-hero', [main], true)).toBeTruthy();
    expect(byClass('site-shell').some((shell) => DomUtils.findOne((el) => el === main, shell.children, true))).toBe(true);
    // ...and the stylesheet's .site-main rule is still there to apply.
    // (The sanitiser rewrites whitespace, so compare without it.)
    const squeeze = (text) => text.replace(/\s+/g, '');
    const rule = DEFAULT_PUBLIC_SITE_CSS.match(/\.site-main \{[^}]*\}/)[0];
    expect(squeeze(html)).toContain(squeeze(rule));
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

  test('the editor gets the branding colours as swatches for a custom background', async () => {
    const state = (await request(app).get('/api/admin/website').set(auth(adminId))).body;
    expect(Array.isArray(state.brandColors)).toBe(true);
    expect(state.brandColors.length).toBeGreaterThan(0);
    state.brandColors.forEach((c) => expect(c).toMatch(/^#[0-9a-f]{6}$/));
    expect(new Set(state.brandColors).size).toBe(state.brandColors.length);
  });

  test('the editor gets older text blocks as the rich text they render as', async () => {
    await setFeatureFlags(db, { websiteBuilder: true });
    const kept = await db('website_documents').where({ state: 'draft' }).first();
    const legacy = { pages: [{ id: 'home', slug: 'home', title: 'Home', isHome: true, blocks: [{ id: 't1', type: 'text', body: 'We take **photos**.' }] }] };
    await db('website_documents').where({ state: 'draft' }).update({ document: JSON.stringify(legacy) });
    try {
      const block = (await request(app).get('/api/admin/website').set(auth(adminId))).body.document.pages[0].blocks[0];
      expect(block).toMatchObject({ format: 'html', body: '<p>We take <strong>photos</strong>.</p>' });
    } finally {
      await db('website_documents').where({ state: 'draft' }).update({ document: kept.document });
    }
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

  test('the catalogue reaches the editor only with quotes.view', async () => {
    await setFeatureFlags(db, { quotes: true });
    const now = new Date().toISOString();
    const pkgId = await insertId('quote_packages', { name: 'Secret package', description: 'Our internal margin', currency: 'CHF', display_order: 0, is_active: true, created_at: now, updated_at: now });
    const presetId = await insertId('quote_line_item_presets', { name: 'Prints', currency: 'CHF', quantity_default: 1, unit_price_minor: 9000, price_mode: 'fixed', is_active: true, created_at: now, updated_at: now });
    await db('quote_package_items').insert({ package_id: pkgId, preset_id: presetId, quantity: 1, position: 1, created_at: now, updated_at: now });
    const webOnly = await insertId('admin_users', { username: 'web-only', email: 'web-only@example.com', password_hash: 'x', must_change_password: false, created_at: new Date().toISOString() });
    const roleId = await insertId('roles', { name: 'web_only', display_name: 'Website only', is_system: false, created_at: now });
    const permissionIds = await db('permissions').whereIn('name', ['cms.view', 'cms.edit']).pluck('id');
    await db('role_permissions').insert(permissionIds.map((permission_id) => ({ role_id: roleId, permission_id })));
    await db('admin_users').where({ id: webOnly }).update({ role_id: roleId });
    require('../../src/middleware/permissions').clearPermissionCache();
    try {
      expect((await request(app).get('/api/admin/website/packages').set(auth(webOnly))).status).toBe(403);
      const document = { pages: [{ id: 'home', title: 'Home', slug: 'home', isHome: true, blocks: [{ id: 'p1', type: 'pricing', packageIds: [pkgId] }] }] };
      const preview = (await request(app).post('/api/admin/website/preview').set(auth(webOnly)).send({ document, pageId: 'home' })).body.html;
      expect(preview).not.toContain('Secret package');
      expect(preview).not.toContain('Our internal margin');
      const full = (await request(app).post('/api/admin/website/preview').set(auth(adminId)).send({ document, pageId: 'home' })).body.html;
      expect(full).toContain('Secret package');
    } finally {
      await db('quote_package_items').where({ package_id: pkgId }).del();
      await db('quote_packages').where({ id: pkgId }).del();
      await setFeatureFlags(db, { quotes: false });
    }
  });

  test('without quotes.view a save may keep the packages a page has, not add others', async () => {
    const now = new Date().toISOString();
    const editor = await insertId('admin_users', { username: 'web-editor', email: 'web-editor@example.com', password_hash: 'x', must_change_password: false, created_at: now });
    const roleId = await insertId('roles', { name: 'web_editor', display_name: 'Website editor', is_system: false, created_at: now });
    const permissionIds = await db('permissions').whereIn('name', ['cms.view', 'cms.edit']).pluck('id');
    await db('role_permissions').insert(permissionIds.map((permission_id) => ({ role_id: roleId, permission_id })));
    await db('admin_users').where({ id: editor }).update({ role_id: roleId });
    require('../../src/middleware/permissions').clearPermissionCache();
    const doc = (packageIds, heading = 'Prices') => ({ pages: [{ id: 'home', title: 'Home', slug: 'home', isHome: true, blocks: [{ id: 'p1', type: 'pricing', heading, packageIds }] }] });
    const save = async (who, document) => request(app).put('/api/admin/website/draft').set(auth(who))
      .send({ document, revision: (await request(app).get('/api/admin/website').set(auth(who))).body.draft.revision });
    // A colleague with the catalogue put package 41 on the page.
    expect((await save(adminId, doc([41]))).status).toBe(200);
    // Kept while the page is edited.
    expect((await save(editor, doc([41], 'Our prices'))).status).toBe(200);
    const added = await save(editor, doc([41, 42]));
    expect(added.status).toBe(403);
    expect(added.body.code).toBe('WEBSITE_PACKAGES_FORBIDDEN');
    const stored = JSON.parse((await db('website_documents').where({ state: 'draft' }).first()).document);
    expect(stored.pages[0].blocks[0].packageIds).toEqual([41]);
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
    const archivedItem = await preset({ name: 'Retired extra', unit_price_minor: 5000, price_mode: 'fixed', is_active: false });
    const withArchived = await pkg('With a retired item', [[fixed, 1], [archivedItem, 1]]);
    const packages = await service._internal.loadPackages([hourPkg, dayPkg, mixed, unpriced, withArchived]);
    // Not offered cheaper and incomplete: a quote could not be made from it.
    expect(packages.has(withArchived)).toBe(false);
    const listed = (await request(app).get('/api/admin/website/packages').set(auth(adminId))).body.packages;
    expect(listed.find((p) => p.id === withArchived)).toMatchObject({ unavailable: 'archived_items' });
    expect(listed.find((p) => p.id === mixed)).toMatchObject({ unavailable: null });
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
    expect(await service.resolvePublicPage('home')).toEqual({ status: 302, location: '/' });
    // A hidden page or no page at that address: the not-found page, in the
    // website's design (see 'legal and system pages').
    expect((await service.resolvePublicPage('hidden')).notFound).toBe(true);
    expect((await service.resolvePublicPage('nope')).notFound).toBe(true);

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

  test('the booking block\'s form learns whether booking is on and which services it can open with', async () => {
    await setFeatureFlags(db, { calendarBooking: false });
    expect((await request(app).get('/api/admin/website/booking').set(auth(adminId))).body).toEqual({ flagOn: false, services: [] });
    await setFeatureFlags(db, { calendarBooking: true });
    const now = new Date().toISOString();
    const id = await insertId('quote_line_item_presets', { name: 'Family shoot', unit_price_minor: 30000, currency: 'CHF', bookable: true, is_active: true, created_at: now });
    const res = (await request(app).get('/api/admin/website/booking').set(auth(adminId))).body;
    expect(res.flagOn).toBe(true);
    expect(res.services).toEqual(expect.arrayContaining([{ id, name: 'Family shoot' }]));
    await db('quote_line_item_presets').where({ id }).del();
    await setFeatureFlags(db, { calendarBooking: false });
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

  test('the editor, the sitemap and the canonical links name the same public origin', async () => {
    await setSetting('seo_allow_indexing', true, 'seo');
    await setSetting('general_site_url', 'https://studio.example/');
    frontendUrl.invalidateSiteUrlCache();
    await frontendUrl.primeSiteUrlCache();
    cache.clearWebsiteCache();
    const state = (await request(app).get('/api/admin/website').set(auth(adminId))).body;
    expect(state.publicUrl).toBe('https://studio.example');
    expect(await service.sitemapXml()).toContain(`<loc>${state.publicUrl}/about</loc>`);
    expect((await service.resolvePublicPage('about')).html).toContain(`<link rel="canonical" href="${state.publicUrl}/about">`);
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

  const publishPages = async (pages) => {
    const state = (await request(app).get('/api/admin/website').set(auth(adminId))).body;
    const saved = await request(app).put('/api/admin/website/draft').set(auth(adminId)).send({ document: { pages }, revision: state.draft.revision }).expect(200);
    await request(app).post('/api/admin/website/publish').set(auth(adminId)).send({ revision: saved.body.draft.revision }).expect(200);
  };
  const home = { id: 'home', title: 'Home', slug: 'home', isHome: true, blocks: [] };
  const about = { id: 'about', title: 'About', slug: 'about', blocks: [{ id: 't1', type: 'text', body: 'About us' }] };
  // The render (or sitemap) has read the published document; before it
  // goes on, a publish removes the About page.
  const publishDuringNextRender = () => frontendUrl.getFrontendBaseUrl.mockImplementationOnce(async () => {
    await publishPages([home]);
    return realFrontendBaseUrl();
  });

  test('a page render that overlaps a publish does not put the old page back in the cache', async () => {
    await publishPages([home, about]);
    publishDuringNextRender();
    // The render already under way may still answer with what it read...
    expect(await service.resolvePublicPage('about')).toMatchObject({ status: 200 });
    // ...but it must not keep serving it from the cache: the address has no
    // page any more (the not-found page, or nothing without one).
    const after = await service.resolvePublicPage('about');
    expect(after === null || after.notFound === true).toBe(true);
  });

  test('a sitemap that overlaps a publish does not put the old list back in the cache', async () => {
    await publishPages([home, about]);
    publishDuringNextRender();
    expect(await service.sitemapXml()).toContain('/about</loc>');
    expect(await service.sitemapXml()).not.toContain('/about</loc>');
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
    // Picked while its gallery was on the website; switched off afterwards.
    const optedOutEvent = await insertEvent();
    optedOutPhoto = await insertPhoto(optedOutEvent);
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
    await db('events').where({ id: optedOutEvent }).update({ show_on_website: 0 });
    cache.clearWebsiteCache();
  });

  test('picked photos of opted-in galleries are rendered, with or without a password; nothing else is', async () => {
    const { html } = await service.resolvePublicPage('');
    expect(html).toContain(`/site-media/p${openPhoto}-`);
    expect(html).toContain(`/site-media/p${lockedPhoto}-`);
    // The protected gallery has no cover of its own: its card shows none
    // rather than one of the photos nobody picked.
    expect(html).not.toContain(`/site-media/p${lockedOther}-`);
    expect(html).not.toContain(`/site-media/p${optedOutPhoto}-`);
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
    expect((await service.resolvePublicPage('')).html).toContain(`/site-media/p${lockedOther}-`);
    await db('events').where({ id: lockedEvent }).update({ hero_photo_id: null });
    cache.clearWebsiteCache();
  });

  test('the image endpoint serves a rendition of an eligible photo, nothing else', async () => {
    const ok = await getPhoto(openPhoto);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('image/jpeg');
    const meta = await sharp(ok.body).metadata();
    expect(meta.width).toBe(640);

    expect((await getPhoto(lockedPhoto)).status).toBe(200);
    expect((await getPhoto(optedOutPhoto)).status).toBe(404);
    expect((await getPhoto(openPhoto, 999)).status).toBe(404);
    expect((await request(app).get(`/site-media/p${openPhoto}.${'0'.repeat(32)}/640`)).status).toBe(404);
    // A signature for one photo does not open another: the protected
    // gallery's unpicked photos have no URL anyone was given.
    const sig = photoUrl(lockedPhoto).split('.')[1].split('/')[0];
    expect((await request(app).get(`/site-media/p${lockedOther}.${sig}/640`)).status).toBe(404);
    expect((await request(app).get(`${media.mediaBase({ source: 'photo', id: openPhoto })}/video`)).status).toBe(404);
  });

  test('a replaced photo gets a new URL, and the old one leads to it', async () => {
    const before = (await service.resolvePublicPage('')).html;
    const oldUrl = before.match(new RegExp(`/site-media/p${openPhoto}-[0-9a-f]{10}\\.[0-9a-f]{32}/1280`))[0];
    expect((await request(app).get(oldUrl)).status).toBe(200);
    // What photoReplacementService writes: a new file at a new path, its hash.
    const row = await db('photos').where({ id: openPhoto }).first();
    const newRel = `site/replaced-${openPhoto}.jpg`;
    await sharp({ create: { width: 1600, height: 1000, channels: 3, background: { r: 200, g: 20, b: 20 } } }).jpeg()
      .toFile(path.join(process.env.STORAGE_PATH, 'events/active', newRel));
    await db('photos').where({ id: openPhoto }).update({ path: newRel, content_sha256: 'f'.repeat(64), preview_path: null });
    cache.clearWebsiteCache();
    const after = (await service.resolvePublicPage('')).html;
    const newUrl = after.match(new RegExp(`/site-media/p${openPhoto}-[0-9a-f]{10}\\.[0-9a-f]{32}/1280`))[0];
    expect(newUrl).not.toBe(oldUrl);
    // The old URL no longer serves the old picture: it redirects, uncached.
    const stale = await request(app).get(oldUrl);
    expect(stale.status).toBe(302);
    expect(stale.headers.location).toBe(newUrl);
    expect(stale.headers['cache-control']).toBe('no-cache');
    const fresh = await request(app).get(newUrl);
    expect(fresh.status).toBe(200);
    const { dominant } = await sharp(fresh.body).stats();
    expect(dominant.r).toBeGreaterThan(150);
    await db('photos').where({ id: openPhoto }).update({ path: row.path, content_sha256: row.content_sha256, preview_path: null });
    cache.clearWebsiteCache();
  });

  test('turning the gallery off removes its photos at once, cached page or not', async () => {
    const before = await service.resolvePublicPage('');
    expect(before.html).toContain(`/site-media/p${lockedPhoto}-`);
    const res = await request(app).put(`/api/admin/website/galleries/${lockedEvent}`).set(auth(adminId)).send({ showOnWebsite: false });
    expect(res.status).toBe(200);
    expect((await getPhoto(lockedPhoto)).status).toBe(404);
    expect((await service.resolvePublicPage('')).html).not.toContain(`/site-media/p${lockedPhoto}-`);
    await request(app).put(`/api/admin/website/galleries/${lockedEvent}`).set(auth(adminId)).send({ showOnWebsite: true }).expect(200);
    expect((await getPhoto(lockedPhoto)).status).toBe(200);
  });

  test('an expired or archived gallery and a disabled flag close the endpoint', async () => {
    await db('events').where({ id: openEvent }).update({ expires_at: new Date(Date.now() - 86400000).toISOString() });
    expect((await getPhoto(openPhoto)).status).toBe(404);
    await db('events').where({ id: openEvent }).update({ expires_at: new Date(Date.now() + 86400000).toISOString(), is_archived: 1 });
    expect((await getPhoto(openPhoto)).status).toBe(404);
    await db('events').where({ id: openEvent }).update({ is_archived: 0 });
    await setFeatureFlags(db, { websiteBuilder: false });
    expect((await getPhoto(openPhoto)).status).toBe(404);
    await setFeatureFlags(db, { websiteBuilder: true });
    // Reopened outside the settings routes: the cached set is cleared, as
    // a save through them does.
    cache.clearWebsiteCache();
    expect((await getPhoto(openPhoto)).status).toBe(200);
  });

  test('a gallery the gallery page keeps closed stays off the website, whatever closes it', async () => {
    const reason = async () => (await request(app).get('/api/admin/website/galleries').set(auth(adminId)))
      .body.galleries.find((g) => g.id === openEvent).reason;
    const closedBy = async (change, expected) => {
      await db('events').where({ id: openEvent }).update(change);
      cache.clearWebsiteCache();
      expect((await getPhoto(openPhoto)).status).toBe(404);
      expect((await service.resolvePublicPage('')).html).not.toContain(`/site-media/p${openPhoto}-`);
      expect(await reason()).toBe(expected);
    };
    const open = { payment_lock: null, payment_unlocked_at: null, is_draft: 0, temporarily_disabled: 0, reveal_mode: 0, reveal_at: null, revealed_at: null };
    // What bookingDeposits.applyGalleryLock writes, and any other lock value
    // (the gallery treats every non-empty lock as closed).
    for (const lock of ['full_payment', 'deposit']) {
      // eslint-disable-next-line no-await-in-loop
      await closedBy({ ...open, payment_lock: lock }, 'payment_lock');
    }
    // Paid (or opened by hand): the lock stays, the unlock stamp opens it.
    await db('events').where({ id: openEvent }).update({ ...open, payment_lock: 'full_payment', payment_unlocked_at: new Date().toISOString() });
    cache.clearWebsiteCache();
    expect((await getPhoto(openPhoto)).status).toBe(200);
    expect(await reason()).toBeNull();
    await closedBy({ ...open, is_draft: 1 }, 'unavailable');
    await closedBy({ ...open, temporarily_disabled: 1 }, 'unavailable');
    await closedBy({ ...open, reveal_mode: 1, reveal_at: new Date(Date.now() + 86400000).toISOString() }, 'hidden');
    await db('events').where({ id: openEvent }).update(open);
    cache.clearWebsiteCache();
    expect((await getPhoto(openPhoto)).status).toBe(200);
  });

  test('the picker gets a gallery date as a bare calendar day', async () => {
    // node-pg hands a `date` column back as a Date (serialised as an instant);
    // the API must send the day itself, as the gallery list does.
    const dated = await insertEvent({ event_date: '2026-06-01T00:00:00.000Z' });
    const list = await request(app).get('/api/admin/website/galleries').set(auth(adminId)).query({ ids: String(dated) });
    expect(list.body.galleries[0].date).toBe('2026-06-01');
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

  test('the picker shows a gallery\'s photos through the website\'s media route, no photo permission needed', async () => {
    const photos = (await request(app).get(`/api/admin/website/galleries/${lockedEvent}/photos`).set(auth(adminId))).body.photos;
    for (const photo of photos) {
      expect(photo.thumbnailUrl).toMatch(new RegExp(`^/site-media/ep${photo.id}-\\d{10}\\.[0-9a-f]{32}/640$`));
      // A signed URL: no admin credentials (and no photos.view) needed.
      // eslint-disable-next-line no-await-in-loop
      expect((await request(app).get(photo.thumbnailUrl)).status).toBe(200);
    }
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

  test('a failure in a later rendition step leaves nothing of the upload behind', async () => {
    const root = path.join(process.env.STORAGE_PATH, 'website');
    const listing = () => (fs.existsSync(root) ? fs.readdirSync(root).sort() : []);
    const before = listing();
    const rows = Number((await db('website_assets').count({ c: '*' }).first()).c);
    // The first tier renders; the worker fails on the second.
    mockPreviewStep.mockReturnValueOnce(undefined).mockImplementationOnce(() => Promise.reject(new Error('worker crashed')));
    const png = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: { r: 10, g: 10, b: 10 } } }).png().toBuffer();
    const res = await request(app).post('/api/admin/website/assets').set(auth(adminId)).attach('file', png, 'broken.png');
    expect(res.status).toBeGreaterThanOrEqual(400);
    // No tier left in its folder, no row, nothing in previews/.
    expect(listing().filter((name) => !before.includes(name)).flatMap((name) => fs.readdirSync(path.join(root, name)))).toEqual([]);
    expect(Number((await db('website_assets').count({ c: '*' }).first()).c)).toBe(rows);
    expect(fs.readdirSync(path.join(process.env.STORAGE_PATH, 'previews')).filter((f) => f.startsWith('site_'))).toEqual([]);
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

  test('an HDR HEVC video is tone-mapped like a gallery web copy', async () => {
    mockTranscode.mockClear();
    mockProbe.mockResolvedValue({ duration: 8, width: 3840, height: 2160, videoCodec: 'hevc', colorTransfer: 'smpte2084' });
    const res = await request(app).post('/api/admin/website/assets').set(auth(adminId)).attach('file', mp4, { filename: 'hdr.mp4', contentType: 'video/mp4' });
    expect(res.status).toBe(201);
    expect(mockTranscode).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ remux: false, toneMap: true }));
  });

  test('a file that only claims to be MP4 is refused', async () => {
    const res = await request(app).post('/api/admin/website/assets').set(auth(adminId)).attach('file', Buffer.from('not a video'), { filename: 'x.mp4', contentType: 'video/mp4' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('WEBSITE_ASSET_TYPE');
  });
});

describe('contact form', () => {
  // Loaded once the test database is up.
  const contact = () => require('../../src/services/website/contact');
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

  test('one network gets 20 messages a day, however it spreads them over the hours', async () => {
    const { rateLimitKey } = require('../../src/utils/rateLimitKey');
    const { hourly } = require('../../src/routes/publicWebsite')._internal;
    // Addresses of one IPv6 /64 count as one sender.
    const from = (n) => request(app).post('/api/public/website/contact').set('X-Forwarded-For', `2001:db8:5:7::${n}`).set('Sec-Fetch-Site', 'same-origin');
    const send = (n) => {
      const req = from(n);
      Object.entries({ ...valid, email: `net${n}@example.com` }).forEach(([k, v]) => req.field(k, v));
      return req;
    };
    for (let i = 1; i <= 20; i += 1) {
      // The hourly limit (5) would stop it first: let an hour pass each time.
      if (i % 5 === 1) await hourly.resetKey(rateLimitKey({ ip: `2001:db8:5:7::${i}` })); // eslint-disable-line no-await-in-loop
      const res = await send(i); // eslint-disable-line no-await-in-loop
      expect(res.headers.location).toBe('/#contact-sent-c1');
    }
    await hourly.resetKey(rateLimitKey({ ip: '2001:db8:5:7::99' }));
    const refused = await send(99);
    expect(refused.status).toBe(303);
    expect(refused.headers.location).toBe('/');
    expect(await db('received_emails').where('from_address', 'net99@example.com').first()).toBeUndefined();
  });

  test('the daily cap for all senders is 1000, and reaching it tells the studio once', async () => {
    expect(contact().DAILY_CAP).toBe(1000);
    const now = new Date().toISOString();
    const already = Number((await db('received_emails').where('message_id', 'like', '<website-contact-%').count({ c: '*' }).first()).c);
    const filler = Array.from({ length: contact().DAILY_CAP - already }, (_, i) => ({
      message_id: `<website-contact-filler-${i}@picpeak>`, account_key: 'customers', from_address: 'filler@example.com', subject: 'x',
      received_at: now, attachment_count: 0, status: 'no_attachment', body_text: 'x', mailbox_state: 'active', created_at: now,
    }));
    for (let i = 0; i < filler.length; i += 200) await db('received_emails').insert(filler.slice(i, i + 200)); // eslint-disable-line no-await-in-loop
    try {
      expect((await post({ ...valid, email: 'late1@example.com' })).headers.location).toBe('/#contact-error-c1');
      expect((await post({ ...valid, email: 'late2@example.com' })).headers.location).toBe('/#contact-error-c1');
      const told = await db('activity_logs').where({ activity_type: 'website_contact_cap_reached' });
      expect(told).toHaveLength(1);
    } finally {
      await db('received_emails').where('message_id', 'like', '<website-contact-filler-%').del();
      await db('activity_logs').where({ activity_type: 'website_contact_cap_reached' }).del();
    }
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

  test('a long message in a script of three-byte characters is accepted; too many characters go to the error note', async () => {
    const cjk = '写'.repeat(3000);
    const ok = await post({ ...valid, email: 'cjk@example.com', message: cjk });
    expect(ok.status).toBe(303);
    expect(ok.headers.location).toBe('/#contact-sent-c1');
    expect((await db('received_emails').where('from_address', 'cjk@example.com').first()).body_text).toContain(cjk);
    const tooLong = await post({ ...valid, email: 'long@example.com', message: 'x'.repeat(5001) });
    expect(tooLong.headers.location).toBe('/#contact-error-c1');
    // Over the byte limit of the upload parser: the same note, not a bare 400.
    const huge = await post({ ...valid, email: 'huge@example.com', message: '写'.repeat(7000) });
    expect(huge.status).toBe(303);
    expect(huge.headers.location).toBe('/#contact-error-c1');
    expect(await db('received_emails').whereIn('from_address', ['long@example.com', 'huge@example.com']).first()).toBeUndefined();
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

  test('only the owner puts a gallery on the website or takes it off; an assigned admin still picks from it', async () => {
    const assigned = await insertEvent({ created_by: adminId, show_on_website: 1 });
    const assignedPhoto = await insertPhoto(assigned);
    await db('event_admin_assignments').insert({ event_id: assigned, admin_user_id: colleagueId, created_at: new Date().toISOString() });
    const owned = async () => Boolean((await db('events').where({ id: assigned }).first()).show_on_website);
    try {
      const listed = (await request(app).get('/api/admin/website/galleries').set(colleague())).body.galleries.find((g) => g.id === assigned);
      expect(listed).toMatchObject({ canChange: false });
      const picker = await request(app).put(`/api/admin/website/galleries/${assigned}`).set(colleague()).send({ showOnWebsite: false });
      expect(picker.status).toBe(403);
      expect(picker.body.code).toBe('EVENT_OWNER_REQUIRED');
      const settings = await request(app).put(`/api/admin/events/${assigned}`).set(colleague()).send({ show_on_website: false });
      expect(settings.status).toBe(403);
      expect(settings.body.code).toBe('EVENT_OWNER_REQUIRED');
      expect(await owned()).toBe(true);
      // The settings form sends what it loaded: an unchanged value passes.
      expect((await request(app).put(`/api/admin/events/${assigned}`).set(colleague()).send({ show_on_website: true })).status).toBe(200);
      // Picking from it stays open to the assigned admin.
      const photos = await request(app).get(`/api/admin/website/galleries/${assigned}/photos`).set(colleague());
      expect(photos.body.photos.map((p) => p.id)).toEqual([assignedPhoto]);
    } finally {
      await db('event_admin_assignments').where({ event_id: assigned }).del();
    }
  });

  test('a non-owner\'s stale echo cannot switch a gallery back on that its owner just switched off', async () => {
    const assigned = await insertEvent({ created_by: adminId, show_on_website: 1 });
    await db('event_admin_assignments').insert({ event_id: assigned, admin_user_id: colleagueId, created_at: new Date().toISOString() });
    // The colleague's save reads the stored value while it is still on; the
    // owner switches the gallery off before that save writes.
    let stale = false;
    const readBeforeOptOut = (response, query) => {
      if (stale || !/select .*show_on_website.* from .events./i.test(query.sql)) return;
      const row = Array.isArray(response) ? response[0] : response;
      if (!row || Number(row.id) !== assigned) return;
      stale = true;
      row.show_on_website = 1;
    };
    await db('events').where({ id: assigned }).update({ show_on_website: 0 });
    db.on('query-response', readBeforeOptOut);
    try {
      // The settings form sends back what it loaded: on.
      expect((await request(app).put(`/api/admin/events/${assigned}`).set(colleague()).send({ show_on_website: true })).status).toBe(200);
    } finally {
      db.removeListener('query-response', readBeforeOptOut);
      await db('event_admin_assignments').where({ event_id: assigned }).del();
    }
    expect(stale).toBe(true);
    expect(Boolean((await db('events').where({ id: assigned }).first()).show_on_website)).toBe(false);
  });

  test('the gallery settings change the opt-in only with cms.edit as well', async () => {
    const editor = await insertId('admin_users', { username: 'events-only', email: 'events-only@example.com', password_hash: 'x', must_change_password: false, created_at: new Date().toISOString() });
    const roleId = await insertId('roles', { name: 'events_only', display_name: 'Events only', is_system: false, created_at: new Date().toISOString() });
    const permissionIds = await db('permissions').whereIn('name', ['events.view', 'events.edit', 'events.manage_all']).pluck('id');
    await db('role_permissions').insert(permissionIds.map((permission_id) => ({ role_id: roleId, permission_id })));
    await db('admin_users').where({ id: editor }).update({ role_id: roleId });
    require('../../src/middleware/permissions').clearPermissionCache();
    const event = await insertEvent({ created_by: editor, show_on_website: 0 });
    const res = await request(app).put(`/api/admin/events/${event}`).set(auth(editor)).send({ show_on_website: true });
    expect(res.status).toBe(403);
    expect(Boolean((await db('events').where({ id: event }).first()).show_on_website)).toBe(false);
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
    expect(preview.body.html).toContain(`/site-media/ep${ownPhoto}-`);
    expect(preview.body.html).not.toContain(`/site-media/ep${other}-`);
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
    // Picked while the gallery was on the website, then switched off.
    event = await insertEvent();
    photo = await insertPhoto(event);
    const rev = (await request(app).get('/api/admin/website').set(auth(adminId))).body.draft.revision;
    const document = { pages: [{ id: 'home', title: 'Home', slug: 'home', isHome: true, blocks: [{ id: 'g', type: 'gallery', images: [{ source: 'photo', id: photo }] }] }] };
    const saved = await request(app).put('/api/admin/website/draft').set(auth(adminId)).send({ document, revision: rev }).expect(200);
    await request(app).post('/api/admin/website/publish').set(auth(adminId)).send({ revision: saved.body.draft.revision }).expect(200);
    await db('events').where({ id: event }).update({ show_on_website: 0 });
    require('../../src/services/website/cache').clearWebsiteCache();
  });

  const put = (body, who = adminId) => request(app).put(`/api/admin/events/${event}`).set(auth(who)).send(body);
  const stored = async () => Boolean((await db('events').where({ id: event }).first()).show_on_website);

  test('switches the gallery on and off, and the published page follows at once', async () => {
    expect((await service.resolvePublicPage('')).html).not.toContain(`/site-media/p${photo}-`);
    expect((await put({ show_on_website: true })).status).toBe(200);
    expect(await stored()).toBe(true);
    // No wait for the page cache: the change clears it.
    expect((await service.resolvePublicPage('')).html).toContain(`/site-media/p${photo}-`);
    expect((await put({ show_on_website: false })).status).toBe(200);
    expect(await stored()).toBe(false);
    expect((await service.resolvePublicPage('')).html).not.toContain(`/site-media/p${photo}-`);
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

  test('a publish that read an older draft cannot roll the published site back', async () => {
    await setFeatureFlags(db, { websiteBuilder: true });
    const base = (await request(app).get('/api/admin/website').set(auth(adminId))).body.draft.revision;
    const saved = await request(app).put('/api/admin/website/draft').set(auth(adminId)).send({ document: doc('Older'), revision: base }).expect(200);
    const older = saved.body.draft.revision;
    await service.publish(older, adminId);
    // This publish reads the draft at `older`, then pauses. In the pause
    // another editor saves and publishes a newer revision (written here
    // through the same connection: SQLite has only one). Then it goes on.
    const { client } = db;
    const transaction = client.transaction;
    const spy = jest.spyOn(client, 'transaction').mockImplementationOnce((work, ...rest) => transaction.call(client, (trx) => {
      let paused = false;
      const pausing = (...args) => {
        const query = trx(...args);
        const first = query.first.bind(query);
        query.first = async (...cols) => {
          const row = await first(...cols);
          if (row && row.state === 'draft' && !paused) {
            paused = true;
            const now = new Date().toISOString();
            const newer = JSON.stringify(doc('Newer'));
            await trx('website_documents').where({ state: 'draft' }).update({ document: newer, revision: older + 1, updated_at: now });
            await trx('website_documents').where({ state: 'published' }).update({ document: newer, revision: older + 1, updated_at: now, published_at: now });
          }
          return row;
        };
        return query;
      };
      pausing.client = trx.client;
      return work(pausing);
    }, ...rest));
    try {
      await expect(service.publish(older, adminId)).rejects.toMatchObject({ statusCode: 409 });
    } finally {
      spy.mockRestore();
    }
    // The refusal rolls back the pause's writes too (same connection); what
    // matters is that the older revision was not written over the newer one.
    const published = await db('website_documents').where({ state: 'published' }).first();
    expect(published.revision).toBe(older);
    expect(published.document).toContain('Older');
  });

  test('publish without the saved revision is refused', async () => {
    const res = await request(app).post('/api/admin/website/publish').set(auth(adminId)).send({});
    expect(res.status).toBe(400);
  });
});

describe('importing a large landing page', () => {
  const writeSite = (settings) => request(app).put('/api/admin/settings/general').set(auth(adminId)).send(settings);

  test('the largest stylesheet the settings page takes comes over whole', async () => {
    const { MAX_CSS_SIZE } = require('../../src/utils/cssSanitizer');
    const css = `.x{color:red}${'/*pad*/'.repeat(Math.ceil(MAX_CSS_SIZE / 7))}`.slice(0, MAX_CSS_SIZE);
    expect((await writeSite({ general_public_site_html: '<p>Edited landing page</p>', general_public_site_custom_css: css })).status).toBe(200);
    const stored = (await db('app_settings').where({ setting_key: 'general_public_site_custom_css' }).first()).setting_value;
    const storedCss = JSON.parse(stored);
    const { document: raw, imported } = await service._internal.initialDocument();
    expect(imported).toBe(true);
    const { document, errors } = require('../../src/services/website/document').normalizeDocument(raw);
    expect(errors).toEqual([]);
    expect(document.customCss.endsWith(storedCss.trim())).toBe(true);
  });

  test('an imported stylesheet of the largest accepted size renders whole', async () => {
    const { MAX_CSS_SIZE } = require('../../src/utils/cssSanitizer');
    const last = '.last-rule{color:blue}';
    const css = `${'/*pad*/'.repeat(Math.ceil(MAX_CSS_SIZE / 7))}`.slice(0, MAX_CSS_SIZE - last.length) + last;
    expect((await writeSite({ general_public_site_html: '<p>Edited landing page</p>', general_public_site_custom_css: css })).status).toBe(200);
    const { document: raw } = await service._internal.initialDocument();
    const { document } = require('../../src/services/website/document').normalizeDocument(raw);
    const html = (await request(app).post('/api/admin/website/preview').set(auth(adminId)).send({ document, pageId: document.pages[0].id })).body.html;
    expect(html).toContain(last);
  });

  test('a landing page too large for a custom HTML block is not cut: it is left out, and the editor says why', async () => {
    const { MAX_CUSTOM_HTML } = require('../../src/services/website/document');
    const html = `<p>${'x'.repeat(MAX_CUSTOM_HTML + 10)}</p>`;
    expect((await writeSite({ general_public_site_html: html })).status).toBe(200);
    const { document, imported, refused } = await service._internal.initialDocument();
    expect(imported).toBe(false);
    expect(refused).toEqual({ length: html.length, max: MAX_CUSTOM_HTML });
    // The starter instead, nothing of the landing page in it.
    expect(JSON.stringify(document)).not.toContain('xxxxxxxxxx');
    expect(await service._internal.importRefusal({ published: null })).toEqual({ length: html.length, max: MAX_CUSTOM_HTML });
    // Once something is published the old page is gone from / anyway.
    expect(await service._internal.importRefusal({ published: { id: 1 } })).toBeNull();
    await writeSite({ general_public_site_html: '<p>Edited landing page</p>' });
  });
});

describe('gallery watermarks on the website', () => {
  // Loaded once the test database is up (they open the db module).
  let watermarkService; let ensurePreviewImageAtWidth; let withLocalCopy;
  let markedEvent; let markedPhoto; let pricedEvent; let pricedPhoto; let cappedPhoto; let cleanPhoto;

  const stored = async (photoId, width) => {
    const photo = await db('photos').where({ id: photoId }).first();
    const key = await ensurePreviewImageAtWidth(photo, width);
    return fs.promises.readFile(path.join(process.env.STORAGE_PATH, key));
  };
  // What the gallery's own preview route sends for this photo at this width.
  const galleryView = async (photoId, width, settingsFor) => {
    const photo = await db('photos').where({ id: photoId }).first();
    const event = await db('events').where({ id: photo.event_id }).first();
    const key = await ensurePreviewImageAtWidth(photo, width);
    const settings = await settingsFor(event, photo);
    return withLocalCopy(key, (localPath) => watermarkService.applyWatermark(localPath, settings, { failClosed: true }));
  };
  const urlOf = (html, id) => html.match(new RegExp(`/site-media/p${id}-[0-9a-f]{10}\\.[0-9a-f]{32}/640`))[0];

  beforeAll(async () => {
    watermarkService = require('../../src/services/watermarkService');
    ({ ensurePreviewImageAtWidth, withLocalCopy } = require('../../src/services/imageProcessor'));
    await setFeatureFlags(db, { websiteBuilder: true });
    await setSetting('general_public_site_enabled', true);
    await setSetting('branding_watermark_enabled', true, 'branding');
    await setSetting('branding_watermark_position', 'center', 'branding');
    watermarkService.clearCache();
    markedEvent = await insertEvent({ watermark_text: 'Studio mark' });
    markedPhoto = await insertPhoto(markedEvent);
    pricedEvent = await insertEvent({ is_priced: 1, photo_price: 5 });
    pricedPhoto = await insertPhoto(pricedEvent);
    cappedPhoto = await insertPhoto(await insertEvent({ protection_level: 'maximum' }));
    const state = (await request(app).get('/api/admin/website').set(auth(adminId))).body;
    const document = {
      pages: [{
        id: 'home', title: 'Home', slug: 'home', isHome: true,
        blocks: [{ id: 'g1', type: 'gallery', images: [markedPhoto, pricedPhoto, cappedPhoto].map((id) => ({ source: 'photo', id })) }],
      }],
    };
    const saved = await request(app).put('/api/admin/website/draft').set(auth(adminId)).send({ document, revision: state.draft.revision }).expect(200);
    await request(app).post('/api/admin/website/publish').set(auth(adminId)).send({ revision: saved.body.draft.revision }).expect(200);
    cache.clearWebsiteCache();
  });

  afterAll(async () => {
    await setSetting('branding_watermark_enabled', false, 'branding');
    watermarkService.clearCache();
    cache.clearWebsiteCache();
  });

  test('a photo carries the watermark its gallery shows', async () => {
    const served = await getPhoto(markedPhoto);
    expect(served.status).toBe(200);
    expect(served.body.equals(await stored(markedPhoto, 640))).toBe(false);
    const expected = await galleryView(markedPhoto, 640, (event) => watermarkService.getWatermarkSettingsForEvent(event));
    expect(served.body.equals(expected)).toBe(true);
  });

  test('a priced gallery photo carries the photo-sales mark', async () => {
    const { resolvePhotoSalesWatermarkSettings } = require('../../src/modules/photoSales/priceRules');
    const served = await getPhoto(pricedPhoto);
    expect(served.status).toBe(200);
    expect(served.body.equals(await stored(pricedPhoto, 640))).toBe(false);
    expect(served.body.equals(await galleryView(pricedPhoto, 640, resolvePhotoSalesWatermarkSettings))).toBe(true);
  });

  test('a gallery at maximum protection gets the capped view, never the plain rendition', async () => {
    const served = await getPhoto(cappedPhoto, 1920);
    expect(served.status).toBe(200);
    expect(served.body.equals(await stored(cappedPhoto, 1920))).toBe(false);
    const meta = await sharp(served.body).metadata();
    expect(meta.width).toBeLessThanOrEqual(1920);
    expect(meta.height).toBeLessThanOrEqual(1080);
  });

  test('changing the watermark changes the URL, and the old one leads to the new', async () => {
    const before = urlOf((await service.resolvePublicPage('')).html, markedPhoto);
    await db('events').where({ id: markedEvent }).update({ watermark_text: 'New mark' });
    cache.clearWebsiteCache();
    const after = urlOf((await service.resolvePublicPage('')).html, markedPhoto);
    expect(after).not.toBe(before);
    const stale = await request(app).get(before);
    expect(stale.status).toBe(302);
    expect(stale.headers.location).toBe(after);
    // Watermark off: a new URL again, now for the clean rendition.
    await setSetting('branding_watermark_enabled', false, 'branding');
    cache.clearWebsiteCache();
    const clean = urlOf((await service.resolvePublicPage('')).html, markedPhoto);
    expect(clean).not.toBe(after);
    expect((await request(app).get(clean)).body.equals(await stored(markedPhoto, 640))).toBe(true);
    await setSetting('branding_watermark_enabled', true, 'branding');
    cache.clearWebsiteCache();
  });

  test('when the watermark settings cannot be read, no photo leaves unmarked', async () => {
    const spy = jest.spyOn(watermarkService, 'getWatermarkSettings').mockResolvedValue(null);
    try {
      const res = await getPhoto(markedPhoto);
      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBeDefined();
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.length || 0).toBeLessThan(200);
    } finally {
      spy.mockRestore();
    }
    expect((await getPhoto(markedPhoto)).status).toBe(200);
  });

  test('a busy image worker is a 503 to retry, as in the gallery, not a 500', async () => {
    const busy = Object.assign(new Error('Image queue is full'), { code: 'IMAGE_QUEUE_FULL', retryAfter: 7 });
    const spy = jest.spyOn(watermarkService, 'applyWatermark').mockRejectedValue(busy);
    try {
      const res = await getPhoto(markedPhoto);
      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe('7');
      expect(res.headers['cache-control']).toBe('no-store');
    } finally {
      spy.mockRestore();
    }
  });

  test('builder uploads are never watermarked', async () => {
    const png = await sharp({ create: { width: 2000, height: 1200, channels: 3, background: { r: 30, g: 160, b: 60 } } }).png().toBuffer();
    const res = await request(app).post('/api/admin/website/assets').set(auth(adminId)).attach('file', png, 'clean.png');
    expect(res.status).toBe(201);
    cleanPhoto = res.body.asset.id;
    const keys = JSON.parse((await db('website_assets').where({ public_id: cleanPhoto }).first()).rendition_keys);
    const served = await request(app).get(res.body.asset.previewUrl);
    expect(served.status).toBe(200);
    expect(served.body.equals(await fs.promises.readFile(path.join(process.env.STORAGE_PATH, keys['640'])))).toBe(true);
  });
});

describe('what a page render reads', () => {
  let eventId; let photoIds;
  const queries = async (work) => {
    const seen = [];
    const listen = (q) => seen.push(`${q.sql} ${JSON.stringify(q.bindings || [])}`);
    db.on('query', listen);
    try { await work(); } finally { db.removeListener('query', listen); }
    return seen;
  };
  const publishPages = async (pages) => {
    const state = (await request(app).get('/api/admin/website').set(auth(adminId))).body;
    const saved = await request(app).put('/api/admin/website/draft').set(auth(adminId)).send({ document: { pages }, revision: state.draft.revision }).expect(200);
    await request(app).post('/api/admin/website/publish').set(auth(adminId)).send({ revision: saved.body.draft.revision }).expect(200);
    cache.clearWebsiteCache();
  };
  const gallery = (id, ids) => ({ id, type: 'gallery', images: ids.map((photoId) => ({ source: 'photo', id: photoId })) });

  beforeAll(async () => {
    await setFeatureFlags(db, { websiteBuilder: true });
    await setSetting('general_public_site_enabled', true);
    eventId = await insertEvent();
    photoIds = [];
    for (let i = 0; i < 24; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      photoIds.push(await insertId('photos', {
        event_id: eventId, filename: `q${i}.jpg`, original_filename: `q${i}.jpg`, path: `site/q${i}.jpg`, type: 'individual',
        width: 1600, height: 1000, processing_status: 'complete', source_origin: 'managed', rendition_version: 1,
        mime_type: 'image/jpeg', media_type: 'photo',
      }));
    }
  });

  test('a page reads only its own photos, not those of other (hidden) pages', async () => {
    await publishPages([
      { id: 'home', title: 'Home', slug: 'home', isHome: true, blocks: [{ id: 'c1', type: 'contact' }] },
      { id: 'portfolio', title: 'Portfolio', slug: 'portfolio', hidden: true, blocks: [gallery('g1', photoIds.slice(0, 12)), gallery('g2', photoIds.slice(12, 24))] },
    ]);
    const seen = await queries(() => service.resolvePublicPage(''));
    expect(seen.filter((sql) => /from [`"]photos[`"]/i.test(sql))).toEqual([]);
    expect(seen.filter((sql) => /branding_watermark_enabled/.test(sql))).toEqual([]);
  });

  test('the watermark settings are read once per gallery, not once per photo', async () => {
    await publishPages([
      { id: 'home', title: 'Home', slug: 'home', isHome: true, blocks: [gallery('g1', photoIds.slice(0, 12)), gallery('g2', photoIds.slice(12, 24))] },
    ]);
    const seen = await queries(async () => {
      const page = await service.resolvePublicPage('');
      expect(page.html).toContain(`/site-media/p${photoIds[23]}-`);
    });
    expect(seen.filter((sql) => /branding_watermark_enabled/.test(sql))).toHaveLength(1);
  });
});

describe('which photo URLs work', () => {
  let eventId; let onPage; let onHidden; let draftOnly; let unpicked;
  const publicUrl = (id) => `${media.mediaBase({ source: 'photo', id })}/640`;
  const state = async () => (await request(app).get('/api/admin/website').set(auth(adminId))).body;
  const save = async (pages) => {
    const saved = await request(app).put('/api/admin/website/draft').set(auth(adminId)).send({ document: { pages }, revision: (await state()).draft.revision }).expect(200);
    return saved.body.draft.revision;
  };
  const publish = async (pages) => {
    await request(app).post('/api/admin/website/publish').set(auth(adminId)).send({ revision: await save(pages) }).expect(200);
    cache.clearWebsiteCache();
  };
  const gallery = (id, ids) => ({ id, type: 'gallery', images: ids.map((photoId) => ({ source: 'photo', id: photoId })) });
  const home = (ids) => ({ id: 'home', title: 'Home', slug: 'home', isHome: true, blocks: [gallery('g1', ids)] });
  const hidden = { id: 'later', title: 'Later', slug: 'later', hidden: true, blocks: [] };

  beforeAll(async () => {
    await setFeatureFlags(db, { websiteBuilder: true });
    await setSetting('general_public_site_enabled', true);
    await setSetting('branding_watermark_enabled', false, 'branding');
    eventId = await insertEvent({ require_password: 1 });
    onPage = await insertPhoto(eventId);
    onHidden = await insertPhoto(eventId);
    draftOnly = await insertPhoto(eventId);
    unpicked = await insertPhoto(eventId);
    hidden.blocks = [gallery('g2', [onHidden])];
    await publish([home([onPage]), hidden]);
    // Picked in the draft only, never published.
    await save([home([onPage, draftOnly]), hidden]);
  });

  test('a public URL works only for a photo the published website shows', async () => {
    const page = await service.resolvePublicPage('');
    const shown = page.html.match(new RegExp(`/site-media/p${onPage}-[0-9a-f]{10}\\.[0-9a-f]{32}/640`))[0];
    const ok = await request(app).get(shown);
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toBe('public, max-age=86400');
    for (const id of [onHidden, draftOnly, unpicked]) {
      // eslint-disable-next-line no-await-in-loop
      expect((await request(app).get(publicUrl(id)).redirects(1)).status).toBe(404);
    }
  });

  test('a photo taken off the website loses its public URL at the next publish', async () => {
    const before = (await service.resolvePublicPage('')).html.match(new RegExp(`/site-media/p${onPage}-[0-9a-f]{10}\\.[0-9a-f]{32}/640`))[0];
    await publish([home([draftOnly]), hidden]);
    expect((await request(app).get(before)).status).toBe(404);
    await publish([home([onPage]), hidden]);
  });

  test('picker tiles are short-lived editor URLs: never public-cacheable, never public', async () => {
    const tiles = (await request(app).get(`/api/admin/website/galleries/${eventId}/photos`).set(auth(adminId))).body.photos;
    const tile = tiles.find((p) => p.id === unpicked).thumbnailUrl;
    expect(tile).toMatch(new RegExp(`^/site-media/ep${unpicked}-\\d{10}\\.[0-9a-f]{32}/640$`));
    const ok = await request(app).get(tile);
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toBe('private, no-store');
    // Another photo under the same signature, or the public kind of it: refused.
    expect((await request(app).get(tile.replace(`ep${unpicked}-`, `ep${onHidden}-`))).status).toBe(404);
    expect((await request(app).get(tile.replace('/site-media/ep', '/site-media/p'))).status).toBe(404);
    // Expired.
    const past = Math.floor(Date.now() / 1000) - 60;
    expect((await request(app).get(`${media.editorBase({ source: 'photo', id: unpicked }, past)}/640`)).status).toBe(404);
    // A later expiry cannot be written in without the key.
    const [, exp] = tile.match(/-(\d{10})\./);
    expect((await request(app).get(tile.replace(`-${exp}.`, `-${Number(exp) + 86400 * 365}.`))).status).toBe(404);
  });

  test('the editor preview uses editor URLs; the published page uses public ones', async () => {
    const preview = (await request(app).post('/api/admin/website/preview').set(auth(adminId)).send({ document: { pages: [home([onPage, draftOnly])] }, pageId: 'home' })).body.html;
    expect(preview).toContain(`/site-media/ep${draftOnly}-`);
    expect(preview).not.toMatch(/\/site-media\/p\d/);
    const live = (await service.resolvePublicPage('')).html;
    expect(live).toContain(`/site-media/p${onPage}-`);
    expect(live).not.toContain('/site-media/e');
  });

  test('with the no-AI setting on, the images say noimageai too', async () => {
    const shown = (await service.resolvePublicPage('')).html.match(new RegExp(`/site-media/p${onPage}-[0-9a-f]{10}\\.[0-9a-f]{32}/640`))[0];
    const tile = (await request(app).get(`/api/admin/website/galleries/${eventId}/photos`).set(auth(adminId))).body.photos[0].thumbnailUrl;
    await setSetting('seo_meta_noai', false, 'seo');
    cache.clearWebsiteCache();
    expect((await request(app).get(shown)).headers['x-robots-tag']).toBeUndefined();
    await setSetting('seo_meta_noai', true, 'seo');
    cache.clearWebsiteCache();
    try {
      expect((await request(app).get(shown)).headers['x-robots-tag']).toBe('noai, noimageai');
      expect((await request(app).get(tile)).headers['x-robots-tag']).toBe('noai, noimageai');
    } finally {
      await setSetting('seo_meta_noai', false, 'seo');
      cache.clearWebsiteCache();
    }
  });

  test('while the website is not live, only editor URLs work', async () => {
    const shown = (await service.resolvePublicPage('')).html.match(new RegExp(`/site-media/p${onPage}-[0-9a-f]{10}\\.[0-9a-f]{32}/640`))[0];
    const tile = (await request(app).get(`/api/admin/website/galleries/${eventId}/photos`).set(auth(adminId))).body.photos[0].thumbnailUrl;
    await setSetting('general_public_site_enabled', false);
    cache.clearWebsiteCache();
    try {
      expect((await request(app).get(shown)).status).toBe(404);
      expect((await request(app).get(tile)).status).toBe(200);
    } finally {
      await setSetting('general_public_site_enabled', true);
      cache.clearWebsiteCache();
    }
  });
});

describe('opening the editor', () => {
  test('a view-only admin sees the starting document, and nothing is written until an editor opens or saves', async () => {
    await setFeatureFlags(db, { websiteBuilder: true });
    const kept = await db('website_documents').where({ state: 'draft' }).first();
    await db('website_documents').where({ state: 'draft' }).del();
    try {
      const viewed = await request(app).get('/api/admin/website').set(auth(viewerId));
      expect(viewed.status).toBe(200);
      expect(viewed.body.document.pages.length).toBeGreaterThan(0);
      expect(await db('website_documents').where({ state: 'draft' }).first()).toBeUndefined();
      expect((await request(app).get('/api/admin/website').set(auth(adminId))).status).toBe(200);
      expect(await db('website_documents').where({ state: 'draft' }).first()).toBeTruthy();
    } finally {
      await db('website_documents').where({ state: 'draft' }).del();
      await db('website_documents').insert(kept);
    }
  });
});

describe('the published set is what the pages show', () => {
  let eventId; let heroPhoto; let quotePhoto; let galleryPhoto; let offEvent; let offPhoto;
  const publicUrl = (id) => `${media.mediaBase({ source: 'photo', id })}/640`;
  const save = async (pages) => request(app).put('/api/admin/website/draft').set(auth(adminId))
    .send({ document: { pages }, revision: (await request(app).get('/api/admin/website').set(auth(adminId))).body.draft.revision });
  const publish = async (pages) => {
    const saved = await save(pages);
    expect(saved.status).toBe(200);
    await request(app).post('/api/admin/website/publish').set(auth(adminId)).send({ revision: saved.body.draft.revision }).expect(200);
    cache.clearWebsiteCache();
  };

  beforeAll(async () => {
    await setFeatureFlags(db, { websiteBuilder: true });
    await setSetting('general_public_site_enabled', true);
    await setSetting('general_site_url', 'https://studio.example');
    frontendUrl.invalidateSiteUrlCache();
    await frontendUrl.primeSiteUrlCache();
    eventId = await insertEvent();
    heroPhoto = await insertPhoto(eventId);
    quotePhoto = await insertPhoto(eventId);
    galleryPhoto = await insertPhoto(eventId);
    offEvent = await insertEvent({ show_on_website: 0, event_name: 'Not on the website' });
    offPhoto = await insertPhoto(offEvent);
    await publish([{
      id: 'home', title: 'Home', slug: 'home', isHome: true,
      blocks: [
        { id: 'h', type: 'hero', variant: 'minimal', heading: 'Hello', image: { source: 'photo', id: heroPhoto } },
        { id: 't', type: 'testimonials', items: [{ author: 'Ada', quote: '', image: { source: 'photo', id: quotePhoto } }] },
        { id: 'g', type: 'gallery', images: [{ source: 'photo', id: galleryPhoto }] },
      ],
    }]);
  });

  test('a minimal hero\'s image is not shown, preloaded or shared, and has no public URL', async () => {
    const { html } = await service.resolvePublicPage('');
    expect(html).not.toContain(`/site-media/p${heroPhoto}-`);
    expect(html).not.toContain('rel="preload" as="image"');
    // The share image falls back to the next image the page does show.
    expect(html).toMatch(new RegExp(`<meta property="og:image" content="https://studio\\.example/site-media/p${galleryPhoto}-`));
    expect((await request(app).get(publicUrl(heroPhoto)).redirects(1)).status).toBe(404);
  });

  test('a testimonial without a quote is not shown, nor is its picture served', async () => {
    expect((await service.resolvePublicPage('')).html).not.toContain(`/site-media/p${quotePhoto}-`);
    expect((await request(app).get(publicUrl(quotePhoto)).redirects(1)).status).toBe(404);
    expect((await request(app).get(publicUrl(galleryPhoto)).redirects(1)).status).toBe(200);
  });

  test('the published set needs no watermark settings', async () => {
    const watermarkService = require('../../src/services/watermarkService');
    const spy = jest.spyOn(watermarkService, 'getWatermarkSettings').mockResolvedValue(null);
    cache.clearWebsiteCache();
    try {
      expect((await service.publishedPhotoIds()).has(galleryPhoto)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test('a not-found or failed answer is never cached', async () => {
    const res = await request(app).get(publicUrl(quotePhoto)).redirects(1);
    expect(res.status).toBe(404);
    expect(res.headers['cache-control']).toBe('no-store');
    const storage = require('../../src/services/storage').getStorage();
    const spy = jest.spyOn(storage, 'stat').mockRejectedValue(new Error('disk gone'));
    try {
      const failed = await request(app).get(publicUrl(galleryPhoto)).redirects(1);
      expect(failed.status).toBe(500);
      expect(failed.headers['cache-control']).toBe('no-store');
    } finally {
      spy.mockRestore();
    }
  });

  test('a new pick from a gallery that is not on the website is refused, for its owner too', async () => {
    const home = (extra) => ({ id: 'home', title: 'Home', slug: 'home', isHome: true, blocks: [{ id: 'g', type: 'gallery', images: [{ source: 'photo', id: galleryPhoto }, ...extra] }] });
    const photo = await save([home([{ source: 'photo', id: offPhoto }])]);
    expect(photo.status).toBe(409);
    expect(photo.body.code).toBe('WEBSITE_GALLERY_NOT_ON_WEBSITE');
    expect(photo.body.error).toContain('Not on the website');
    const featured = await save([{ ...home([]), blocks: [...home([]).blocks, { id: 'f', type: 'featuredGalleries', galleries: [{ id: offEvent }] }] }]);
    expect(featured.status).toBe(409);
    // A pick already stored stays when its gallery goes off.
    await db('events').where({ id: eventId }).update({ show_on_website: 0 });
    try {
      expect((await save([home([])])).status).toBe(200);
    } finally {
      await db('events').where({ id: eventId }).update({ show_on_website: 1 });
    }
  });
});

describe('telling admins where the landing page went', () => {
  const notice = async (who) => (await request(app).get('/api/admin/website/notice').set(auth(who))).body;
  let kept;

  beforeAll(async () => {
    await setFeatureFlags(db, { websiteBuilder: true });
    kept = await db('website_documents').where({ state: 'published' }).first();
    await db('website_documents').where({ state: 'published' }).del();
    await setSetting('website_legacy_landing_migrated', true);
  });
  afterAll(async () => {
    await db('app_settings').where({ setting_key: 'website_legacy_landing_migrated' }).del();
    await db('admin_notice_dismissals').del();
    if (kept && !(await db('website_documents').where({ state: 'published' }).first())) await db('website_documents').insert(kept);
  });

  test('a migrated install is told until each admin dismisses it, and the editor says the old page is still live', async () => {
    expect(await notice(adminId)).toEqual({ legacyLanding: true });
    expect((await request(app).get('/api/admin/website').set(auth(adminId))).body.legacyLandingLive).toBe(true);
    expect((await request(app).post('/api/admin/website/notice/dismiss').set(auth(viewerId))).status).toBe(204);
    expect(await notice(viewerId)).toEqual({ legacyLanding: false });
    expect(await notice(adminId)).toEqual({ legacyLanding: true });
  });

  test('publishing from the builder ends it for everyone', async () => {
    const state = (await request(app).get('/api/admin/website').set(auth(adminId))).body;
    await request(app).post('/api/admin/website/publish').set(auth(adminId)).send({ revision: state.draft.revision }).expect(200);
    expect(await notice(adminId)).toEqual({ legacyLanding: false });
    expect((await request(app).get('/api/admin/website').set(auth(adminId))).body.legacyLandingLive).toBe(false);
  });

  test('deleting an admin deletes their dismissals', async () => {
    const gone = await insertId('admin_users', { username: 'gone', email: 'gone@example.com', password_hash: 'x', must_change_password: false, created_at: new Date().toISOString() });
    await db('admin_notice_dismissals').insert({ admin_id: gone, notice_key: 'website_legacy_landing', dismissed_at: new Date().toISOString() });
    await require('../../src/services/userManagementService').deleteAdminUser(gone, adminId);
    expect(await db('admin_notice_dismissals').where({ admin_id: gone })).toHaveLength(0);
  });
});

describe('showing the website at the site root', () => {
  const visibility = (enabled, who = adminId) => request(app).put('/api/admin/website/visibility').set(auth(who)).send({ enabled });
  const stored = async () => (await request(app).get('/api/admin/website').set(auth(adminId))).body.publicSiteEnabled;

  test('the builder switches it, with cms.edit; on needs something to show', async () => {
    await setFeatureFlags(db, { websiteBuilder: true });
    expect((await visibility(true, viewerId)).status).toBe(403);
    const kept = await db('website_documents').where({ state: 'published' }).first();
    await db('website_documents').where({ state: 'published' }).del();
    await setSetting('general_public_site_html', require('../../src/constants/publicSiteDefaults').DEFAULT_PUBLIC_SITE_HTML.trim());
    await setSetting('general_public_site_custom_css', '');
    await setSetting('general_public_site_enabled', false);
    try {
      // Nothing published and only the untouched template: nothing to show.
      const refused = await visibility(true);
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('WEBSITE_NOTHING_TO_SHOW');
      expect(await stored()).toBe(false);
    } finally {
      if (kept) await db('website_documents').insert(kept);
    }
    expect((await visibility(true)).status).toBe(200);
    expect(await stored()).toBe(true);
    expect((await visibility('false')).status).toBe(200);
    expect(await stored()).toBe(false);
    expect((await visibility('maybe')).status).toBe(400);
    await visibility(true);
  });
});

describe('website traffic in analytics', () => {
  test('daily views, top pages, referrers and devices over the chosen days, with analytics.view', async () => {
    await setFeatureFlags(db, { websiteBuilder: true });
    const day = (offset) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
    await db('website_page_views').del();
    await db('website_page_views').insert([
      { day: day(0), page: '', referrer: 'instagram.com', device: 'mobile', views: 6 },
      { day: day(0), page: 'about', referrer: '', device: 'desktop', views: 3 },
      { day: day(1), page: '', referrer: '', device: 'desktop', views: 1 },
      // Outside the window.
      { day: day(40), page: 'old', referrer: 'example.org', device: 'tablet', views: 99 },
    ]);
    const res = await request(app).get('/api/admin/website/analytics?days=30').set(auth(adminId));
    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual({ views: 10 });
    expect(res.body.chartData).toHaveLength(30);
    expect(res.body.chartData.at(-1)).toEqual({ date: day(0), views: 9 });
    expect(res.body.topPages[0]).toMatchObject({ page: '', views: 7 });
    expect(res.body.topPages.map((p) => p.page)).not.toContain('old');
    expect(res.body.referrers).toEqual([{ domain: 'instagram.com', views: 6 }]);
    expect(res.body.devices).toEqual({ desktop: 40, mobile: 60, tablet: 0 });

    const now = new Date().toISOString();
    const editor = await insertId('admin_users', { username: 'cms-no-analytics', email: 'cms-no-analytics@example.com', password_hash: 'x', must_change_password: false, created_at: now });
    const roleId = await insertId('roles', { name: 'cms_no_analytics', display_name: 'CMS only', is_system: false, created_at: now });
    const permissionIds = await db('permissions').whereIn('name', ['cms.view', 'cms.edit']).pluck('id');
    await db('role_permissions').insert(permissionIds.map((permission_id) => ({ role_id: roleId, permission_id })));
    await db('admin_users').where({ id: editor }).update({ role_id: roleId });
    require('../../src/middleware/permissions').clearPermissionCache();
    expect((await request(app).get('/api/admin/website/analytics').set(auth(editor))).status).toBe(403);
  });
});

describe('uploading a font in the branding settings', () => {
  const WOFF2 = Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(200)]);

  test('stores a font for the galleries and the website, refuses others, and deletes an uploaded one', async () => {
    const up = (file, fields = {}) => {
      const req = request(app).post('/api/admin/settings/fonts').set(auth(adminId));
      Object.entries({ family: 'Studio Serif', weight: '400', generic: 'serif', ...fields }).forEach(([k, v]) => req.field(k, v));
      return req.attach('file', file, 'studio.woff2');
    };
    expect((await up(WOFF2, {}).set(auth(viewerId))).status).toBe(403);
    const bad = await up(Buffer.from('<svg onload=alert(1)>'.padEnd(64)));
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('FONT_TYPE');
    const tooBig = await up(Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(3 * 1024 * 1024)]));
    expect(tooBig.status).toBe(413);
    const ok = await up(WOFF2);
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ family: 'Studio Serif', weight: 400, format: 'woff2' });
    const fonts = (await request(app).get('/api/admin/settings/fonts').set(auth(adminId))).body.fonts;
    expect(fonts.find((f) => f.family === 'Studio Serif')).toMatchObject({ source: 'uploaded', generic: 'serif', weights: [400] });
    expect(fs.existsSync(path.join(process.env.STORAGE_PATH, 'fonts', 'Studio-Serif', '400.woff2'))).toBe(true);
    expect((await request(app).delete('/api/admin/settings/fonts/Studio%20Serif').set(auth(adminId))).status).toBe(204);
    expect((await request(app).delete('/api/admin/settings/fonts/Inter').set(auth(adminId))).status).toBe(404);
    expect(fs.existsSync(path.join(process.env.STORAGE_PATH, 'fonts', 'Studio-Serif'))).toBe(false);
  });
});

describe('legal and system pages in the website design', () => {
  const upsertCms = async (slug, row) => {
    const existing = await db('cms_pages').where({ slug }).first();
    const data = { title_en: slug, title_de: slug, content_en: '', content_de: '', updated_at: new Date().toISOString(), ...row };
    if (existing) await db('cms_pages').where({ slug }).update(data);
    else await db('cms_pages').insert({ slug, ...data });
  };

  beforeAll(async () => {
    const state = (await request(app).get('/api/admin/website').set(auth(adminId))).body;
    const document = { pages: [{ id: 'home', title: 'Home', slug: 'home', isHome: true, blocks: [] }, { id: 'about', title: 'About us', slug: 'about', blocks: [] }] };
    const saved = await request(app).put('/api/admin/website/draft').set(auth(adminId)).send({ document, revision: state.draft.revision }).expect(200);
    await request(app).post('/api/admin/website/publish').set(auth(adminId)).send({ revision: saved.body.draft.revision }).expect(200);
    await upsertCms('impressum', { title_en: 'Legal Notice', content_en: '<h2>Studio AG</h2><p>Bahnhofstrasse 1</p><script>alert(1)</script><img src="x" onerror="alert(2)">', use_external_url: false });
    await upsertCms('datenschutz', { title_en: 'Privacy Policy', content_en: '<p>Our policy</p>', use_external_url: true, external_url: 'https://legal.example/privacy' });
    await upsertCms('agb', { title_en: 'Terms', content_en: '<p>Terms</p>', use_external_url: true, external_url: 'javascript:alert(1)' });
    await upsertCms('not-found', { title_en: 'Page Not Found', content_en: '<p>Nothing lives here.</p>' });
  });

  test('a legal page renders in the website design with its CMS content kept to an allowlist', async () => {
    const page = await service.resolvePublicPage('impressum');
    expect(page.status).toBe(200);
    expect(page.system).toBe(true);
    expect(page.html).toContain('class="pp-header"');
    expect(page.html).toContain('<h1 class="pp-h">Legal Notice</h1>');
    expect(page.html).toContain('<h2>Studio AG</h2><p>Bahnhofstrasse 1</p>');
    expect(page.html).not.toMatch(/<script>|onerror/);
    expect(page.html).toContain('href="/about"');
  });

  test('a legal page with an external address leads there, a bad address renders the page', async () => {
    expect(await service.resolvePublicPage('datenschutz')).toEqual({ status: 302, location: 'https://legal.example/privacy' });
    const agb = await service.resolvePublicPage('agb');
    expect(agb.status).toBe(200);
    expect(agb.html).toContain('<p>Terms</p>');
  });

  test('an address with no page shows the not-found page, noindex, in the website design', async () => {
    const page = await service.resolvePublicPage('no-such-page');
    expect(page).toMatchObject({ status: 200, notFound: true, noindex: true, system: true });
    expect(page.html).toContain('Nothing lives here.');
    expect(page.html).toContain('class="pp-footer"');
    expect(page.html).toContain('content="noindex');
    // One rendering for every unknown address.
    expect((await service.resolvePublicPage('another-one')).html).toBe(page.html);
  });

  test('a legal page in the menu shows with its name though the footer hides it, and leads to its external address', async () => {
    await db('cms_pages').whereIn('slug', ['agb', 'datenschutz']).update({ show_in_footer: false });
    const state = (await request(app).get('/api/admin/website').set(auth(adminId))).body;
    const document = { ...state.document, menu: { items: [
      { id: 'm1', label: '', target: { kind: 'legal', slug: 'agb' } },
      { id: 'm2', label: '', target: { kind: 'legal', slug: 'datenschutz' } },
    ] } };
    const saved = await request(app).put('/api/admin/website/draft').set(auth(adminId)).send({ document, revision: state.draft.revision }).expect(200);
    await request(app).post('/api/admin/website/publish').set(auth(adminId)).send({ revision: saved.body.draft.revision }).expect(200);
    const html = (await service.resolvePublicPage('about')).html;
    const nav = html.match(/<nav class="pp-nav[^"]*" aria-label="Main"><ul>([\s\S]*?)<\/ul>/)[1];
    expect(nav).toBe('<li><a href="/agb">Terms</a></li><li><a href="https://legal.example/privacy" rel="noopener noreferrer">Privacy Policy</a></li>');
    await db('cms_pages').whereIn('slug', ['agb', 'datenschutz']).update({ show_in_footer: true });
  });

  test('while the website is not live, legal and unknown addresses stay with the app', async () => {
    await setFeatureFlags(db, { websiteBuilder: false });
    cache.clearWebsiteCache();
    expect(await service.resolvePublicPage('impressum')).toBeNull();
    expect(await service.resolvePublicPage('no-such-page')).toBeNull();
    await setFeatureFlags(db, { websiteBuilder: true });
  });

  test('saving a CMS page refreshes the website', async () => {
    const before = await service.resolvePublicPage('impressum');
    expect(before.html).toContain('Bahnhofstrasse 1');
    const cmsApp = express();
    cmsApp.use(express.json());
    cmsApp.use('/api/admin/cms', require('../../src/routes/adminCMS'));
    await request(cmsApp).put('/api/admin/cms/pages/impressum').set(auth(adminId)).send({ content_en: '<p>Seestrasse 9</p>' }).expect(200);
    expect((await service.resolvePublicPage('impressum')).html).toContain('Seestrasse 9');
  });
});

describe('spam check on the contact form', () => {
  const axios = require('axios');
  let ip = 100;
  const post = (fields) => {
    ip += 1;
    const req = request(app).post('/api/public/website/contact').set('X-Forwarded-For', `198.51.100.${ip}`).set('Sec-Fetch-Site', 'same-origin');
    Object.entries(fields).forEach(([k, v]) => req.field(k, v));
    return req;
  };
  const valid = { page: 'home', block: 'c1', name: 'Grace', email: 'grace@example.com', message: 'Hello' };
  const settings = (body, as = adminId) => request(app).put('/api/admin/website/contact-settings').set(auth(as)).send(body);

  beforeAll(async () => {
    const state = (await request(app).get('/api/admin/website').set(auth(adminId))).body;
    const document = { pages: [
      { id: 'home', title: 'Home', slug: 'home', isHome: true, blocks: [{ id: 'c1', type: 'contact' }] },
      { id: 'about', title: 'About', slug: 'about', blocks: [{ type: 'text', body: 'x' }] },
    ] };
    const saved = await request(app).put('/api/admin/website/draft').set(auth(adminId)).send({ document, revision: state.draft.revision }).expect(200);
    await request(app).post('/api/admin/website/publish').set(auth(adminId)).send({ revision: saved.body.draft.revision }).expect(200);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { await settings({ captcha: { provider: 'none' } }); });

  test('off by default; a provider needs its keys first; the API key is kept encrypted and never sent back', async () => {
    const initial = (await request(app).get('/api/admin/website/contact-settings').set(auth(adminId))).body;
    expect(initial.captcha).toMatchObject({ provider: 'none', friendly: { siteKey: '', apiKeySet: false }, recaptchaReady: false });
    expect((await settings({ captcha: { provider: 'friendly' } })).body.code).toBe('CAPTCHA_NOT_READY');
    expect((await settings({ captcha: { provider: 'recaptcha' } })).body.code).toBe('CAPTCHA_NOT_READY');
    expect((await settings({ captcha: { friendly: { siteKey: '<script>' } } })).body.code).toBe('CAPTCHA_SITE_KEY');
    expect((await settings({ captcha: { provider: 'friendly', friendly: { siteKey: 'FCMTEST0123', apiKey: 'A1-secret-key' } } }, viewerId)).status).toBe(403);
    const saved = await settings({ captcha: { provider: 'friendly', friendly: { siteKey: 'FCMTEST0123', apiKey: 'A1-secret-key', endpoint: 'eu' } } });
    expect(saved.status).toBe(200);
    expect(saved.body.captcha).toMatchObject({ provider: 'friendly', friendly: { siteKey: 'FCMTEST0123', endpoint: 'eu', apiKeySet: true } });
    expect(JSON.stringify(saved.body)).not.toContain('A1-secret-key');
    const row = await db('app_settings').where({ setting_key: 'website_captcha_friendly_api_key' }).first();
    expect(row.setting_value).not.toContain('A1-secret-key');
    const all = (await request(app).get('/api/admin/settings').set(auth(adminId))).body;
    expect(JSON.stringify(all)).not.toContain(decodeSettingValue(db, row.setting_value));
    // The generic settings writer cannot switch it.
    await request(app).put('/api/admin/settings/general').set(auth(adminId)).send({ website_captcha_provider: 'none' });
    expect((await request(app).get('/api/admin/website/contact-settings').set(auth(adminId))).body.captcha.provider).toBe('friendly');
  });

  test('a refused save changes nothing: the keys stay, and so does the check', async () => {
    const before = (await request(app).get('/api/admin/website/contact-settings').set(auth(adminId))).body;
    expect(before.captcha.provider).toBe('friendly');
    expect((await settings({ captcha: { friendly: { siteKey: '' } } })).body.code).toBe('CAPTCHA_NOT_READY');
    expect((await settings({ captcha: { friendly: { apiKey: '' } }, contact: { recipients: ['new@studio.example'] } })).body.code).toBe('CAPTCHA_NOT_READY');
    expect((await request(app).get('/api/admin/website/contact-settings').set(auth(adminId))).body).toEqual(before);
    const spy = jest.spyOn(axios, 'post');
    expect((await post(valid)).headers.location).toBe('/#contact-captcha-c1');
    expect(spy).not.toHaveBeenCalled();
  });

  test('only the page with the form loads the widget and allows the provider', async () => {
    cache.clearWebsiteCache();
    const home = await service.resolvePublicPage('');
    expect(home.captcha).toBe('friendly');
    expect(home.html).toContain('<div class="frc-captcha" data-sitekey="FCMTEST0123" data-api-endpoint="eu"');
    expect(home.html).toMatch(/<script type="module" src="https:\/\/cdn\.jsdelivr\.net\/npm\/@friendlycaptcha\/sdk@1\.1\.5\/site\.min\.js" integrity="sha384-/);
    const about = await service.resolvePublicPage('about');
    expect(about.captcha).toBeNull();
    expect(about.html).not.toMatch(/<script/);
  });

  test('a message without a valid answer is refused and stored nowhere; a valid one goes through', async () => {
    const spy = jest.spyOn(axios, 'post');
    const before = Number((await db('received_emails').count({ c: '*' }).first()).c);
    expect((await post(valid)).headers.location).toBe('/#contact-captcha-c1');
    expect(spy).not.toHaveBeenCalled();
    spy.mockResolvedValueOnce({ data: { success: false, error: { error_code: 'response_invalid' } } });
    expect((await post({ ...valid, 'frc-captcha-response': 'bad' })).headers.location).toBe('/#contact-captcha-c1');
    expect(Number((await db('received_emails').count({ c: '*' }).first()).c)).toBe(before);
    spy.mockResolvedValueOnce({ data: { success: true } });
    expect((await post({ ...valid, 'frc-captcha-response': 'good' })).headers.location).toBe('/#contact-sent-c1');
    expect(spy).toHaveBeenLastCalledWith('https://eu.frcapi.com/api/v2/captcha/siteverify', { response: 'good', sitekey: 'FCMTEST0123' },
      expect.objectContaining({ headers: { 'X-API-Key': 'A1-secret-key' } }));
    // The provider unreachable: refused, not let through.
    spy.mockRejectedValueOnce(new Error('timeout'));
    expect((await post({ ...valid, 'frc-captcha-response': 'good' })).headers.location).toBe('/#contact-captcha-c1');
  });

  test('reCAPTCHA uses the keys of the security settings', async () => {
    await setSetting('security_recaptcha_site_key', '6LcSiteKey', 'security');
    await setSetting('security_recaptcha_secret_key', 'recaptcha-secret', 'security');
    expect((await settings({ captcha: { provider: 'recaptcha' } })).status).toBe(200);
    expect((await service.resolvePublicPage('')).html).toContain('<div class="g-recaptcha" data-sitekey="6LcSiteKey"></div>');
    const spy = jest.spyOn(axios, 'post').mockResolvedValueOnce({ data: { success: true } });
    expect((await post({ ...valid, 'g-recaptcha-response': 'tok' })).headers.location).toBe('/#contact-sent-c1');
    expect(spy.mock.calls[0][0]).toBe('https://www.google.com/recaptcha/api/siteverify');
    expect(spy.mock.calls[0][1]).toContain('secret=recaptcha-secret');
  });
});

describe('mails of the contact form', () => {
  const axios = require('axios');
  let ip = 150;
  const post = (fields) => {
    ip += 1;
    const req = request(app).post('/api/public/website/contact').set('X-Forwarded-For', `198.51.100.${ip}`).set('Sec-Fetch-Site', 'same-origin');
    Object.entries(fields).forEach(([k, v]) => req.field(k, v));
    return req;
  };
  const valid = { page: 'home', block: 'c1', name: 'Linus', email: 'linus@example.com', message: 'Secret plans\nfor June' };
  const settings = (body, as = adminId) => request(app).put('/api/admin/website/contact-settings').set(auth(as)).send(body);
  const queued = (type) => db('email_queue').where({ email_type: type }).orderBy('id');

  beforeAll(async () => {
    await db('email_queue').del();
    await setSetting('branding_support_email', 'support@studio.example', 'branding');
    await settings({ captcha: { provider: 'none' }, contact: { recipients: [], confirmation: false } });
  });
  afterEach(() => jest.restoreAllMocks());

  test('the studio hears of a new message at the support address by default; the visitor gets nothing', async () => {
    const res = await post(valid);
    expect(res.headers.location).toBe('/#contact-sent-c1');
    const rows = await queued('website_contact_admin');
    expect(rows.map((r) => r.recipient_email)).toEqual(['support@studio.example']);
    const data = JSON.parse(rows[0].email_data);
    expect(data).toMatchObject({ sender_name: 'Linus', sender_email: 'linus@example.com', message: 'Secret plans\nfor June', page_title: 'Home' });
    expect(await queued('website_contact_confirmation')).toEqual([]);
    // Still in the inbox, as before.
    expect(await db('received_emails').where({ from_address: 'linus@example.com' }).first()).toBeTruthy();
  });

  test('recipients of their own; checked shapes and count', async () => {
    expect((await settings({ contact: { recipients: ['not-an-address'] } })).body.code).toBe('CONTACT_RECIPIENT');
    expect((await settings({ contact: { recipients: ['a@x.example', 'b@x.example', 'c@x.example', 'd@x.example', 'e@x.example', 'f@x.example'] } })).body.code).toBe('CONTACT_RECIPIENT');
    const saved = await settings({ contact: { recipients: ['owner@studio.example', 'assistant@studio.example'] } });
    expect(saved.body.contact).toMatchObject({ recipients: ['owner@studio.example', 'assistant@studio.example'], defaultRecipient: 'support@studio.example', confirmation: false });
    await db('email_queue').del();
    await post({ ...valid, email: 'second@example.com' });
    expect((await queued('website_contact_admin')).map((r) => r.recipient_email)).toEqual(['owner@studio.example', 'assistant@studio.example']);
  });

  test('a confirmation to the visitor only with a spam check on, without the message, once a day per address', async () => {
    expect((await settings({ contact: { confirmation: true } })).body.code).toBe('CONFIRMATION_NEEDS_CAPTCHA');
    await settings({ captcha: { provider: 'friendly', friendly: { siteKey: 'FCMTEST0123', apiKey: 'A1-secret-key' } }, contact: { confirmation: true } }).expect(200);
    await db('email_queue').del();
    jest.spyOn(axios, 'post').mockResolvedValue({ data: { success: true } });
    await post({ ...valid, email: 'third@example.com', 'frc-captcha-response': 'ok' });
    // queueEmail's created_at as SQLite really stores it, epoch ms (under jest
    // its Date would land as text, see CLAUDE.md).
    await db('email_queue').where({ email_type: 'website_contact_confirmation' }).update({ created_at: Date.now() - 60 * 1000 });
    await post({ ...valid, email: 'third@example.com', 'frc-captcha-response': 'ok' });
    const confirmations = await queued('website_contact_confirmation');
    expect(confirmations.map((r) => r.recipient_email)).toEqual(['third@example.com']);
    const data = JSON.parse(confirmations[0].email_data);
    expect(data.sender_name).toBe('Linus');
    expect(JSON.stringify(data)).not.toContain('Secret plans');
    expect(await queued('website_contact_admin')).toHaveLength(4);
    // A day later, the address can get one again.
    await db('email_queue').where({ email_type: 'website_contact_confirmation' }).update({ created_at: Date.now() - 25 * 60 * 60 * 1000 });
    await post({ ...valid, email: 'third@example.com', 'frc-captcha-response': 'ok' });
    expect(await queued('website_contact_confirmation')).toHaveLength(2);
    // Turning the spam check off turns the confirmation off with it.
    const off = await settings({ captcha: { provider: 'none' } });
    expect(off.body.contact.confirmation).toBe(false);
  });

  test('changing where messages go takes the settings permission', async () => {
    expect((await settings({ contact: { recipients: ['x@evil.example'] } }, viewerId)).status).toBe(403);
  });
});
