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
const { sanitizeCssColor } = require('../../utils/cssSanitizer');

const DOCUMENT_VERSION = 1;
const MAX_PAGES = 30;
const MAX_BLOCKS = 60;
const MAX_IMAGES = 60;
const MAX_ITEMS = 24;
const MAX_DOCUMENT_BYTES = 1024 * 1024;
const MAX_CUSTOM_HTML = 100 * 1024;
const MAX_CUSTOM_CSS = 100 * 1024;

// Single-segment paths the SPA, nginx or the backend already own. A website
// page under one of these would either never be reached or shadow a real
// route (frontend/src/App.tsx, frontend/nginx.conf, backend/server.js).
const RESERVED_SLUGS = new Set([
  'admin', 'agb', 'api', 'app', 'assets', 'book', 'code', 'contract', 'customer',
  'datenschutz', 'favicon', 'fonts', 'gallery', 'health', 'impressum', 'index',
  'invite', 'login', 'logout', 'not-found', 'og', 'payment-check', 'photo-checkout',
  'photos', 'purchased-downloads', 'quote', 'robots', 's', 'setup', 'site-media',
  'sitemap', 'static', 'thumbnails', 'transfer', 'transfer-upload', 'uploads',
]);
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG_LENGTH = 60;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
const ASSET_ID_PATTERN = /^[a-f0-9]{24}$/;

const BACKGROUNDS = ['default', 'light', 'dark'];
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
  customHtml: ['default'],
};
const BLOCK_TYPES = Object.keys(BLOCK_VARIANTS);

function str(value, max) {
  if (typeof value !== 'string') return '';
  // Control characters other than tab/newline have no place in page text.
  // eslint-disable-next-line no-control-regex -- intentional: strips control chars from admin input
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
}

function bool(value) {
  return value === true;
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
  const alt = str(value.alt, 300);
  if (value.source === 'photo') {
    const id = Number(value.id);
    return Number.isInteger(id) && id > 0 ? { source: 'photo', id, alt } : null;
  }
  if (value.source === 'asset') {
    return typeof value.id === 'string' && ASSET_ID_PATTERN.test(value.id) ? { source: 'asset', id: value.id, alt } : null;
  }
  return null;
}

function imageList(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_IMAGES).map(imageRef).filter(Boolean);
}

function idList(value, max = MAX_ITEMS) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const raw of value) {
    const id = Number(raw);
    if (Number.isInteger(id) && id > 0 && !out.includes(id)) out.push(id);
    if (out.length >= max) break;
  }
  return out;
}

function videoRef(value) {
  if (!value || typeof value !== 'object') return null;
  return typeof value.id === 'string' && ASSET_ID_PATTERN.test(value.id) ? { source: 'asset', id: value.id } : null;
}

