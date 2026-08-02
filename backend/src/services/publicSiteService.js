const crypto = require('crypto');
const sanitizeHtml = require('sanitize-html');
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { sanitizeCss } = require('../utils/cssSanitizer');
const {
  DEFAULT_PUBLIC_SITE_TITLE,
  DEFAULT_PUBLIC_SITE_HTML,
  DEFAULT_PUBLIC_SITE_CSS,
} = require('../constants/publicSiteDefaults');

const CACHE_TTL_MS = Number(process.env.PUBLIC_SITE_CACHE_TTL_MS || 60_000);

let cachedPayload = null;
let cacheExpiresAt = 0;

const ALLOWED_HTML_TAGS = [
  'a', 'article', 'aside', 'blockquote', 'br', 'button', 'caption', 'div',
  'em', 'figure', 'figcaption', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hr', 'img', 'li', 'main', 'nav', 'ol', 'p', 'section', 'span',
  'strong', 'sup', 'sub', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr',
  'ul'
];

const COMMON_ATTRIBUTES = ['class', 'id', 'role', 'aria-label', 'aria-hidden'];

function parseSettingValue(value) {
  if (value === null || value === undefined) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    return value;
  }
}

async function fetchPublicSiteSettings() {
  const rows = await db('app_settings')
    .whereIn('setting_key', [
      'general_public_site_enabled',
      'general_public_site_html',
      'general_public_site_custom_css'
    ]);

  const map = {
    general_public_site_enabled: false,
    general_public_site_html: DEFAULT_PUBLIC_SITE_HTML,
    general_public_site_custom_css: ''
  };

  rows.forEach((row) => {
    const parsed = parseSettingValue(row.setting_value);
    map[row.setting_key] = parsed == null ? map[row.setting_key] : parsed;
  });

  return map;
}

function sanitizeBrandUrl(url) {
  if (typeof url !== 'string' || !url.trim()) {
    return null;
  }

  const trimmed = url.trim();
  // GHSA-j347: the old check was a case-sensitive literal `javascript:`, which
  // `JavaScript:` walks straight past. Allowlist the schemes a logo URL can
  // legitimately use instead of blocklisting one spelling. Relative paths (the
  // common case — /uploads/logos/x.png) carry no scheme and are unaffected.
  const scheme = trimmed.match(/^\s*([a-z][a-z0-9+.-]*)\s*:/i);
  if (scheme && !['http', 'https'].includes(scheme[1].toLowerCase())) {
    return null;
  }

  return trimmed;
}

/**
 * HTML-escape a brand token value (GHSA-j347).
 *
 * Brand tokens are substituted AFTER sanitize-html runs, so markup in a token
 * value reaches the public page unfiltered. The default templates interpolate
 * tokens into text AND into quoted attributes
 * (`<img src="{{brand_logo_url}}" alt="{{company_name}} logo">`,
 * `href="mailto:{{support_email}}"`), so escaping the five HTML-significant
 * characters is correct in both positions.
 *
 * Mirrors galleryOgService's escapeHtml, which already handles this correctly.
 */
