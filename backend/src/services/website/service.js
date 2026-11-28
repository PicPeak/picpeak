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
const { parseBooleanInput } = require('../../utils/parsers');
const { isFeatureEnabled } = require('../../middleware/requireFeatureFlag');
const { getFrontendBaseUrl } = require('../../utils/frontendUrl');
const { canAccessEvent } = require('../../middleware/ownership');
const { userHasAllPermissions } = require('../../middleware/permissions');
const { listFonts } = require('../fontsService');
const publicSite = require('../publicSiteService');
const {
  normalizeDocument, collectReferences, legacyImport, newPageId, LIMIT_CODES, MAX_CUSTOM_CSS, LEGAL_SLUGS,
} = require('./document');
const media = require('./media');
const { livePhotos } = require('../../utils/photoVisibility');
const { renderPage, renderSystemPage, renderedImages, pageHref, legalPageName } = require('./renderer');
const { sanitizeCmsHtml } = require('./richText');
const { cacheGeneration, getCached, setCached, clearWebsiteCache } = require('./cache');

const FLAG = 'websiteBuilder';

// A boolean setting as stored: JSON true, or 1/0 where the settings writer
// went through formatBoolean on SQLite.
const flag = (value) => parseBooleanInput(value, false);

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
        { id: 'about', type: 'text', variant: 'center', heading: 'About', body: 'Tell your visitors who you are and how you work.' },
        { id: 'contact', type: 'contact', variant: 'simple', heading: 'Let’s talk', intro: 'Tell me about your plans.' },
      ],
    }],
  };
}

