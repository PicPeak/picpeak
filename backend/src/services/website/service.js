/**
 * Website builder data layer (issue 2618): draft and published documents,
 * the public page renderer's context, the page cache and the sitemap.
 *
 * The public site switches to the builder only when all three hold: the
 * `websiteBuilder` flag is on, the public site is enabled, and something has
 * been published. Until then `/` is the single-page public site, untouched.
 */
const crypto = require('crypto');
const { db } = require('../../database/db');
const { parseSettingValue } = require('../../utils/appSettings');
const { formatBoolean } = require('../../utils/dbCompat');
const { AppError } = require('../../utils/errors');
const { isFeatureEnabled } = require('../../middleware/requireFeatureFlag');
const { getFrontendBaseUrl } = require('../../utils/frontendUrl');
const { canAccessEvent } = require('../../middleware/ownership');
const { listFonts } = require('../fontsService');
const publicSite = require('../publicSiteService');
const { DEFAULT_PUBLIC_SITE_CSS } = require('../../constants/publicSiteDefaults');
const { normalizeDocument, collectReferences, newPageId, LIMIT_CODES } = require('./document');
const media = require('./media');
const { livePhotos } = require('../../utils/photoVisibility');
const { renderPage, pageHref } = require('./renderer');
const { getCached, setCached, clearWebsiteCache } = require('./cache');

const FLAG = 'websiteBuilder';
const LEGAL_SLUGS = ['impressum', 'datenschutz', 'agb'];

function parseDocument(row) {
  if (!row) return null;
  try {
    return JSON.parse(row.document);
  } catch {
    return null;
  }
}

async function readRow(state, conn = db) {
  return conn('website_documents').where({ state }).first();
}

async function cmsSlugs() {
  return db('cms_pages').pluck('slug');
}

function rowSummary(row) {
  if (!row) return null;
  return {
    revision: Number(row.revision),
    updatedAt: row.updated_at,
    publishedAt: row.published_at || null,
  };
}

// ---------------------------------------------------------------------------
// Draft and publish
// ---------------------------------------------------------------------------

function starterDocument() {
  return {
    pages: [{
      id: newPageId(),
      slug: 'home',
      title: 'Home',
      isHome: true,
      blocks: [
        { type: 'hero', variant: 'minimal', heading: 'Photography for the moments that matter', subheading: 'Weddings, portraits and events, told honestly and beautifully.', buttonLabel: 'Get in touch', buttonUrl: '#contact' },
        { type: 'text', variant: 'center', heading: 'About', body: 'Tell your visitors who you are and how you work.' },
        { type: 'contact', variant: 'simple', heading: 'Let’s talk', intro: 'Tell me about your plans.' },
      ],
    }],
  };
}

/**
 * The document a site starts from the first time the builder opens. An
 * existing single-page site is imported as it is: its HTML becomes the home
 * page's one custom-HTML block, its stylesheet (with the template's base CSS
 * it was written against) the site's custom CSS. Nothing anyone published
 * changes until they publish the builder's version.
 */
async function initialDocument() {
  const rows = await db('app_settings')
    .whereIn('setting_key', ['general_public_site_html', 'general_public_site_custom_css']);
  const settings = {};
  rows.forEach((row) => { settings[row.setting_key] = parseSettingValue(row.setting_value); });
  const html = typeof settings.general_public_site_html === 'string' ? settings.general_public_site_html : '';
  if (!html.trim()) return { document: starterDocument(), imported: false };
  const css = typeof settings.general_public_site_custom_css === 'string' ? settings.general_public_site_custom_css : '';
  return {
    imported: true,
    document: {
      pages: [{ id: newPageId(), slug: 'home', title: 'Home', isHome: true, blocks: [{ type: 'customHtml', html }] }],
      customCss: `${DEFAULT_PUBLIC_SITE_CSS}\n\n${css}`.trim(),
    },
  };
}

