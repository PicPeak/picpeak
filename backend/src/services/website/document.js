/**
 * The website builder's document (issue 2618): validation and normalisation.
 *
 * The whole public website is one JSON document. Everything the admin sends
 * goes through normalizeDocument() before it is stored, and the renderer
 * normalises the stored document again before it renders, so a row written by
 * an older version (or by hand) can never carry a field the renderer would
 * trust. Unknown block types and fields are dropped, strings are capped, and
 * links are reduced to the schemes a public page may point at.
 */
const crypto = require('crypto');
const { sanitizeCssColor, MAX_CSS_SIZE } = require('../../utils/cssSanitizer');
const { DEFAULT_PUBLIC_SITE_CSS, DEFAULT_PUBLIC_SITE_HTML } = require('../../constants/publicSiteDefaults');
const { parseBooleanInput } = require('../../utils/parsers');

const DOCUMENT_VERSION = 1;
const MAX_PAGES = 30;
const MAX_BLOCKS = 60;
const MAX_IMAGES = 60;
const MAX_ITEMS = 24;
const MAX_DOCUMENT_BYTES = 1024 * 1024;
const MAX_CUSTOM_HTML = 100 * 1024;
// The site stylesheet takes the largest one the settings page accepts for
// the single-page site (sanitizeCss's MAX_CSS_SIZE) plus the template's base
// stylesheet, which the import puts in front of it; so an imported landing
// page is never cut.
const MAX_CUSTOM_CSS = MAX_CSS_SIZE + DEFAULT_PUBLIC_SITE_CSS.length + 2;

// Single-segment paths the SPA, nginx or the backend already own. A website
// page under one of these would either never be reached or shadow a real
// route (frontend/src/App.tsx, frontend/nginx.conf, backend/server.js). The
// list is shared: nginx.conf and the frontend page editor keep copies that
// __tests__/services/websiteReservedSlugs.test.js holds to this file.
const RESERVED_SLUGS = new Set(require('./reservedSlugs.json'));
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG_LENGTH = 60;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
const ASSET_ID_PATTERN = /^[a-f0-9]{24}$/;

const BACKGROUNDS = ['default', 'light', 'dark', 'custom'];
// A custom block background: an opaque hex colour, the only shape that is
// both safe in a style attribute and has a contrast to compute.
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const BUTTON_STYLES = ['solid', 'outline', 'pill'];
const FONT_NAME_PATTERN = /^[A-Za-z0-9 ]{1,60}$/;

const BLOCK_VARIANTS = {
  hero: ['overlay', 'split', 'minimal'],
  text: ['left', 'center', 'columns'],
  imageText: ['image-left', 'image-right'],
  gallery: ['grid', 'masonry'],
  featuredGalleries: ['cards', 'list'],
  testimonials: ['cards', 'quote'],
  pricing: ['cards', 'list'],
  contact: ['simple', 'split'],
  booking: ['button', 'banner'],
  instagram: ['strip', 'grid'],
  spacer: ['small', 'medium', 'large'],
  divider: ['thin', 'medium'],
  customHtml: ['default'],
};
const BLOCK_TYPES = Object.keys(BLOCK_VARIANTS);

// Problems found while normalising, with the page and block they are in.
// Set by normalizeDocument for the length of one synchronous call; a limit
// that is exceeded is reported here (so a save is refused) and still capped
// (so a stored document always renders).
let sink = null;
let where = {};
function report(problem) {
  if (sink) sink.push({ ...where, ...problem });
}

function str(value, max, field) {
  if (typeof value !== 'string') return '';
  // Control characters other than tab/newline have no place in page text.
  // eslint-disable-next-line no-control-regex -- intentional: strips control chars from admin input
  const cleaned = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (cleaned.length > max) report({ code: 'TEXT_TOO_LONG', field, max });
  return cleaned.slice(0, max);
}

function capText(value, max, field) {
  if (value.length > max) report({ code: 'TEXT_TOO_LONG', field, max });
  return value.slice(0, max);
}

