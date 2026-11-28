/**
 * The public side of the website (issue 2618): whether it is live, the
 * answer for a path (a page, a legal page, the not-found page), the photos
 * the published pages show, and the sitemap.
 *
 * The site root switches to the builder only when all three hold: the
 * `websiteBuilder` flag is on, the public site is enabled, and something has
 * been published. Until then `/` is the single-page public site, untouched.
 */
const crypto = require('crypto');
const { db } = require('../../database/db');
const { getAppSettings } = require('../../utils/appSettings');
const { isFeatureEnabled } = require('../../middleware/requireFeatureFlag');
const { getFrontendBaseUrl } = require('../../utils/frontendUrl');
const { normalizeDocument, LEGAL_SLUGS } = require('./document');
const { renderPage, renderSystemPage, renderedImages, pageHref } = require('./renderer');
const { sanitizeCmsHtml } = require('./richText');
const { flag } = require('./validators');
const { cacheGeneration, getCached, setCached } = require('./cache');
const { parseDocument, readRow } = require('./rows');
const { buildContext, externalLegalUrl } = require('./context');

const FLAG = 'websiteBuilder';

async function publishedDocument() {
  const row = await readRow('published');
  const raw = parseDocument(row);
  return raw ? normalizeDocument(raw).document : null;
}

let photoIdsInFlight = null;

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
  // A page's images are requested together: after a publish or an expiry
  // they share one computation instead of each rendering every page.
  if (photoIdsInFlight && photoIdsInFlight.generation === generation) return photoIdsInFlight.promise;
  const promise = computePublishedPhotoIds()
    .then((ids) => {
      setCached('published-photos', ids, generation);
      return ids;
    })
    .finally(() => {
      if (photoIdsInFlight && photoIdsInFlight.promise === promise) photoIdsInFlight = null;
    });
  photoIdsInFlight = { generation, promise };
  return promise;
}

async function computePublishedPhotoIds() {
  const document = await publishedDocument();
  const ids = new Set();
  for (const page of document ? document.pages.filter((p) => !p.hidden) : []) {
    // eslint-disable-next-line no-await-in-loop -- a handful of pages, once per publish
    const shown = renderedImages(await buildContext(document, page, { views: false }));
    shown.filter((ref) => ref.source === 'photo').forEach((ref) => ids.add(ref.id));
  }
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
  const settings = await getAppSettings(['seo_meta_noai']);
  const tag = flag(settings.seo_meta_noai) ? 'noai, noimageai' : null;
  setCached('media-robots', tag, generation);
  return tag;
}

/** Flag on, public site on, something published: the builder owns `/`. */
async function isWebsiteActive() {
  if (!(await isFeatureEnabled(FLAG))) return false;
  const settings = await getAppSettings(['general_public_site_enabled']);
  if (!flag(settings.general_public_site_enabled)) return false;
  return !!(await db('website_documents').where({ state: 'published' }).first('id'));
}

/**
 * The public answer for a path: `slug` is '' for `/`. Returns null when the
 * builder does not own the path (inactive, unknown or hidden page): the
 * caller then hands the path to the app.
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
  const settings = await getAppSettings(['seo_allow_indexing']);
  // Sitemap entries must be absolute; without a known public origin, or with
  // indexing off, the sitemap is empty rather than pointing at a guess.
  const pages = base && flag(settings.seo_allow_indexing) ? document.pages.filter((p) => !p.hidden) : [];
  const urls = pages.map((p) => `<url><loc>${xmlEscape(`${base}${pageHref(p)}`)}</loc></url>`).join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>\n`;
  setCached('sitemap', xml, generation);
  return xml;
}

module.exports = { FLAG, publishedDocument, publishedPhotoIds, mediaRobotsTag, isWebsiteActive, resolvePublicPage, sitemapXml };
