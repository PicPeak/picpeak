/**
 * The small rules the website's modules share (issue 2618): what a text
 * field keeps, and which links a visitor may follow. No state and no
 * dependency on the other website modules, so any of them can use it.
 */

const MAX_URL_LENGTH = 500;

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

module.exports = { MAX_URL_LENGTH, cleanText, safeUrl };