/** The single-page landing page as a first draft (document.js legacyImport). */
async function legacySite() {
  const settings = await readSettings(['general_public_site_enabled', 'general_public_site_html', 'general_public_site_custom_css']);
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
  const settings = await readSettings(['website_legacy_landing_migrated']);
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

/**
 * Show the website at the site root, or not (the setting the CMS tab's
 * landing page switch used to write). On needs something to show: a
 * published website, or a landing page the install uses; the untouched
 * template is not it.
 */
async function setSiteVisible(enabled) {
  if (enabled && !(await readRow('published')) && !(await legacySite()).used) {
    throw new AppError('Publish the website first: there is nothing to show yet', 409, 'WEBSITE_NOTHING_TO_SHOW');
  }
  const value = JSON.stringify(formatBoolean(enabled));
  const now = new Date().toISOString();
  const updated = await db('app_settings').where({ setting_key: 'general_public_site_enabled' }).update({ setting_value: value, updated_at: now });
  if (!updated) {
    await db('app_settings').insert({ setting_key: 'general_public_site_enabled', setting_value: value, setting_type: 'general', updated_at: now });
  }
  publicSite.clearPublicSiteCache();
}

/** The import refusal the editor shows while the old page is still what / serves. */
async function importRefusal({ published }) {
  if (published) return null;
  return (await legacySite()).refused || null;
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

/** The branding's colours, as swatches for a custom block background. */
async function brandColors() {
  const c = (await publicSite.fetchBrandingContext()).colors || {};
  const colours = [c.primary, c.accent, c.accentDark, c.background, c.surface, c.text]
    .filter((value) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value))
    .map((value) => value.toLowerCase());
  return [...new Set(colours)];
}

/**
 * The editor's state for a given draft row. A save or publish passes the
 * row it wrote, so its answer is exactly that, never a draft another editor
 * saved a moment later.
 */
async function editorState(draft, published) {
  const settings = await readSettings(['general_public_site_enabled']);
  return {
    // As the editor saves it (normalised): an older stored shape, such as a
    // text block's inline format, reaches the editor in the current one.
    document: normalizeDocument(parseDocument(draft) || {}).document,
    draft: rowSummary(draft),
    published: rowSummary(published),
    hasUnpublishedChanges: !published || published.document !== draft.document,
    // Publishing changes nothing visible while the public site is off.
    publicSiteEnabled: flag(settings.general_public_site_enabled),
    legacyImportRefused: await importRefusal({ published }),
    // Migration 381 imported the landing page, which `/` still serves.
    legacyLandingLive: await legacyLandingLive(published),
    // The public origin the sitemap and the canonical links use, for the
    // editor's "Open site"; '' when none is configured.
    publicUrl: await getFrontendBaseUrl().catch(() => ''),
    brandColors: await brandColors(),
  };
}

/**
 * The editor's state. Opening it writes the first draft (with the legacy
 * import) only for an admin who may change the website: a view-only admin
 * sees the starting document, and nothing is stored until an editor opens
 * or saves it.
 */
async function getEditorState(adminId) {
  let draft = await readRow('draft');
  if (!draft && await userHasAllPermissions(adminId, ['cms.edit'])) draft = await ensureDraft(adminId);
  if (!draft) {
    const { document } = normalizeDocument((await initialDocument()).document);
    draft = { document: JSON.stringify(document), revision: 1, updated_at: null };
  }
  return editorState(draft, await readRow('published'));
}

/** A refusal that says what it refused: `details`, which the editor shows per item. */
function refusal(message, status, code, details) {
  const err = new AppError(message, status, code);
  err.details = details;
  return err;
}

function validationError(errors) {
  if (errors.some((e) => e.code === 'TOO_MANY_CONTACT_FORMS')) {
    return refusal('A page can have one contact form; remove the second one, or move it to another page', 400, 'WEBSITE_ONE_CONTACT_FORM', errors);
  }
  // Over a limit: refused as too large, never shortened behind the admin's back.
  return errors.some((e) => LIMIT_CODES.has(e.code))
    ? refusal('The website is over a size limit (pages, blocks, items or text length); nothing was saved', 400, 'WEBSITE_LIMIT_EXCEEDED', errors)
    : refusal('The website has problems to fix before it can be saved', 422, 'WEBSITE_INVALID', errors);
}

/** Photos, galleries and packages the stored draft or published site already use. */
async function storedReferences() {
  const photoIds = new Set();
  const eventIds = new Set();
  const packageIds = new Set();
  for (const row of await db('website_documents').select('document')) {
    const raw = parseDocument(row);
    if (!raw) continue;
    const refs = collectReferences(normalizeDocument(raw).document);
    refs.photoIds.forEach((id) => photoIds.add(id));
    refs.eventIds.forEach((id) => eventIds.add(id));
    refs.packageIds.forEach((id) => packageIds.add(id));
  }
  return { photoIds, eventIds, packageIds };
}

/**
 * The photos and galleries an admin may reference: those of galleries they
 * may act on (owner, assigned, or a role that manages every gallery — the
 * rule of the admin gallery and photo routes), plus whatever the stored
 * site already uses, so a colleague can edit a page that shows a pick they
 * could not have made themselves.
 */
async function referencesAdminMay(admin, { photoIds = [], eventIds = [] }, stored) {
  const kept = stored || await storedReferences();
  // A photo in the trash is not offered for a new pick.
  const photoRows = photoIds.length ? await livePhotos(db).whereIn('id', photoIds).select('id', 'event_id') : [];
  const candidates = [...new Set([...eventIds, ...photoRows.map((p) => p.event_id)])];
  const events = candidates.length ? await db('events').whereIn('id', candidates) : [];
  const accessible = new Set(events.filter((e) => canAccessEvent(admin, e)).map((e) => e.id));
  const photoEvent = new Map(photoRows.map((p) => [p.id, p.event_id]));
  return {
    photoIds: new Set(photoIds.filter((id) => kept.photoIds.has(id) || accessible.has(photoEvent.get(id)))),
    eventIds: new Set(eventIds.filter((id) => kept.eventIds.has(id) || accessible.has(id))),
  };
}

function revisionConflict() {
  return new AppError('The website was changed elsewhere. Reload to get the latest version.', 409, 'WEBSITE_REVISION_CONFLICT');
}

/**
 * What a document may reference, for this admin, against what the stored
 * site (`stored`, storedReferences) already uses. Throws the first refusal.
 */
async function assertReferencesAllowed(admin, refs, stored) {
  const allowed = await referencesAdminMay(admin, refs, stored);
  const refused = [
    ...refs.photoIds.filter((id) => !allowed.photoIds.has(id)).map((id) => ({ code: 'PHOTO_NOT_ACCESSIBLE', photoId: id })),
    ...refs.eventIds.filter((id) => !allowed.eventIds.has(id)).map((id) => ({ code: 'GALLERY_NOT_ACCESSIBLE', eventId: id })),
  ];
  if (refused.length) throw refusal('The page uses photos or galleries you cannot access', 422, 'WEBSITE_REFERENCE_NOT_ACCESSIBLE', refused);
  // A new pick comes from a gallery that is on the website now, for its
  // owner too: they put the gallery on first, then pick. Picks already
  // stored stay when their gallery goes off (the page leaves them out).
  const newPhotoIds = refs.photoIds.filter((id) => !stored.photoIds.has(id));
  const newEventIds = refs.eventIds.filter((id) => !stored.eventIds.has(id));
  const pickedFrom = newPhotoIds.length ? await livePhotos(db).whereIn('id', newPhotoIds).pluck('event_id') : [];
  const sourceIds = [...new Set([...pickedFrom, ...newEventIds])];
  const sources = sourceIds.length ? await db('events').whereIn('id', sourceIds) : [];
  const off = sources.filter((event) => !media.isEventWebsiteEligible(event));
  if (off.length) {
    throw refusal(`Put the gallery on the website first: ${off.map((event) => event.event_name).join(', ')}`, 409, 'WEBSITE_GALLERY_NOT_ON_WEBSITE',
      off.map((event) => ({ code: 'GALLERY_NOT_ON_WEBSITE', eventId: event.id, name: event.event_name, reason: media.eventIneligibleReason(event) })));
  }
  // Packages come from the quote catalogue (quotes.view). Without it an
  // admin keeps the ones the site has, and adds none: the public page would
  // show the catalogue to them by a guessed id.
  const newPackages = refs.packageIds.filter((id) => !stored.packageIds.has(id));
  if (newPackages.length && !(await userHasAllPermissions(admin.id, ['quotes.view']))) {
    throw refusal('Adding packages needs the permission to view quotes', 403, 'WEBSITE_PACKAGES_FORBIDDEN',
      newPackages.map((id) => ({ code: 'PACKAGE_NOT_ALLOWED', packageId: id })));
  }
}

async function saveDraft(rawDocument, expectedRevision, admin) {
  const adminId = admin.id;
  const { document, errors } = normalizeDocument(rawDocument, { reservedSlugs: await cmsSlugs() });
  if (errors.length) throw validationError(errors);
  await assertReferencesAllowed(admin, collectReferences(document), await storedReferences());
  const current = await ensureDraft(adminId);
  if (expectedRevision != null && Number(expectedRevision) !== Number(current.revision)) {
    throw revisionConflict();
  }
  const written = {
    state: 'draft',
    document: JSON.stringify(document),
    revision: Number(current.revision) + 1,
    updated_by: adminId,
    updated_at: new Date().toISOString(),
  };
  const updated = await db('website_documents')
    .where({ state: 'draft', revision: current.revision })
    .update({ document: written.document, revision: written.revision, updated_by: adminId, updated_at: written.updated_at });
  if (!updated) {
    throw revisionConflict();
  }
  return editorState(written, await readRow('published'));
}

/**
 * Copy the draft into the published row. One transaction: visitors see the
 * old site or the new one, never a mix. The draft is validated again, since
 * a cms page may have taken a slug since it was saved.
 */
/**
 * Publish the draft revision the editor last saved. `expectedRevision` is
 * required: without it a publish could go out with whatever another editor
 * saved since.
 */
async function publish(expectedRevision, adminId) {
  if (expectedRevision == null || !Number.isInteger(Number(expectedRevision))) {
    throw new AppError('Say which saved revision to publish', 400, 'WEBSITE_REVISION_REQUIRED');
  }
  const reserved = await cmsSlugs();
  const result = await db.transaction(async (trx) => {
    // On PostgreSQL the draft row is locked, so concurrent publishes (and a
    // save) wait for this one; SQLite serialises writers anyway.
    const draftQuery = trx('website_documents').where({ state: 'draft' });
    if (trx.client.config.client === 'pg') draftQuery.forUpdate();
    const draft = await draftQuery.first();
    if (!draft) throw new AppError('There is nothing to publish yet', 404, 'WEBSITE_NO_DRAFT');
    if (Number(expectedRevision) !== Number(draft.revision)) throw revisionConflict();
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
    if (!existing) {
      await trx('website_documents').insert({ state: 'published', ...values });
    } else {
      // Never put an older revision over a newer published one.
      const written = await trx('website_documents')
        .where({ state: 'published' })
        .where('revision', '<=', draft.revision)
        .update(values);
      if (!written) throw revisionConflict();
    }
    return { draft, published: { state: 'published', ...values } };
  });
  clearWebsiteCache();
  return editorState(result.draft, result.published);
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
 * A package as a quote would take it (quoteTemplateService.packageLine), or
 * why it cannot be offered: archived, empty, or holding an archived item.
 * Its rule, not a copy: what a quote refuses, the website does not advertise.
 */
function packageOffer(pkg) {
  const { packageLine } = require('../quoteTemplateService');
  try {
    const line = packageLine(pkg, false);
    // One item: the package line carries the price; several: each child does.
    return { lines: pkg.items.length === 1 ? [line] : line.children, unavailable: null };
  } catch (err) {
    const reasons = { TEMPLATE_ITEM_ARCHIVED: 'archived_items', TEMPLATE_PACKAGE_EMPTY: 'empty', TEMPLATE_PACKAGE_ARCHIVED: 'archived' };
    if (err instanceof AppError && reasons[err.code]) return { lines: [], unavailable: reasons[err.code] };
    throw err;
  }
}

/**
 * Catalogue packages for the pricing block, priced as a quote from the
 * package would be: packageLine's lines (fixed price, or the item's pinned
 * hour/day rate), an 'auto' rate from the studio's default rates. A package
 * a quote could not be made from is left out; one with an item that has no
 * rate at all gets no price rather than a sum that leaves the item out.
 */
async function loadPackages(ids) {
  if (!ids.length || !(await isFeatureEnabled('quotes'))) return new Map();
  const { listPackages } = require('../quoteCatalogService');
  const rateResolver = require('../rateResolver');
  const [packages, rates] = await Promise.all([listPackages({ activeOnly: true, ids }), rateResolver.loadRates(null)]);
  const out = new Map();
  for (const pkg of packages) {
    const { lines, unavailable } = packageOffer(pkg);
    if (unavailable) continue;
    let totalMinor = 0;
    for (const line of lines) {
      let unit = line.unitPriceMinor;
      if (line.rateSource === 'auto') {
        const rate = rateResolver.pickRate(rates, line.priceMode);
        unit = rate ? rate.rateMinor : null;
      }
      totalMinor = unit == null || totalMinor == null ? null : totalMinor + Math.round(Number(unit) * Number(line.quantity));
    }
    out.set(pkg.id, {
      name: pkg.name,
      description: pkg.description || '',
      currency: pkg.currency,
      totalMinor,
      items: pkg.items.map((item) => item.preset_name).filter(Boolean),
    });
  }
  return out;
}

async function bookingState() {
  if (!(await isFeatureEnabled('calendarBooking'))) return { enabled: false };
  const { bookableServices } = require('../bookingService');
  const services = await bookableServices();
  return { enabled: services.length > 0, url: '/book', serviceIds: new Set(services.map((s) => s.id)) };
}

/** What the booking block's form says: on or off, and the services it can preselect. */
async function bookingOptions() {
  const flagOn = await isFeatureEnabled('calendarBooking');
  const { bookableServices } = require('../bookingService');
  const services = flagOn ? await bookableServices() : [];
  return { flagOn, services: services.map((s) => ({ id: s.id, name: s.name })) };
}

/**
 * The external address a legal CMS page leads to in place of its own text
 * (http or https, as the CMS accepts), or ''. The page redirects there and
 * every link to the page goes there, by this one rule.
 */
function externalLegalUrl(row) {
  const { safeUrl } = require('./document');
  return flag(row.use_external_url) && /^https?:\/\//i.test(row.external_url || '') ? safeUrl(row.external_url) : '';
}

/**
 * The legal pages: `pages` by slug, each with its name and address (its
 * external address when it has one), for a menu item or a link to it;
 * `footer`, the ones shown in the footer, in their order.
 */
async function legalPages(locale) {
  const rows = await db('cms_pages').whereIn('slug', LEGAL_SLUGS);
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  const pages = {};
  const footer = [];
  for (const slug of LEGAL_SLUGS) {
    const row = bySlug.get(slug);
    if (!row) continue;
    pages[slug] = { href: externalLegalUrl(row) || `/${slug}`, label: (locale === 'de' ? row.title_de : row.title_en) || legalPageName(locale, slug) };
    if (flag(row.show_in_footer)) footer.push(pages[slug]);
  }
  return { pages, footer };
}

function robotsDirective(seo) {
  const directives = [];
  if (!flag(seo.seo_allow_indexing) || flag(seo.seo_meta_noindex)) directives.push('noindex');
  if (flag(seo.seo_meta_nofollow)) directives.push('nofollow');
  if (flag(seo.seo_meta_noai)) directives.push('noai', 'noimageai');
  return directives.join(', ');
}

/**
 * Everything the renderer needs for one page of `document`. `preview` marks
 * the editor's render: block ids on the sections, the contact form disabled.
 */
async function buildContext(document, page, {
  preview = false, allowed = null, packages: withPackages = true, views = true,
} = {}) {
  // Only this page's media: the other pages lend the menu and the footer
  // their titles, nothing else.
  const refs = collectReferences({ pages: [page] });
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
    media.loadEligiblePhotos(refs.photoIds, { views }),
    media.loadAssets(refs.assetIds),
    media.loadEligibleEvents(refs.eventIds),
    withPackages ? loadPackages(refs.packageIds) : new Map(),
    bookingState(),
    legalPages(locale),
    getFrontendBaseUrl().catch(() => ''),
  ]);
  // The live contact forms show the spam check; the preview never loads it.
  const active = preview ? null : await require('./contactSettings').activeCaptcha();
  const captcha = active && !active.unusable ? { provider: active.provider, siteKey: active.siteKey, endpoint: active.endpoint } : null;
  const covers = await media.loadCoverPhotos([...events.values()], { views });
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
    legalLinks: legal.footer,
    legalPages: legal.pages,
    captcha,
    baseUrl: baseUrl || '',
    robots: preview ? 'noindex' : robotsDirective(settings),
    // The document's own limit: a stylesheet it accepted renders whole.
    customCss: sanitizeCss(document.customCss || '', { maxLength: MAX_CUSTOM_CSS }),
    sanitizeCustomHtml,
  };
}