function capped(list, max, field) {
  if (list.length > max) report({ code: 'TOO_MANY_ITEMS', field, max });
  return list.slice(0, max);
}

// A flag as the editor sends it, or as a string someone else sent: "false"
// and "0" are off, never a truthy string.
function bool(value, fallback = false) {
  return parseBooleanInput(value, fallback);
}

function pick(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function intInRange(value, min, max, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/**
 * A link a visitor may follow: http(s), mailto, tel, a same-site path or an
 * anchor. Anything else (javascript:, data:, protocol-relative `//host`,
 * backslash tricks) becomes '' so the renderer leaves the link out.
 */
function safeUrl(value) {
  const url = str(value, 500);
  if (!url) return '';
  // Phone numbers are written with spaces; the link takes them out.
  if (/^tel:/i.test(url)) return /^tel:\+?[0-9 ()./-]{3,40}$/i.test(url) ? url.replace(/\s+/g, '') : '';
  // eslint-disable-next-line no-control-regex -- whitespace or control chars inside a URL are never legitimate here
  if (/[\s\u0000-\u001F\u007F\\]/.test(url)) return '';
  if (url.startsWith('#')) return /^#[A-Za-z0-9_-]{0,80}$/.test(url) ? url : '';
  if (url.startsWith('/')) return url.startsWith('//') ? '' : url;
  const scheme = url.match(/^([a-z][a-z0-9+.-]*):/i);
  if (!scheme) return '';
  const name = scheme[1].toLowerCase();
  if (name === 'http' || name === 'https') {
    try {
      const parsed = new URL(url);
      return parsed.hostname ? url : '';
    } catch {
      return '';
    }
  }
  if (name === 'mailto') return url;
  return '';
}

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

function blockId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value) ? value : newId();
}

function imageRef(value) {
  if (!value || typeof value !== 'object') return null;
  const alt = str(value.alt, 300, 'alt');
  if (value.source === 'photo') {
    const id = Number(value.id);
    return Number.isInteger(id) && id > 0 ? { source: 'photo', id, alt } : null;
  }
  if (value.source === 'asset') {
    return typeof value.id === 'string' && ASSET_ID_PATTERN.test(value.id) ? { source: 'asset', id: value.id, alt } : null;
  }
  return null;
}

function imageList(value, max = MAX_IMAGES) {
  if (!Array.isArray(value)) return [];
  return capped(value, max, 'images').map(imageRef).filter(Boolean);
}

function idList(value, max, field) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const raw of value) {
    const id = Number(raw);
    if (Number.isInteger(id) && id > 0 && !out.includes(id)) out.push(id);
  }
  return capped(out, max, field);
}

function videoRef(value) {
  if (!value || typeof value !== 'object') return null;
  return typeof value.id === 'string' && ASSET_ID_PATTERN.test(value.id) ? { source: 'asset', id: value.id } : null;
}

