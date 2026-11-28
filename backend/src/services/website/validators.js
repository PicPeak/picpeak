/**
 * The small rules the website's modules share (issue 2618): what a text
 * field keeps, which links a visitor may follow, when a flag is on. No state
 * and no dependency on the other website modules, so any of them can use it.
 */
const { parseBooleanInput } = require('../../utils/parsers');

const MAX_URL_LENGTH = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

// An uploaded image's or video's public id, alone and inside a media token.
const ASSET_ID = '[0-9a-f]{24}';
const ASSET_ID_PATTERN = new RegExp(`^${ASSET_ID}$`);

// A page's address, and the path it is reached at: one segment of that
// shape (frontend/nginx.conf's website location takes the same).
const SLUG = '[a-z0-9]+(?:-[a-z0-9]+)*';
const SLUG_PATTERN = new RegExp(`^${SLUG}$`);
const PAGE_PATH_PATTERN = new RegExp(`^/(${SLUG})/?$`);

// A font family as the branding stores it.
const FONT_NAME_PATTERN = /^[A-Za-z0-9 ]{1,60}$/;

// An e-mail address the website writes to or shows: a visitor's, a
// recipient's, the footer's and a social link's.
const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/**
 * A flag as it is stored or sent: on only when it clearly says so ("false"
 * and "0" are off, never a truthy string), else `fallback`.
 */
const flag = (value, fallback = false) => parseBooleanInput(value, fallback);

/** Text as a field takes it: a string, trimmed, without control characters other than tab and newline. */
function cleanText(value) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex -- intentional: strips control chars from admin input
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
}

/**
 * A link a visitor may follow: http(s), mailto, tel, a same-site path or an
 * anchor. Anything else (javascript:, data:, protocol-relative `//host`,
 * backslash tricks) becomes '' so the renderer leaves the link out.
 */
function safeUrl(value) {
  const url = cleanText(value).slice(0, MAX_URL_LENGTH);
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

module.exports = {
  MAX_URL_LENGTH, DAY_MS, ASSET_ID, ASSET_ID_PATTERN, SLUG_PATTERN, PAGE_PATH_PATTERN, FONT_NAME_PATTERN, EMAIL_PATTERN,
  cleanText, flag, safeUrl,
};