const BLOCK_FIELDS = {
  hero: (b) => ({
    heading: str(b.heading, 200),
    subheading: str(b.subheading, 600),
    buttonLabel: str(b.buttonLabel, 60),
    buttonUrl: safeUrl(b.buttonUrl),
    image: imageRef(b.image),
    video: videoRef(b.video),
  }),
  text: (b) => ({
    heading: str(b.heading, 200),
    body: str(b.body, 10000),
  }),
  imageText: (b) => ({
    heading: str(b.heading, 200),
    body: str(b.body, 5000),
    image: imageRef(b.image),
    buttonLabel: str(b.buttonLabel, 60),
    buttonUrl: safeUrl(b.buttonUrl),
  }),
  gallery: (b) => ({
    heading: str(b.heading, 200),
    images: imageList(b.images),
    columns: intInRange(b.columns, 2, 4, 3),
  }),
  featuredGalleries: (b) => ({
    heading: str(b.heading, 200),
    intro: str(b.intro, 1000),
    galleries: Array.isArray(b.galleries)
      ? b.galleries.slice(0, MAX_ITEMS).map((g) => {
        const id = Number(g && g.id);
        return Number.isInteger(id) && id > 0 ? { id, text: str(g.text, 400) } : null;
      }).filter(Boolean)
      : [],
  }),
  testimonials: (b) => ({
    heading: str(b.heading, 200),
    items: Array.isArray(b.items)
      ? b.items.slice(0, MAX_ITEMS).map((item) => (item && typeof item === 'object' ? {
        quote: str(item.quote, 1200),
        author: str(item.author, 120),
        role: str(item.role, 120),
        image: imageRef(item.image),
      } : null)).filter((item) => item && item.quote)
      : [],
  }),
  pricing: (b) => ({
    heading: str(b.heading, 200),
    intro: str(b.intro, 1000),
    packageIds: idList(b.packageIds, 12),
    showPrices: b.showPrices !== false,
    buttonLabel: str(b.buttonLabel, 60),
    buttonUrl: safeUrl(b.buttonUrl),
  }),
  contact: (b) => ({
    heading: str(b.heading, 200),
    intro: str(b.intro, 1000),
    showPhone: bool(b.showPhone),
    showDate: bool(b.showDate),
    submitLabel: str(b.submitLabel, 60),
    successMessage: str(b.successMessage, 300),
  }),
  booking: (b) => ({
    heading: str(b.heading, 200),
    text: str(b.text, 1000),
    buttonLabel: str(b.buttonLabel, 60),
  }),
  instagram: (b) => ({
    heading: str(b.heading, 200),
    handle: str(b.handle, 60).replace(/^@/, '').replace(/[^A-Za-z0-9._]/g, ''),
    profileUrl: safeUrl(b.profileUrl),
    images: imageList(b.images).slice(0, 12),
  }),
  spacer: (b) => ({
    divider: bool(b.divider),
  }),
  customHtml: (b) => ({
    html: typeof b.html === 'string' ? b.html.slice(0, MAX_CUSTOM_HTML) : '',
  }),
};

function normalizeBlock(raw) {
  if (!raw || typeof raw !== 'object' || !BLOCK_TYPES.includes(raw.type)) return null;
  const variants = BLOCK_VARIANTS[raw.type];
  return {
    id: blockId(raw.id),
    type: raw.type,
    variant: pick(raw.variant, variants, variants[0]),
    background: pick(raw.background, BACKGROUNDS, 'default'),
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
  const input = raw && typeof raw === 'object' ? raw : {};
  const extraReserved = new Set(reservedSlugs.map((s) => String(s).toLowerCase()));
  const seenSlugs = new Set();
  const seenIds = new Set();

  const pages = (Array.isArray(input.pages) ? input.pages : []).slice(0, MAX_PAGES).map((page, index) => {
    const p = page && typeof page === 'object' ? page : {};
    let id = blockId(p.id);
    while (seenIds.has(id)) id = newId();
    seenIds.add(id);
    const title = str(p.title, 120) || `Page ${index + 1}`;
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
    const blocks = (Array.isArray(p.blocks) ? p.blocks : []).slice(0, MAX_BLOCKS).map(normalizeBlock).filter(Boolean)
      .map((block) => {
        while (blockIds.has(block.id)) block.id = newId();
        blockIds.add(block.id);
        return block;
      });
    const seo = p.seo && typeof p.seo === 'object' ? p.seo : {};
    return {
      id,
      slug,
      title,
      navLabel: str(p.navLabel, 60),
      hidden: bool(p.hidden),
      inNav: p.inNav !== false,
      isHome: bool(p.isHome),
      seo: {
        title: str(seo.title, 120),
        description: str(seo.description, 300),
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

  const document = {
    version: DOCUMENT_VERSION,
    pages,
    theme: normalizeTheme(input.theme),
    customCss: typeof input.customCss === 'string' ? input.customCss.slice(0, MAX_CUSTOM_CSS) : '',
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

module.exports = {
  DOCUMENT_VERSION,
  BLOCK_TYPES,
  BLOCK_VARIANTS,
  RESERVED_SLUGS,
  normalizeDocument,
  normalizeBlock,
  normalizeSlug,
  isValidSlug,
  safeUrl,
  collectReferences,
  newPageId: newId,
};