function escapeTokenValue(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function fetchBrandingContext() {
  const rows = await db('app_settings')
    .whereIn('setting_key', [
      'branding_company_name',
      'branding_company_tagline',
      'branding_support_email',
      'branding_logo_url',
      'branding_footer_text',
      'theme_config'
    ]);

  const context = {
    companyName: null,
    companyTagline: null,
    supportEmail: null,
    logoUrl: null,
    footerText: null,
    // 8-token CI palette mirrored from frontend ThemeConfig.
    // primary/accent are kept as legacy aliases (primary == accent-dark);
    // new tokens are surface, elevated, border, mutedText, accentDark.
    colors: {
      primary: '#16a34a',
      accent: '#0f766e',
      accentDark: '#16a34a',
      background: '#f4fbf6',
      surface: '#ffffff',
      elevated: '#f5f5f5',
      border: '#e5e5e5',
      text: '#0f172a',
      mutedText: '#737373'
    }
  };

  rows.forEach((row) => {
    const parsed = parseSettingValue(row.setting_value);
    switch (row.setting_key) {
    case 'branding_company_name':
      context.companyName = parsed || context.companyName;
      break;
    case 'branding_company_tagline':
      context.companyTagline = parsed || context.companyTagline;
      break;
    case 'branding_support_email':
      context.supportEmail = parsed || context.supportEmail;
      break;
    case 'branding_logo_url':
      context.logoUrl = sanitizeBrandUrl(parsed);
      break;
    case 'branding_footer_text':
      context.footerText = parsed || context.footerText;
      break;
    case 'theme_config': {
      try {
        const themeConfig = typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
        if (themeConfig && typeof themeConfig === 'object') {
          // Legacy 4 colors
          context.colors.primary = themeConfig.primaryColor || context.colors.primary;
          context.colors.accent = themeConfig.accentColor || context.colors.accent;
          context.colors.background = themeConfig.backgroundColor || context.colors.background;
          context.colors.text = themeConfig.textColor || context.colors.text;
          // 8-token CI palette additions
          context.colors.accentDark = themeConfig.accentDarkColor || themeConfig.primaryColor || context.colors.accentDark;
          context.colors.surface = themeConfig.surfaceColor || context.colors.surface;
          context.colors.elevated = themeConfig.elevatedColor || context.colors.elevated;
          context.colors.border = themeConfig.surfaceBorderColor || context.colors.border;
          context.colors.mutedText = themeConfig.mutedTextColor || context.colors.mutedText;
        }
      } catch (error) {
        logger.warn('Failed to parse theme configuration for public site', { error: error.message });
      }
      break;
    }
    default:
      break;
    }
  });

  return context;
}

function sanitizeHtmlPayload(html) {
  const sanitized = sanitizeHtml(html || '', {
    allowedTags: ALLOWED_HTML_TAGS,
    allowedAttributes: {
      '*': COMMON_ATTRIBUTES,
      a: ['href', 'target', 'rel', ...COMMON_ATTRIBUTES],
      img: ['src', 'alt', 'title', 'width', 'height', 'loading', 'decoding', ...COMMON_ATTRIBUTES],
      button: ['type', ...COMMON_ATTRIBUTES]
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https', 'data'] },
    transformTags: {
      a: (tagName, attribs) => {
        const transformed = { ...attribs };
        if (transformed.href && !/^https?:|^mailto:|^tel:/i.test(transformed.href)) {
          // sanitize-html will remove disallowed schemes, but we guard as well
          delete transformed.href;
        }

        if (transformed.target === '_blank') {
          transformed.rel = transformed.rel ? `${transformed.rel} noopener noreferrer`.trim() : 'noopener noreferrer';
        }

        return { tagName, attribs: transformed };
      }
    },
    nonBooleanAttributes: ['target'],
    parser: {
      lowerCaseAttributeNames: true
    }
  });

  return sanitized;
}

function buildCachedPayload(raw) {
  const sanitizedHtml = sanitizeHtmlPayload(raw.publicSite.general_public_site_html || DEFAULT_PUBLIC_SITE_HTML);
  const sanitizedCss = sanitizeCss(raw.publicSite.general_public_site_custom_css || '');
  const enabled = Boolean(raw.publicSite.general_public_site_enabled);
  const title = raw.branding.companyName || DEFAULT_PUBLIC_SITE_TITLE;
  const baseCss = sanitizeCss(DEFAULT_PUBLIC_SITE_CSS);

  const substitutedHtml = applyBrandTokens(sanitizedHtml, raw.branding);

  const hash = crypto
    .createHash('sha1')
    .update(`${enabled}|${substitutedHtml}|${sanitizedCss}|${baseCss}|${JSON.stringify(raw.branding)}`)
    .digest('hex');

  return {
    enabled,
    html: substitutedHtml,
    css: sanitizedCss,
    baseCss,
    title,
    branding: raw.branding,
    etag: `W/"${hash}"`
  };
}

async function getPublicSitePayload({ bypassCache = false } = {}) {
  if (!bypassCache && cachedPayload && Date.now() < cacheExpiresAt) {
    return cachedPayload;
  }

  const [publicSite, branding] = await Promise.all([
    fetchPublicSiteSettings(),
    fetchBrandingContext()
  ]);

  const payload = buildCachedPayload({ publicSite, branding });

  cachedPayload = payload;
  cacheExpiresAt = Date.now() + CACHE_TTL_MS;

  return payload;
}

function clearPublicSiteCache() {
  cachedPayload = null;
  cacheExpiresAt = 0;
}

async function getDefaultPublicSitePayload() {
  const branding = await fetchBrandingContext();
  return buildCachedPayload({
    publicSite: {
      general_public_site_enabled: false,
      general_public_site_html: DEFAULT_PUBLIC_SITE_HTML,
      general_public_site_custom_css: ''
    },
    branding
  });
}

async function getRawPublicSiteSettings() {
  return fetchPublicSiteSettings();
}

function applyBrandTokens(html, branding) {
  if (!html) {
    return html;
  }

  const tokens = {
    company_name: branding.companyName || '',
    company_tagline: branding.companyTagline || '',
    support_email: branding.supportEmail || '',
    brand_logo_url: branding.logoUrl || '/picpeak-logo-transparent.png',
    brand_primary_hex: branding.colors?.primary || '#2563eb',
    brand_accent_hex: branding.colors?.accent || '#1d4ed8',
    brand_background_hex: branding.colors?.background || '#f8fafc',
    brand_text_hex: branding.colors?.text || '#0f172a'
  };

  // Escape on substitution (GHSA-j347) — this runs AFTER sanitizeHtmlPayload,
  // so an unescaped value would reintroduce raw markup into the public origin.
  return html.replace(/\{\{\s*(company_name|company_tagline|support_email|brand_logo_url|brand_primary_hex|brand_accent_hex|brand_background_hex|brand_text_hex)\s*\}\}/gi,
    (_, key) => escapeTokenValue(tokens[key] || ''));
}

module.exports = {
  getPublicSitePayload,
  clearPublicSiteCache,
  getDefaultPublicSitePayload,
  getRawPublicSiteSettings,
  // Exposed for tests only — the token-escaping and URL-scheme rules
  // (GHSA-j347) are worth pinning directly rather than through the cache.
  _internal: { applyBrandTokens, sanitizeBrandUrl }
};