async function renderPreview(rawDocument, pageId, admin, { videoAsPoster = false } = {}) {
  const { document } = normalizeDocument(rawDocument);
  const page = document.pages.find((p) => p.id === pageId) || document.pages[0];
  if (!page) throw new AppError('The website has no pages', 422, 'WEBSITE_INVALID');
  const allowed = await referencesAdminMay(admin, collectReferences({ pages: [page] }));
  // The catalogue's details are the quotes' (quotes.view, as the catalogue
  // itself): without it the preview leaves the packages out.
  const packages = await userHasAllPermissions(admin.id, ['quotes.view']);
  return renderPage({ ...(await buildContext(document, page, { preview: true, allowed, packages })), videoAsPoster });
}

// ---------------------------------------------------------------------------
// Public site
// ---------------------------------------------------------------------------

async function publishedDocument() {
  const row = await readRow('published');
  const raw = parseDocument(row);
  return raw ? normalizeDocument(raw).document : null;
}

/**
 * The gallery photos the published website shows. Only these have a working
 * public URL (/site-media). Taken from rendering each visible page, so it is
 * exactly what the pages show (a minimal hero's image, a testimonial without
 * a quote: not shown, not in it) and cannot drift from the renderer. Needs
 * no watermark settings: ids only. Cached with the pages, so a publish or an
 * opt-out (both clear the cache) changes it at once.
 */
