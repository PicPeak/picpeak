'use strict';

/**
 * Allowlisted `{{key}}` placeholders for CRM document texts (#1451).
 *
 * Same grammar as the email templates (emailProcessor.safeTemplateReplace):
 * `{{key}}` with a plain word as the key, so there is no property traversal,
 * no function call and no code. The difference is the allowlist: a document
 * text may only use the keys its document type declares, and anything else is
 * reported, so a template can't be published with a typo that would print
 * "{{custmer_name}}" on every quote.
 *
 * Values are escaped for the output they land in: `text` (plain-text mail,
 * the editor textarea) leaves them as they are, `html` escapes them, and
 * `markdown` (a contract body: the PDF and the signing page) backslash-escapes
 * the characters the body's inline markup reads, so a customer called
 * `**ACME**` is printed as typed instead of turning bold in the PDF only.
 */

const { escapeHtml } = require('./formatters');

const PLACEHOLDER_PATTERN = /\{\{\s*(\w+)\s*\}\}/g;
// `{{#if key}}…{{/if}}` — contract bodies use it to leave a clause out when
// a value is missing. Same tolerance for spaces as the plain placeholder, and
// the same module owns both so the check and the renderer can't disagree
// about what a placeholder looks like.
const CONDITIONAL_PATTERN = /\{\{\s*#if\s+(\w+)\s*\}\}([\s\S]*?)\{\{\s*\/if\s*\}\}/g;

// Keys a quote text (intro/outro, text blocks) may use.
const QUOTE_PLACEHOLDERS = Object.freeze([
  'customer_name',
  'customer_company',
  'event_name',
  'event_date',
  'quote_number',
  'valid_until',
  'business_name',
  'hours',
  'days',
  'hourly_rate',
  'day_rate',
]);

/** Every placeholder key used in `text`, in order of first appearance. */
// Keys contract texts may use (#1445) — the values
// services/contract/renderContext.buildPlaceholderContext provides.
const CONTRACT_PLACEHOLDERS = Object.freeze([
  'customer_name',
  'customer_address',
  'event_name',
  'event_date',
  'issue_date',
  'contract_number',
  'title',
  'net_days',
  'skonto_percent',
  'skonto_within_days',
  'cancellation_30d_percent',
  'currency',
  'issuer_company_name',
  'issuer_address',
  'source_quote_number',
]);

function findPlaceholders(text) {
  if (typeof text !== 'string' || !text) return [];
  const keys = [];
  // Conditionals first: `{{#if event_date}}` names a key too, and a typo in
  // one used to publish without a word — the clause then simply never
  // appeared on any document.
  for (const match of text.matchAll(CONDITIONAL_PATTERN)) {
    if (!keys.includes(match[1])) keys.push(match[1]);
  }
  for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
    if (!keys.includes(match[1])) keys.push(match[1]);
  }
  return keys;
}

/**
 * Does `text` use a `{{#if …}}` block? Quote texts are rendered by
 * renderPlaceholders, which resolves plain placeholders only, so a
 * conditional there would publish cleanly and then print its markup on the
 * quote. Contract bodies go through renderTemplatedBody and do support them.
 */
function hasConditional(text) {
  if (typeof text !== 'string' || !text) return false;
  return new RegExp(CONDITIONAL_PATTERN.source).test(text);
}

/**
 * Resolve `{{#if key}}…{{/if}}` against `values`: a key with no value — a
 * missing one included — drops the block. A plain `{{key}}` stays visible
 * when it is unknown, but leaving `{{#if …}}` markup in a contract body
 * would print it on the document, so a typo is caught earlier instead:
 * findPlaceholders reports conditional keys too, and publishing a template
 * with an unknown one is refused.
 */
function renderConditionals(text, values = {}) {
  if (typeof text !== 'string' || !text) return text;
  return text.replace(CONDITIONAL_PATTERN, (match, key, inner) => {
    const value = values && Object.prototype.hasOwnProperty.call(values, key) ? values[key] : undefined;
    const present = value !== undefined && value !== null && value !== '' && value !== false && value !== 0;
    return present ? inner : '';
  });
}

// Every opening and closing conditional tag, well-formed or not, so the check
// can tell a nested block (which the non-greedy CONDITIONAL_PATTERN mis-pairs)
// and an unclosed one from a correct block.
const CONDITIONAL_TAG = /\{\{\s*(?:#(if)\s+\w+|\/(if))\s*\}\}/g;

/**
 * What is wrong with the `{{#if}}` blocks in `text`: `CONDITIONAL_NESTED`
 * when one opens inside another (the renderer can't pair them), and
 * `CONDITIONAL_UNCLOSED` for an opening without its `{{/if}}` or a closing
 * without its opening. Empty when every block is flat and closed.
 */
function conditionalProblems(text) {
  if (typeof text !== 'string' || !text) return [];
  const problems = new Set();
  let depth = 0;
  for (const match of text.matchAll(CONDITIONAL_TAG)) {
    if (match[1]) {
      if (depth > 0) problems.add('CONDITIONAL_NESTED');
      depth += 1;
    } else if (depth === 0) {
      problems.add('CONDITIONAL_UNCLOSED');
    } else {
      depth -= 1;
    }
  }
  if (depth > 0) problems.add('CONDITIONAL_UNCLOSED');
  return [...problems];
}

/** Placeholder keys in `text` that are not in `allowlist`. */
function unknownPlaceholders(text, allowlist = QUOTE_PLACEHOLDERS) {
  return findPlaceholders(text).filter((key) => !allowlist.includes(key));
}

/**
 * Replace allowlisted placeholders with `values[key]`. A known key without a
 * value becomes an empty string (a quote without an event date simply has no
 * date); an unknown key is left untouched, so it stays visible instead of
 * silently disappearing.
 *
 * @param {string} text
 * @param {object} values
 * @param {{allowlist?: string[], output?: 'text'|'html'}} [options]
 */
function renderPlaceholders(text, values = {}, { allowlist = QUOTE_PLACEHOLDERS, output = 'text' } = {}) {
  if (typeof text !== 'string' || !text) return text;
  return text.replace(PLACEHOLDER_PATTERN, (match, key) => {
    if (!allowlist.includes(key)) return match;
    // Own properties only — never a value inherited from Object.prototype.
    const value = values && Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
    if (value == null) return '';
    return escapeValue(String(value), output);
  });
}

// The characters a contract body's inline markup gives a meaning to, plus the
// backslash that escapes them. `_ # [ ]` mean nothing to the renderer today;
// escaping them now means a later list or link syntax can't be switched on
// by a customer's name.
const MARKDOWN_SPECIAL = /[\\*_#[\]]/g;
const MARKDOWN_ESCAPABLE = new Set(['\\', '*', '_', '#', '[', ']', '-', '>']);

/** A value made literal for a contract body: see parseInlineMarkdown. */
function escapeMarkdown(value) {
  return String(value)
    .replace(MARKDOWN_SPECIAL, '\\$&')
    // A value that starts a line with `-` or `>` must not start a list or a quote.
    .replace(/(^|\n)([ \t]*)([->])/g, '$1$2\\$3');
}

/** A placeholder value escaped for `output`: 'text' | 'html' | 'markdown'. */
function escapeValue(value, output = 'text') {
  if (output === 'html') return escapeHtml(value);
  if (output === 'markdown') return escapeMarkdown(value);
  return value;
}

/**
 * A contract body's inline markup as runs: `[{ text, bold }]`. `**text**`
 * is bold; a backslash before one of `\ * _ # [ ] - >` makes that character
 * literal. An unpaired `**` stays as typed. The PDF draws these runs and the
 * signing page prints their text, so both read the markup the same way.
 */
function parseInlineMarkdown(text) {
  const source = String(text == null ? '' : text);
  const runs = [];
  let bold = false;
  let buf = '';
  const flush = () => {
    if (!buf) return;
    const last = runs[runs.length - 1];
    if (last && last.bold === bold) last.text += buf;
    else runs.push({ text: buf, bold });
    buf = '';
  };
  // Where the next unescaped `**` starts, or -1; `*` alone inside bold text
  // ends the search, matching the old `\*\*[^*]+\*\*` rule.
  const closingAt = (from) => {
    for (let j = from; j < source.length; j += 1) {
      if (source[j] === '\\' && MARKDOWN_ESCAPABLE.has(source[j + 1])) { j += 1; continue; }
      if (source[j] === '*') return source[j + 1] === '*' && j > from ? j : -1;
    }
    return -1;
  };
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '\\' && MARKDOWN_ESCAPABLE.has(source[i + 1])) {
      buf += source[i + 1];
      i += 1;
      continue;
    }
    if (ch === '*' && source[i + 1] === '*') {
      if (bold) {
        flush();
        bold = false;
        i += 1;
        continue;
      }
      const end = closingAt(i + 2);
      if (end !== -1) {
        flush();
        bold = true;
        i += 1;
        continue;
      }
    }
    buf += ch;
  }
  flush();
  return runs;
}

/** A contract body as plain text: markup dropped, escapes resolved. */
function markdownToPlain(text) {
  return parseInlineMarkdown(text).map((run) => run.text).join('');
}

module.exports = {
  QUOTE_PLACEHOLDERS,
  CONTRACT_PLACEHOLDERS,
  PLACEHOLDER_PATTERN,
  CONDITIONAL_PATTERN,
  findPlaceholders,
  hasConditional,
  conditionalProblems,
  renderConditionals,
  unknownPlaceholders,
  renderPlaceholders,
  escapeMarkdown,
  escapeValue,
  parseInlineMarkdown,
  markdownToPlain,
};
