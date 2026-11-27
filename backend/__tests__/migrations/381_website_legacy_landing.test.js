/**
 * Migration 381 (issue 2618): installs that use the single-page landing
 * page get the website builder switched on and their page imported into
 * the draft. Their `/` keeps serving the old page until they publish.
 */
const { bootCrmDb } = require('../integration/helpers/crmDb');
const migration = require('../../migrations/core/381_website_legacy_landing');
const { DEFAULT_PUBLIC_SITE_HTML } = require('../../src/constants/publicSiteDefaults');

jest.setTimeout(120000);

let db; let cleanup;
beforeAll(async () => { ({ db, cleanup } = await bootCrmDb()); });
afterAll(async () => { if (cleanup) await cleanup(); });

const setSetting = async (key, value) => {
  await db('app_settings').where({ setting_key: key }).del();
  await db('app_settings').insert({ setting_key: key, setting_value: JSON.stringify(value), setting_type: 'general', updated_at: new Date().toISOString() });
};
const landing = async ({ enabled = false, html = DEFAULT_PUBLIC_SITE_HTML.trim(), css = '' } = {}) => {
  await setSetting('general_public_site_enabled', enabled);
  await setSetting('general_public_site_html', html);
  await setSetting('general_public_site_custom_css', css);
  await db('website_documents').del();
  await db('feature_flags').where({ key: 'websiteBuilder' }).update({ value: false });
  await db('app_settings').where({ setting_key: 'website_legacy_landing_migrated' }).del();
};
const flagOn = async () => Boolean((await db('feature_flags').where({ key: 'websiteBuilder' }).first()).value);
const draft = async () => db('website_documents').where({ state: 'draft' }).first();
const marked = async () => !!(await db('app_settings').where({ setting_key: 'website_legacy_landing_migrated' }).first());

test('an untouched, switched-off landing page changes nothing', async () => {
  await landing();
  await migration.up(db);
  expect(await flagOn()).toBe(false);
  expect(await draft()).toBeUndefined();
  expect(await marked()).toBe(false);
});

test.each([
  ['switched on', { enabled: true }],
  ['edited HTML', { html: '<section class="hero"><h1>Our studio</h1></section>' }],
  ['edited CSS', { css: '.hero{color:teal}' }],
])('a landing page in use (%s) switches the website on and is imported as the draft', async (_name, state) => {
  await landing(state);
  await migration.up(db);
  expect(await flagOn()).toBe(true);
  expect(await marked()).toBe(true);
  const row = await draft();
  expect(row).toBeTruthy();
  const document = JSON.parse(row.document);
  // Stored as the editor saves it: normalised, with ids.
  expect(document.pages[0].blocks[0]).toMatchObject({ type: 'customHtml', legacy: true, id: expect.stringMatching(/^[0-9a-f]{12}$/) });
  expect(document.pages[0].blocks[0].html).toContain(state.html ? 'Our studio' : 'hero');
  if (state.css) expect(document.customCss).toContain('.hero{color:teal}');
  // Nothing is published: `/` keeps serving the old page.
  expect(await db('website_documents').where({ state: 'published' }).first()).toBeUndefined();
});

test('a page too long for a custom HTML block switches the website on but is not cut into a draft', async () => {
  await landing({ enabled: true, html: `<p>${'x'.repeat(110 * 1024)}</p>` });
  await migration.up(db);
  expect(await flagOn()).toBe(true);
  expect(await draft()).toBeUndefined();
});

test('a re-run keeps a draft someone already edited, and down removes only what it added', async () => {
  await landing({ enabled: true });
  await migration.up(db);
  await db('website_documents').where({ state: 'draft' }).update({ document: '{"pages":[]}', revision: 7 });
  await migration.up(db);
  expect(await draft()).toMatchObject({ revision: 7, document: '{"pages":[]}' });
  expect(await db.schema.hasTable('admin_notice_dismissals')).toBe(true);
  await migration.down(db);
  expect(await db.schema.hasTable('admin_notice_dismissals')).toBe(false);
  expect(await marked()).toBe(false);
  await migration.up(db);
});