async function publishedPhotoIds() {
  const generation = cacheGeneration();
  const cached = getCached('published-photos');
  if (cached !== undefined) return cached;
  const document = await publishedDocument();
  const ids = new Set();
  for (const page of document ? document.pages.filter((p) => !p.hidden) : []) {
    // eslint-disable-next-line no-await-in-loop -- a handful of pages, once per publish
    const shown = renderedImages(await buildContext(document, page, { views: false }));
    shown.filter((ref) => ref.source === 'photo').forEach((ref) => ids.add(ref.id));
  }
  setCached('published-photos', ids, generation);
  return ids;
}

/**
 * The X-Robots-Tag of the website's images: the pages' no-AI setting
 * (seo_meta_noai, as robotsDirective puts it in their meta), or null.
 */
async function mediaRobotsTag() {
  const generation = cacheGeneration();
  const cached = getCached('media-robots');
  if (cached !== undefined) return cached;
  const settings = await readSettings(['seo_meta_noai']);
  const tag = flag(settings.seo_meta_noai) ? 'noai, noimageai' : null;
  setCached('media-robots', tag, generation);
  return tag;
}

/** Flag on, public site on, something published: the builder owns `/`. */
async function isWebsiteActive() {
  if (!(await isFeatureEnabled(FLAG))) return false;
  const settings = await readSettings(['general_public_site_enabled']);
  if (!flag(settings.general_public_site_enabled)) return false;
  return !!(await db('website_documents').where({ state: 'published' }).first('id'));
}

