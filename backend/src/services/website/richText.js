/**
 * Website text (issue 2618): the short inline format of headings, intros and
 * quotes (**bold**, *italic*, [link](url), blank line = paragraph), and the
 * rich text of the text block, HTML from the editor kept to an allowlist.
 */
const sanitizeHtml = require('sanitize-html');
const { escapeHtml: esc } = require('../../utils/formatters');
const { NON_TEXT_TAGS } = require('../../utils/sanitizeHtmlOptions');
const { safeUrl } = require('./document');

// Runs on already-escaped text, which contains no `<`, so the only tags in
// the result are the two inserted here.
function emphasis(escaped) {
  return escaped
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
}

function linkAttrs(url) {
  return /^https?:/i.test(url) ? ' rel="noopener noreferrer"' : '';
}

/** One paragraph: escaped text with **bold**, *italic* and [label](url). */
function inline(text) {
  const linkPattern = /\[([^\]\n]{1,200})\]\(([^)\s]{1,500})\)/g;
  let out = '';
  let last = 0;
  for (const match of text.matchAll(linkPattern)) {
    out += emphasis(esc(text.slice(last, match.index)));
    const url = safeUrl(match[2]);
    out += url
      ? `<a href="${esc(url)}"${linkAttrs(url)}>${emphasis(esc(match[1]))}</a>`
      : emphasis(esc(match[0]));
    last = match.index + match[0].length;
  }
  return out + emphasis(esc(text.slice(last)));
}

/** Multi-paragraph text: a blank line starts a paragraph, a newline is a <br>. */
function richText(text) {
  if (!text) return '';
  return text.split(/\n\s*\n/).map((para) => para.trim()).filter(Boolean)
    .map((para) => `<p>${para.split('\n').map(inline).join('<br>')}</p>`).join('');
}

// The text block's rich text: what the editor's compact form produces
// (headings 2 and 3, bold, italic, underline, lists, quote, links, left /
// centre / right alignment) and nothing else. Links go through safeUrl, as
// every other link on the website.
const RICH_TEXT_OPTIONS = {
  allowedTags: ['p', 'br', 'h2', 'h3', 'strong', 'em', 'u', 'ul', 'ol', 'li', 'blockquote', 'a'],
  allowedAttributes: { a: ['href', 'rel'], p: ['style'], h2: ['style'], h3: ['style'] },
  allowedStyles: { '*': { 'text-align': [/^(left|center|right)$/] } },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowProtocolRelative: false,
  nonTextTags: NON_TEXT_TAGS,
  transformTags: {
    b: 'strong',
    i: 'em',
    a: (tagName, attribs) => {
      const url = safeUrl(attribs.href || '');
      // Not a safe link: the text stays, the link goes (an <a> without href).
      if (!url) return { tagName: 'a', attribs: {} };
      return { tagName: 'a', attribs: { href: url, ...(/^https?:/i.test(url) ? { rel: 'noopener noreferrer' } : {}) } };
    },
  },
};

function sanitizeRichText(html) {
  return sanitizeHtml(typeof html === 'string' ? html : '', RICH_TEXT_OPTIONS);
}

module.exports = { inline, richText, linkAttrs, sanitizeRichText };