const BLOCK_FIELDS = {
  hero: (b) => ({
    heading: str(b.heading, 200, 'heading'),
    subheading: str(b.subheading, 600, 'subheading'),
    buttonLabel: str(b.buttonLabel, 60, 'buttonLabel'),
    buttonUrl: safeUrl(b.buttonUrl),
    image: imageRef(b.image),
    video: videoRef(b.video),
  }),
  text: (b) => ({
    heading: str(b.heading, 200, 'heading'),
    body: str(b.body, 10000, 'body'),
  }),
  imageText: (b) => ({
    heading: str(b.heading, 200, 'heading'),
    body: str(b.body, 5000, 'body'),
    image: imageRef(b.image),
    buttonLabel: str(b.buttonLabel, 60, 'buttonLabel'),
    buttonUrl: safeUrl(b.buttonUrl),
  }),
  gallery: (b) => ({
    heading: str(b.heading, 200, 'heading'),
    images: imageList(b.images),
    columns: intInRange(b.columns, 2, 4, 3),
  }),
  featuredGalleries: (b) => ({
    heading: str(b.heading, 200, 'heading'),
    intro: str(b.intro, 1000, 'intro'),
    galleries: Array.isArray(b.galleries)
      ? capped(b.galleries, MAX_ITEMS, 'galleries').map((g) => {
        const id = Number(g && g.id);
        return Number.isInteger(id) && id > 0 ? { id, text: str(g.text, 400, 'text') } : null;
      }).filter(Boolean)
      : [],
  }),
  testimonials: (b) => ({
    heading: str(b.heading, 200, 'heading'),
    items: Array.isArray(b.items)
      ? capped(b.items, MAX_ITEMS, 'items').map((item) => (item && typeof item === 'object' ? {
        quote: str(item.quote, 1200, 'quote'),
        author: str(item.author, 120, 'author'),
        role: str(item.role, 120, 'role'),
        image: imageRef(item.image),
      } : null)).filter(Boolean)
      : [],
  }),
  pricing: (b) => ({
    heading: str(b.heading, 200, 'heading'),
    intro: str(b.intro, 1000, 'intro'),
    packageIds: idList(b.packageIds, 12, 'packageIds'),
    showPrices: bool(b.showPrices, true),
    buttonLabel: str(b.buttonLabel, 60, 'buttonLabel'),
    buttonUrl: safeUrl(b.buttonUrl),
  }),
  contact: (b) => ({
    heading: str(b.heading, 200, 'heading'),
    intro: str(b.intro, 1000, 'intro'),
    showPhone: bool(b.showPhone),
    showDate: bool(b.showDate),
    submitLabel: str(b.submitLabel, 60, 'submitLabel'),
    successMessage: str(b.successMessage, 300, 'successMessage'),
  }),
  booking: (b) => ({
    heading: str(b.heading, 200, 'heading'),
    text: str(b.text, 1000, 'text'),
    buttonLabel: str(b.buttonLabel, 60, 'buttonLabel'),
  }),
  instagram: (b) => ({
    heading: str(b.heading, 200, 'heading'),
    handle: str(b.handle, 60, 'handle').replace(/^@/, '').replace(/[^A-Za-z0-9._]/g, ''),
    profileUrl: safeUrl(b.profileUrl),
    images: imageList(b.images, 12),
  }),
  spacer: (b) => ({
    divider: bool(b.divider),
  }),
  divider: (b) => ({
    width: pick(b.width, ['full', 'short'], 'full'),
    spacing: pick(b.spacing, ['none', 'small', 'medium', 'large'], 'medium'),
  }),
  customHtml: (b) => ({
    html: typeof b.html === 'string' ? capText(b.html, MAX_CUSTOM_HTML, 'html') : '',
    // The imported single-page site: rendered in its old containers.
    ...(bool(b.legacy) ? { legacy: true } : {}),
  }),
};

const hex = (value) => (typeof value === 'string' && HEX_COLOR.test(value.trim()) ? value.trim().toLowerCase() : null);

/** page / light / dark, or a custom colour (text colour automatic unless set). */
function normalizeBackground(raw) {
  const background = pick(raw.background, BACKGROUNDS, 'default');
  if (background !== 'custom') return { background };
  const backgroundColor = hex(raw.backgroundColor);
  return backgroundColor ? { background, backgroundColor, textColor: hex(raw.textColor) } : { background: 'default' };
}

function normalizeBlock(raw) {
  if (!raw || typeof raw !== 'object' || !BLOCK_TYPES.includes(raw.type)) return null;
  const variants = BLOCK_VARIANTS[raw.type];
  return {
    id: blockId(raw.id),
    type: raw.type,
    variant: pick(raw.variant, variants, variants[0]),
    ...normalizeBackground(raw),
    ...BLOCK_FIELDS[raw.type](raw),
  };
}

function normalizeSlug(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');
}