/**
 * The public answer for a path: `slug` is '' for `/`. Returns null when the
 * builder does not own the path (inactive, unknown or hidden page), so the
 * caller falls through exactly as before.
 */
async function resolvePublicPage(slug) {
  const generation = cacheGeneration();
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
    // The home page's own address leads to /. Temporary: which page is home
    // can change, and a stored permanent redirect would outlive that.
    if (page && page.isHome) result = { status: 302, location: '/' };
    else if (page) result = { status: 200, page };
  }
  if (result && result.status === 200) {
    const ctx = await buildContext(document, result.page);
    // The captcha's origins are allowed only where its form is (server.js).
    const captcha = ctx.captcha && result.page.blocks.some((b) => b.type === 'contact') ? ctx.captcha.provider : null;
    result = withEtag(renderPage(ctx), { captcha });
  } else if (!result && slug) {
    // A legal page, or the not-found page for any other address, in the
    // website's design while the website is live (the app shows them otherwise).
    result = LEGAL_SLUGS.includes(slug) ? await systemPage(document, slug) : await notFoundPage(document, generation);
  }
  // Misses are cached too, so a crawler walking random slugs costs one
  // lookup per slug and TTL, not a document parse per request.
  setCached(key, result, generation);
  return result;
}

function withEtag(html, extra = {}) {
  return { status: 200, html, etag: `W/"${crypto.createHash('sha1').update(html).digest('hex')}"`, noindex: /name="robots" content="[^"]*noindex/.test(html), ...extra };
}

