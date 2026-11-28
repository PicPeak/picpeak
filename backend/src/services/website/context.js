/**
 * What a page is rendered with (issue 2618): the theme from the branding and
 * the document, the packages, galleries and photos it shows, whether booking
 * is on, the legal pages, the SEO settings. The preview and the public pages
 * build the same context.
 */
const { db } = require('../../database/db');
const { getAppSettings, parseSettingValue } = require('../../utils/appSettings');
const { AppError } = require('../../utils/errors');
const { isFeatureEnabled } = require('../../middleware/requireFeatureFlag');
const { getFrontendBaseUrl } = require('../../utils/frontendUrl');
const { listFonts } = require('../fontsService');
const { bookableServices } = require('../bookingService');
const publicSite = require('../publicSiteService');
const { collectReferences, MAX_CUSTOM_CSS, LEGAL_SLUGS } = require('./document');
const media = require('./media');
const { legalPageName } = require('./renderer');
const { FONT_NAME_PATTERN, flag, safeUrl } = require('./validators');

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
  const byName = new Map(fonts.filter((f) => FONT_NAME_PATTERN.test(f.family)).map((f) => [f.family.toLowerCase(), f]));
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

/** What the booking block's form says: on or off, and the services it can preselect. */
async function bookingOptions() {
  const flagOn = await isFeatureEnabled('calendarBooking');
  const services = flagOn ? await bookableServices() : [];
  return { flagOn, services: services.map((s) => ({ id: s.id, name: s.name })) };
}

// The same for a page: a booking block shows while something can be booked.
async function bookingState() {
  const { flagOn, services } = await bookingOptions();
  if (!flagOn) return { enabled: false };
  return { enabled: services.length > 0, url: '/book', serviceIds: new Set(services.map((s) => s.id)) };
}

/**
 * The external address a legal CMS page leads to in place of its own text
 * (http or https, as the CMS accepts), or ''. The page redirects there and
 * every link to the page goes there, by this one rule.
 */
function externalLegalUrl(row) {
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
  const settings = await getAppSettings([
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

module.exports = { buildContext, bookingOptions, packageOffer, loadPackages, externalLegalUrl };