function isValidSlug(slug) {
  return typeof slug === 'string' && slug.length > 0 && slug.length <= MAX_SLUG_LENGTH
    && SLUG_PATTERN.test(slug) && !RESERVED_SLUGS.has(slug);
}

function normalizeTheme(raw) {
  const theme = raw && typeof raw === 'object' ? raw : {};
  const font = (value) => (typeof value === 'string' && FONT_NAME_PATTERN.test(value.trim()) ? value.trim() : null);
  return {
    headingFont: font(theme.headingFont),
    bodyFont: font(theme.bodyFont),
    buttonStyle: BUTTON_STYLES.includes(theme.buttonStyle) ? theme.buttonStyle : null,
    accent: sanitizeCssColor(theme.accent),
    background: sanitizeCssColor(theme.background),
    text: sanitizeCssColor(theme.text),
  };
}

/**
 * Normalise a document. Returns { document, errors }: errors are the problems
 * an admin has to fix (duplicate or reserved slugs, no pages); everything
 * else is repaired silently (unknown fields dropped, strings capped).
 */
function normalizeDocument(raw, { reservedSlugs = [] } = {}) {
  const errors = [];
  sink = errors;
  try {
    return normalizeInto(raw, reservedSlugs, errors);
  } finally {
    sink = null;
    where = {};
  }
}

function capPages(list) {
  if (list.length > MAX_PAGES) report({ code: 'TOO_MANY_PAGES', max: MAX_PAGES });
  return list.slice(0, MAX_PAGES);
}

function normalizeInto(raw, reservedSlugs, errors) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const extraReserved = new Set(reservedSlugs.map((s) => String(s).toLowerCase()));
  const seenSlugs = new Set();
  const seenIds = new Set();

  const pages = capPages(Array.isArray(input.pages) ? input.pages : []).map((page, index) => {
    const p = page && typeof page === 'object' ? page : {};
    let id = blockId(p.id);
    while (seenIds.has(id)) id = newId();
    seenIds.add(id);
    where = { pageId: id };
    const title = str(p.title, 120, 'title') || `Page ${index + 1}`;
    const slug = normalizeSlug(typeof p.slug === 'string' && p.slug ? p.slug : title);
    if (!isValidSlug(slug)) {
      errors.push({ code: 'SLUG_RESERVED', pageId: id, slug });
    } else if (extraReserved.has(slug)) {
      errors.push({ code: 'SLUG_TAKEN_BY_CMS_PAGE', pageId: id, slug });
    } else if (seenSlugs.has(slug)) {
      errors.push({ code: 'SLUG_DUPLICATE', pageId: id, slug });
    }
    seenSlugs.add(slug);
    const blockIds = new Set();
    const rawBlocks = Array.isArray(p.blocks) ? p.blocks : [];
    if (rawBlocks.length > MAX_BLOCKS) report({ code: 'TOO_MANY_BLOCKS', max: MAX_BLOCKS });
    const blocks = rawBlocks.slice(0, MAX_BLOCKS).map((b) => {
      where = { pageId: id, blockId: b && typeof b.id === 'string' ? b.id : undefined };
      return normalizeBlock(b);
    }).filter(Boolean)
      .map((block) => {
        while (blockIds.has(block.id)) block.id = newId();
        blockIds.add(block.id);
        return block;
      });
    where = { pageId: id };
    const seo = p.seo && typeof p.seo === 'object' ? p.seo : {};
    return {
      id,
      slug,
      title,
      navLabel: str(p.navLabel, 60, 'navLabel'),
      hidden: bool(p.hidden),
      inNav: bool(p.inNav, true),
      isHome: bool(p.isHome),
      seo: {
        title: str(seo.title, 120, 'title'),
        description: str(seo.description, 300, 'description'),
        image: imageRef(seo.image),
      },
      blocks,
    };
  });

  if (pages.length === 0) errors.push({ code: 'NO_PAGES' });

  // Exactly one home page, and it is never hidden: `/` must always answer.
  const homeIndex = Math.max(0, pages.findIndex((p) => p.isHome && !p.hidden));
  pages.forEach((p, index) => { p.isHome = index === homeIndex; });
  if (pages[homeIndex]) pages[homeIndex].hidden = false;

  where = {};
  const document = {
    version: DOCUMENT_VERSION,
    pages,
    theme: normalizeTheme(input.theme),
    customCss: typeof input.customCss === 'string' ? capText(input.customCss, MAX_CUSTOM_CSS, 'customCss') : '',
  };

  if (Buffer.byteLength(JSON.stringify(document), 'utf8') > MAX_DOCUMENT_BYTES) {
    errors.push({ code: 'DOCUMENT_TOO_LARGE' });
  }

  return { document, errors };
}