/**
 * A CMS page (legal or not-found) rendered in the website's header, footer
 * and fonts. Null when the CMS has no such page; an external address the
 * page points to is a redirect, as in the app.
 */
async function systemPage(document, slug, { notFound = false } = {}) {
  const row = await db('cms_pages').where({ slug }).first();
  if (!row) return null;
  const external = notFound ? '' : externalLegalUrl(row);
  if (external) return { status: 302, location: external };
  const ctx = await buildContext(document, { id: `system-${slug}`, slug, title: '', navLabel: '', blocks: [], seo: { title: '', description: '', image: null } });
  const de = ctx.locale === 'de';
  ctx.page.title = (de ? row.title_de : row.title_en) || row.title_en || row.title_de || slug;
  if (notFound) ctx.robots = 'noindex';
  const content = sanitizeCmsHtml((de ? row.content_de : row.content_en) || row.content_en || '');
  // The not-found page is a real 404 (nginx passes it through, nginx.conf).
  return withEtag(renderSystemPage(ctx, { content, notFound }), { system: true, ...(notFound ? { notFound: true, status: 404 } : {}) });
}

// One rendering of the not-found page for every unknown address.
async function notFoundPage(document, generation) {
  const cached = getCached('system:not-found');
  if (cached !== undefined) return cached;
  const result = await systemPage(document, 'not-found', { notFound: true });
  setCached('system:not-found', result, generation);
  return result;
}

function xmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** sitemap.xml of the published pages; null while the builder is inactive. */
async function sitemapXml() {
  const generation = cacheGeneration();
  if (!(await isWebsiteActive())) return null;
  const cached = getCached('sitemap');
  if (cached !== undefined) return cached;
  const document = await publishedDocument();
  const base = await getFrontendBaseUrl().catch(() => '');
  const settings = await readSettings(['seo_allow_indexing']);
  // Sitemap entries must be absolute; without a known public origin, or with
  // indexing off, the sitemap is empty rather than pointing at a guess.
  const pages = base && flag(settings.seo_allow_indexing) ? document.pages.filter((p) => !p.hidden) : [];
  const urls = pages.map((p) => `<url><loc>${xmlEscape(`${base}${pageHref(p)}`)}</loc></url>`).join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>\n`;
  setCached('sitemap', xml, generation);
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
  getEditorState,
  saveDraft,
  publish,
  renderPreview,
  resolvePublicPage,
  isWebsiteActive,
  publishedPhotoIds,
  legacyLandingNotice,
  setSiteVisible,
  bookingOptions,
  dismissLegacyLandingNotice,
  mediaRobotsTag,
  sitemapXml,
  publishedDocument,
  setGalleryOnWebsite,
  buildContext,
  referencesAdminMay,
  packageOffer,
  _internal: { initialDocument, importRefusal, loadPackages },
};
