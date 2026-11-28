/**
 * The single-page landing page and the website builder (issue 2618): what a
 * website starts from (the imported landing page, else the starter site),
 * and telling the admins of an install that migration 381 moved into the
 * builder where their page went.
 */
const { db } = require('../../database/db');
const { getAppSettings } = require('../../utils/appSettings');
const { legacyImport, newPageId } = require('./document');
const { flag } = require('./validators');
const { readRow } = require('./rows');

function starterDocument() {
  const home = newPageId();
  return {
    pages: [{
      id: home,
      slug: 'home',
      title: 'Home',
      isHome: true,
      blocks: [
        // The block ids here are fixed so the hero's button finds the
        // contact form.
        { id: 'hero', type: 'hero', variant: 'minimal', heading: 'Photography for the moments that matter', subheading: 'Weddings, portraits and events, told honestly and beautifully.', buttonLabel: 'Get in touch', buttonTarget: { kind: 'anchor', pageId: home, blockId: 'contact' } },
        { id: 'about', type: 'text', variant: 'center', heading: 'About', body: '<p>Tell your visitors who you are and how you work.</p>' },
        { id: 'contact', type: 'contact', variant: 'simple', heading: 'Let’s talk', intro: 'Tell me about your plans.' },
      ],
    }],
  };
}

/** The single-page landing page as a first draft (document.js legacyImport). */
async function legacySite() {
  const settings = await getAppSettings(['general_public_site_enabled', 'general_public_site_html', 'general_public_site_custom_css']);
  return legacyImport({
    enabled: flag(settings.general_public_site_enabled),
    html: settings.general_public_site_html,
    css: settings.general_public_site_custom_css,
  });
}

/**
 * The document a site starts from the first time the builder opens: the
 * imported landing page, else the starter. Nothing anyone published changes
 * until they publish the builder's version.
 */
async function initialDocument() {
  const legacy = await legacySite();
  if (legacy.document) return { document: legacy.document, imported: true };
  return { document: starterDocument(), imported: false, ...(legacy.refused ? { refused: legacy.refused } : {}) };
}

const LEGACY_NOTICE = 'website_legacy_landing';

/** An install migration 381 moved into the builder, whose old page `/` still serves. */
async function legacyLandingLive(published) {
  if (published) return false;
  const settings = await getAppSettings(['website_legacy_landing_migrated']);
  return flag(settings.website_legacy_landing_migrated);
}

/** Whether this admin is still to be told where the landing page went. */
async function legacyLandingNotice(adminId) {
  if (!(await legacyLandingLive(await readRow('published')))) return false;
  return !(await db('admin_notice_dismissals').where({ admin_id: adminId, notice_key: LEGACY_NOTICE }).first('id'));
}

async function dismissLegacyLandingNotice(adminId) {
  await db('admin_notice_dismissals')
    .insert({ admin_id: adminId, notice_key: LEGACY_NOTICE, dismissed_at: new Date().toISOString() })
    .onConflict(['admin_id', 'notice_key']).ignore();
}

/** The import refusal the editor shows while the old page is still what / serves. */
async function importRefusal({ published }) {
  if (published) return null;
  return (await legacySite()).refused || null;
}

module.exports = {
  legacySite, initialDocument, legacyLandingLive, legacyLandingNotice, dismissLegacyLandingNotice, importRefusal };