/** The draft, created on first use (with the legacy import). */
async function ensureDraft(adminId = null) {
  const existing = await readRow('draft');
  if (existing) return existing;
  const { document: raw, imported } = await initialDocument();
  const { document } = normalizeDocument(raw);
  try {
    await db('website_documents').insert({
      state: 'draft',
      document: JSON.stringify(document),
      revision: 1,
      updated_by: adminId,
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    // A concurrent first open inserted it first (state is unique).
    const raced = await readRow('draft');
    if (raced) return raced;
    throw err;
  }
  if (imported) {
    require('../../utils/logger').info('Website builder: imported the single-page public site into the draft');
  }
  return readRow('draft');
}

async function getEditorState(adminId) {
  const draft = await ensureDraft(adminId);
  const published = await readRow('published');
  const settings = await readSettings(['general_public_site_enabled']);
  return {
    document: parseDocument(draft),
    draft: rowSummary(draft),
    published: rowSummary(published),
    hasUnpublishedChanges: !published || published.document !== draft.document,
    // Publishing changes nothing visible while the public site is off.
    publicSiteEnabled: settings.general_public_site_enabled === true,
  };
}

function validationError(errors) {
  // Over a limit: refused as too large, never shortened behind the admin's back.
  const err = errors.some((e) => LIMIT_CODES.has(e.code))
    ? new AppError('The website is over a size limit (pages, blocks, items or text length); nothing was saved', 400, 'WEBSITE_LIMIT_EXCEEDED')
    : new AppError('The website has problems to fix before it can be saved', 422, 'WEBSITE_INVALID');
  err.details = errors;
  return err;
}

/** Photos and galleries the stored draft or published site already use. */
async function storedReferences() {
  const photoIds = new Set();
  const eventIds = new Set();
  for (const row of await db('website_documents').select('document')) {
    const raw = parseDocument(row);
    if (!raw) continue;
    const refs = collectReferences(normalizeDocument(raw).document);
    refs.photoIds.forEach((id) => photoIds.add(id));
    refs.eventIds.forEach((id) => eventIds.add(id));
  }
  return { photoIds, eventIds };
}

/**
 * The photos and galleries an admin may reference: those of galleries they
 * may act on (owner, assigned, or a role that manages every gallery — the
 * rule of the admin gallery and photo routes), plus whatever the stored
 * site already uses, so a colleague can edit a page that shows a pick they
 * could not have made themselves.
 */
async function referencesAdminMay(admin, { photoIds = [], eventIds = [] }) {
  const stored = await storedReferences();
  // A photo in the trash is not offered for a new pick.
  const photoRows = photoIds.length ? await livePhotos(db).whereIn('id', photoIds).select('id', 'event_id') : [];
  const candidates = [...new Set([...eventIds, ...photoRows.map((p) => p.event_id)])];
  const events = candidates.length ? await db('events').whereIn('id', candidates) : [];
  const accessible = new Set(events.filter((e) => canAccessEvent(admin, e)).map((e) => e.id));
  const photoEvent = new Map(photoRows.map((p) => [p.id, p.event_id]));
  return {
    photoIds: new Set(photoIds.filter((id) => stored.photoIds.has(id) || accessible.has(photoEvent.get(id)))),
    eventIds: new Set(eventIds.filter((id) => stored.eventIds.has(id) || accessible.has(id))),
  };
}

async function saveDraft(rawDocument, expectedRevision, admin) {
  const adminId = admin.id;
  const { document, errors } = normalizeDocument(rawDocument, { reservedSlugs: await cmsSlugs() });
  if (errors.length) throw validationError(errors);
  const refs = collectReferences(document);
  const allowed = await referencesAdminMay(admin, refs);
  const refused = [
    ...refs.photoIds.filter((id) => !allowed.photoIds.has(id)).map((id) => ({ code: 'PHOTO_NOT_ACCESSIBLE', photoId: id })),
    ...refs.eventIds.filter((id) => !allowed.eventIds.has(id)).map((id) => ({ code: 'GALLERY_NOT_ACCESSIBLE', eventId: id })),
  ];
  if (refused.length) {
    const err = new AppError('The page uses photos or galleries you cannot access', 422, 'WEBSITE_REFERENCE_NOT_ACCESSIBLE');
    err.details = refused;
    throw err;
  }
  const current = await ensureDraft(adminId);
  if (expectedRevision != null && Number(expectedRevision) !== Number(current.revision)) {
    throw new AppError('The website was changed elsewhere. Reload to get the latest version.', 409, 'WEBSITE_REVISION_CONFLICT');
  }
  const nextRevision = Number(current.revision) + 1;
  const updated = await db('website_documents')
    .where({ state: 'draft', revision: current.revision })
    .update({
      document: JSON.stringify(document),
      revision: nextRevision,
      updated_by: adminId,
      updated_at: new Date().toISOString(),
    });
  if (!updated) {
    throw new AppError('The website was changed elsewhere. Reload to get the latest version.', 409, 'WEBSITE_REVISION_CONFLICT');
  }
  return getEditorState(adminId);
}

/**
 * Copy the draft into the published row. One transaction: visitors see the
 * old site or the new one, never a mix. The draft is validated again, since
 * a cms page may have taken a slug since it was saved.
 */
async function publish(expectedRevision, adminId) {
  const reserved = await cmsSlugs();
  await db.transaction(async (trx) => {
    const draft = await readRow('draft', trx);
    if (!draft) throw new AppError('There is nothing to publish yet', 404, 'WEBSITE_NO_DRAFT');
    if (expectedRevision != null && Number(expectedRevision) !== Number(draft.revision)) {
      throw new AppError('The website was changed elsewhere. Reload to get the latest version.', 409, 'WEBSITE_REVISION_CONFLICT');
    }
    const { errors } = normalizeDocument(parseDocument(draft), { reservedSlugs: reserved });
    if (errors.length) throw validationError(errors);
    const now = new Date().toISOString();
    const values = {
      document: draft.document,
      revision: draft.revision,
      updated_by: adminId,
      updated_at: now,
      published_at: now,
    };
    const existing = await readRow('published', trx);
    if (existing) await trx('website_documents').where({ state: 'published' }).update(values);
    else await trx('website_documents').insert({ state: 'published', ...values });
  });
  clearWebsiteCache();
  return getEditorState(adminId);
}

/** Throw the draft away and start again from what is published. */
async function discardDraft(adminId) {
  const published = await readRow('published');
  if (!published) throw new AppError('Nothing has been published yet', 404, 'WEBSITE_NOT_PUBLISHED');
  const draft = await ensureDraft(adminId);
  await db('website_documents').where({ state: 'draft' }).update({
    document: published.document,
    revision: Number(draft.revision) + 1,
    updated_by: adminId,
    updated_at: new Date().toISOString(),
  });
  return getEditorState(adminId);
}

// ---------------------------------------------------------------------------
// Render context
// ---------------------------------------------------------------------------

function firstFamily(value) {
  if (typeof value !== 'string') return null;
  const first = value.split(',')[0].trim().replace(/^['"]|['"]$/g, '');
  return first || null;
}

async function readThemeConfig() {
  const row = await db('app_settings').where({ setting_key: 'theme_config' }).first();
  if (!row) return {};
  try {
    const parsed = parseSettingValue(row.setting_value);
    const config = typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
    return config && typeof config === 'object' ? config : {};
  } catch {
    return {};
  }
}

const BUTTON_STYLE_FROM_BRANDING = { solid: 'solid', outline: 'outline', ghost: 'outline' };

/** The site theme: the document's overrides over the gallery branding. */
async function resolveTheme(docTheme) {
  const [branding, themeConfig, fonts] = await Promise.all([
    publicSite.fetchBrandingContext(),
    readThemeConfig(),
    listFonts().catch(() => []),
  ]);
  // Family names go into the page's CSS; a folder name an operator dropped
  // into STORAGE_PATH/fonts is only used when it is a plain name.
  const byName = new Map(fonts.filter((f) => /^[A-Za-z0-9 ]{1,60}$/.test(f.family)).map((f) => [f.family.toLowerCase(), f]));
  const findFont = (name) => (name ? byName.get(name.toLowerCase()) || null : null);
  const body = findFont(docTheme.bodyFont) || findFont(firstFamily(themeConfig.fontFamily));
  const heading = findFont(docTheme.headingFont)
    || findFont(firstFamily(themeConfig.headingFontFamily)) || body;
  const c = branding.colors;
  return {
    branding,
    fonts: { body, heading },
    theme: {
      background: docTheme.background || c.background,
      text: docTheme.text || c.text,
      accent: docTheme.accent || c.accentDark || c.primary,
      muted: c.mutedText,
      surface: c.surface,
      border: c.border,
      buttonStyle: docTheme.buttonStyle || BUTTON_STYLE_FROM_BRANDING[themeConfig.buttonStyle] || 'solid',
      radius: ['none', 'sm', 'md', 'lg'].includes(themeConfig.borderRadius) ? themeConfig.borderRadius : 'md',
    },
  };
}

async function readSettings(keys) {
  const rows = await db('app_settings').whereIn('setting_key', keys);
  const out = {};
  rows.forEach((row) => { out[row.setting_key] = parseSettingValue(row.setting_value); });
  return out;
}

/**
 * Catalogue packages for the pricing block, priced as a quote from the
 * package would be: each item through the catalogue's presetLine (fixed
 * price, or the item's pinned hour/day rate), an 'auto' rate from the
 * studio's default rates. A package with an item that has no rate at all
 * gets no price rather than a sum that leaves the item out.
 */
async function loadPackages(ids) {
  if (!ids.length || !(await isFeatureEnabled('quotes'))) return new Map();
  const { listPackages } = require('../quoteCatalogService');
  const { presetLine } = require('../quoteTemplateService');
  const rateResolver = require('../rateResolver');
  const [packages, rates] = await Promise.all([listPackages({ activeOnly: true, ids }), rateResolver.loadRates(null)]);
  return new Map(packages.map((pkg) => {
    const items = pkg.items.filter((item) => item.preset_is_active === true || item.preset_is_active === 1);
    let totalMinor = 0;
    for (const item of items) {
      const line = presetLine({ ...item, name: item.preset_name }, item.quantity, item.bound_to);
      let unit = line.unitPriceMinor;
      if (line.rateSource === 'auto') {
        const rate = rateResolver.pickRate(rates, line.priceMode);
        unit = rate ? rate.rateMinor : null;
      }
      if (unit == null || totalMinor == null) {
        totalMinor = null;
      } else {
        totalMinor += Math.round(Number(unit) * Number(line.quantity));
      }
    }
    return [pkg.id, {
      name: pkg.name,
      description: pkg.description || '',
      currency: pkg.currency,
      totalMinor,
      items: items.map((item) => item.preset_name).filter(Boolean),
    }];
  }));
}

async function bookingState() {
  if (!(await isFeatureEnabled('calendarBooking'))) return { enabled: false };
  const { bookableServices } = require('../bookingService');
  const services = await bookableServices();
  return { enabled: services.length > 0, url: '/book' };
}

async function legalLinks(locale) {
  const rows = await db('cms_pages').whereIn('slug', LEGAL_SLUGS);
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  const { safeUrl } = require('./document');
  const fallback = { impressum: 'Impressum', datenschutz: locale === 'de' ? 'Datenschutz' : 'Privacy Policy', agb: locale === 'de' ? 'AGB' : 'Terms & Conditions' };
  return LEGAL_SLUGS.map((slug) => {
    const row = bySlug.get(slug);
    if (!row || !(row.show_in_footer === true || row.show_in_footer === 1)) return null;
    const external = (row.use_external_url === true || row.use_external_url === 1) ? safeUrl(row.external_url) : '';
    const label = (locale === 'de' ? row.title_de : row.title_en) || fallback[slug];
    return { href: external || `/${slug}`, label };
  }).filter(Boolean);
}

function robotsDirective(seo) {
  const directives = [];
  if (seo.seo_allow_indexing !== true || seo.seo_meta_noindex) directives.push('noindex');
  if (seo.seo_meta_nofollow) directives.push('nofollow');
  if (seo.seo_meta_noai) directives.push('noai', 'noimageai');
  return directives.join(', ');
}

/**
 * Everything the renderer needs for one page of `document`. `preview` marks
 * the editor's render: block ids on the sections, the contact form disabled.
 */
async function buildContext(document, page, { preview = false, allowed = null } = {}) {
  const refs = collectReferences(document);
  if (allowed) {
    // The preview of an unsaved draft shows only what its admin may pick.
    refs.photoIds = refs.photoIds.filter((id) => allowed.photoIds.has(id));
    refs.eventIds = refs.eventIds.filter((id) => allowed.eventIds.has(id));
  }
  const settings = await readSettings([
    'general_default_language', 'seo_allow_indexing', 'seo_meta_noindex', 'seo_meta_nofollow', 'seo_meta_noai',
  ]);
  const locale = settings.general_default_language === 'de' ? 'de' : 'en';
  const [themeInfo, photos, assets, events, packages, booking, legal, baseUrl] = await Promise.all([
    resolveTheme(document.theme),
    media.loadEligiblePhotos(refs.photoIds),
    media.loadAssets(refs.assetIds),
    media.loadEligibleEvents(refs.eventIds),
    loadPackages(refs.packageIds),
    bookingState(),
    legalLinks(locale),
    getFrontendBaseUrl().catch(() => ''),
  ]);
  const covers = await media.loadCoverPhotos([...events.values()]);
  const sanitizeCustomHtml = (html) => publicSite.applyBrandTokens(publicSite.sanitizeHtmlPayload(html || ''), themeInfo.branding);
  const { sanitizeCss } = require('../../utils/cssSanitizer');
  return {
    document,
    page,
    preview,
    locale,
    branding: themeInfo.branding,
    theme: themeInfo.theme,
    fonts: themeInfo.fonts,
    photos,
    assets,
    events,
    covers,
    packages,
    booking,
    legalLinks: legal,
    baseUrl: baseUrl || '',
    robots: preview ? 'noindex' : robotsDirective(settings),
    customCss: sanitizeCss(document.customCss || ''),
    sanitizeCustomHtml,
  };
}

async function renderPreview(rawDocument, pageId, admin) {
  const { document } = normalizeDocument(rawDocument);
  const page = document.pages.find((p) => p.id === pageId) || document.pages[0];
  if (!page) throw new AppError('The website has no pages', 422, 'WEBSITE_INVALID');
  const allowed = await referencesAdminMay(admin, collectReferences(document));
  return renderPage(await buildContext(document, page, { preview: true, allowed }));
}

// ---------------------------------------------------------------------------
// Public site
// ---------------------------------------------------------------------------

async function publishedDocument() {
  const row = await readRow('published');
  const raw = parseDocument(row);
  return raw ? normalizeDocument(raw).document : null;
}

/** Flag on, public site on, something published: the builder owns `/`. */
async function isWebsiteActive() {
  if (!(await isFeatureEnabled(FLAG))) return false;
  const settings = await readSettings(['general_public_site_enabled']);
  if (settings.general_public_site_enabled !== true) return false;
  return !!(await db('website_documents').where({ state: 'published' }).first('id'));
}

/**
 * The public answer for a path: `slug` is '' for `/`. Returns null when the
 * builder does not own the path (inactive, unknown or hidden page), so the
 * caller falls through exactly as before.
 */
async function resolvePublicPage(slug) {
  if (!(await isWebsiteActive())) return null;
  const key = `page:${slug}`;
  const cached = getCached(key);
  if (cached !== undefined) return cached;
  const document = await publishedDocument();
  if (!document) return null;
  let result = null;
  const visible = document.pages.filter((p) => !p.hidden);
  if (!slug) {
    const home = visible.find((p) => p.isHome);
    if (home) result = { status: 200, page: home };
  } else {
    const page = visible.find((p) => p.slug === slug);
    if (page && page.isHome) result = { status: 301, location: '/' };
    else if (page) result = { status: 200, page };
  }
  if (result && result.status === 200) {
    const html = renderPage(await buildContext(document, result.page));
    result = { status: 200, html, etag: `W/"${crypto.createHash('sha1').update(html).digest('hex')}"`, noindex: /name="robots" content="[^"]*noindex/.test(html) };
  }
  // Misses are cached too, so a crawler walking random slugs costs one
  // lookup per slug and TTL, not a document parse per request.
  setCached(key, result);
  return result;
}

function xmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** sitemap.xml of the published pages; null while the builder is inactive. */
async function sitemapXml() {
  if (!(await isWebsiteActive())) return null;
  const cached = getCached('sitemap');
  if (cached !== undefined) return cached;
  const document = await publishedDocument();
  const base = await getFrontendBaseUrl().catch(() => '');
  const settings = await readSettings(['seo_allow_indexing']);
  // Sitemap entries must be absolute; without a known public origin, or with
  // indexing off, the sitemap is empty rather than pointing at a guess.
  const pages = base && settings.seo_allow_indexing === true ? document.pages.filter((p) => !p.hidden) : [];
  const urls = pages.map((p) => `<url><loc>${xmlEscape(`${base}${pageHref(p)}`)}</loc></url>`).join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>\n`;
  setCached('sitemap', xml);
  return xml;
}

// ---------------------------------------------------------------------------
// Galleries (show on website)
// ---------------------------------------------------------------------------

async function setGalleryOnWebsite(eventId, enabled) {
  const updated = await db('events').where({ id: eventId }).update({ show_on_website: formatBoolean(Boolean(enabled)) });
  if (!updated) throw new AppError('Gallery not found', 404, 'EVENT_NOT_FOUND');
  clearWebsiteCache();
}

module.exports = {
  FLAG,
  ensureDraft,
  getEditorState,
  saveDraft,
  publish,
  discardDraft,
  renderPreview,
  resolvePublicPage,
  isWebsiteActive,
  sitemapXml,
  publishedDocument,
  setGalleryOnWebsite,
  buildContext,
  referencesAdminMay,
  _internal: { initialDocument, robotsDirective, loadPackages },
};