/** Every image a document points at, by source, for one batched lookup. */
function collectReferences(document) {
  const photoIds = new Set();
  const assetIds = new Set();
  const eventIds = new Set();
  const packageIds = new Set();
  const addImage = (ref) => {
    if (!ref) return;
    if (ref.source === 'photo') photoIds.add(ref.id);
    else if (ref.source === 'asset') assetIds.add(ref.id);
  };
  for (const page of document.pages) {
    addImage(page.seo.image);
    for (const block of page.blocks) {
      addImage(block.image);
      if (block.video) assetIds.add(block.video.id);
      (block.images || []).forEach(addImage);
      (block.items || []).forEach((item) => addImage(item.image));
      (block.galleries || []).forEach((g) => eventIds.add(g.id));
      (block.packageIds || []).forEach((id) => packageIds.add(id));
    }
  }
  return {
    photoIds: [...photoIds], assetIds: [...assetIds], eventIds: [...eventIds], packageIds: [...packageIds],
  };
}

// Problems that mean "too much" rather than "wrong": a save is refused with
// 400, nothing is cut.
const LIMIT_CODES = new Set(['TOO_MANY_PAGES', 'TOO_MANY_BLOCKS', 'TOO_MANY_ITEMS', 'TEXT_TOO_LONG', 'DOCUMENT_TOO_LARGE']);

/**
 * The single-page landing page an install already has, as the website's
 * first draft. `used`: visitors see it (switched on), or someone edited its
 * HTML or CSS from what migration 043 seeds; an untouched template behind a
 * switched-off site is not theirs to keep. Its HTML becomes the home page's
 * one custom-HTML block (rendered in its old containers), its stylesheet,
 * with the template's base CSS it was written against, the site's custom
 * CSS. A page longer than a custom-HTML block holds is not cut short:
 * `refused` says why, and the page stays live until something is published.
 * Pure: the service and migration 381 both use it.
 */
function legacyImport({ enabled, html, css }) {
  const page = typeof html === 'string' ? html : '';
  const style = typeof css === 'string' ? css : '';
  const used = !!page.trim() && (enabled
    || page.trim() !== DEFAULT_PUBLIC_SITE_HTML.trim() || !!style.trim());
  if (!used) return { used: false };
  if (page.length > MAX_CUSTOM_HTML) return { used: true, refused: { length: page.length, max: MAX_CUSTOM_HTML } };
  return {
    used: true,
    document: {
      pages: [{ id: newId(), slug: 'home', title: 'Home', isHome: true, blocks: [{ type: 'customHtml', html: page, legacy: true }] }],
      customCss: `${DEFAULT_PUBLIC_SITE_CSS}\n\n${style}`.trim(),
    },
  };
}

module.exports = {
  DOCUMENT_VERSION,
  LIMIT_CODES,
  MAX_CUSTOM_HTML,
  MAX_CUSTOM_CSS,
  BLOCK_TYPES,
  BLOCK_VARIANTS,
  RESERVED_SLUGS,
  normalizeDocument,
  normalizeBlock,
  normalizeSlug,
  isValidSlug,
  safeUrl,
  collectReferences,
  legacyImport,
  newPageId: newId,
};
