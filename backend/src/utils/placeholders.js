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
// a value is missing — and its one inversion, `{{#unless key}}…{{/unless}}`,
// for "only when there is no …". Same tolerance for spaces as the plain
// placeholder, and the same module owns both so the check and the renderer
// can't disagree about what a placeholder looks like. Groups: 1 = if|unless,
// 2 = key, 3 = body. Deliberately no else, negation, comparison or nesting
// (the pre-publication check refuses nested blocks).
const CONDITIONAL_PATTERN = /\{\{\s*#(if|unless)\s+(\w+)\s*\}\}([\s\S]*?)\{\{\s*\/\1\s*\}\}/g;

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

// The placeholders contract texts may use (#1445) — the values
// services/contract/renderContext.buildPlaceholderContext provides — with
// what the editor's picker shows: a category, a label and a sample value per
// language, and whether a "Show only if…" rule may test it (a value that can
// be empty). The frontend reads this from the API; it keeps no copy.
const CONTRACT_PLACEHOLDER_REGISTRY = Object.freeze([
  { key: 'customer_name', category: 'customer', conditional: false,
    label: { en: 'Customer name', de: 'Name des Kunden' },
    sample: { en: 'Anna Muster', de: 'Anna Muster' } },
  { key: 'customer_address', category: 'customer', conditional: true,
    label: { en: 'Customer address', de: 'Adresse des Kunden' },
    sample: { en: 'Musterstrasse 1, 9490, Vaduz', de: 'Musterstrasse 1, 9490, Vaduz' } },
  { key: 'event_name', category: 'event', conditional: true,
    label: { en: 'Event name', de: 'Name des Anlasses' },
    sample: { en: 'Wedding Anna & Ben', de: 'Hochzeit Anna & Ben' } },
  { key: 'event_date', category: 'event', conditional: true,
    label: { en: 'Event date', de: 'Datum des Anlasses' },
    sample: { en: '12.06.2027', de: '12.06.2027' } },
  { key: 'issue_date', category: 'contract', conditional: false,
    label: { en: 'Contract date', de: 'Vertragsdatum' },
    sample: { en: '22.09.2026', de: '22.09.2026' } },
  { key: 'contract_number', category: 'contract', conditional: false,
    label: { en: 'Contract number', de: 'Vertragsnummer' },
    sample: { en: 'C-2026-0042', de: 'C-2026-0042' } },
  { key: 'title', category: 'contract', conditional: false,
    label: { en: 'Contract title', de: 'Vertragstitel' },
    sample: { en: 'Photography contract', de: 'Fotografievertrag' } },
  { key: 'source_quote_number', category: 'contract', conditional: true,
    label: { en: 'Number of the source quote', de: 'Nummer der Offerte' },
    sample: { en: 'Q-2026-0107', de: 'Q-2026-0107' } },
  { key: 'net_days', category: 'pricing', conditional: false,
    label: { en: 'Payment term (days)', de: 'Zahlungsfrist (Tage)' },
    sample: { en: '30', de: '30' } },
  { key: 'skonto_percent', category: 'pricing', conditional: false,
    label: { en: 'Early-payment discount (%)', de: 'Skonto (%)' },
    sample: { en: '2', de: '2' } },
  { key: 'skonto_within_days', category: 'pricing', conditional: false,
    label: { en: 'Early-payment discount within (days)', de: 'Skonto innert (Tagen)' },
    sample: { en: '10', de: '10' } },
  // Not data: renderContext fills in the literal 25 on every contract.
  { key: 'cancellation_30d_percent', category: 'pricing', conditional: false,
    label: { en: 'Cancellation fee within 30 days (fixed: 25 %)', de: 'Annullationsgebühr innert 30 Tagen (fest: 25 %)' },
    sample: { en: '25', de: '25' } },
  { key: 'currency', category: 'pricing', conditional: false,
    label: { en: 'Currency', de: 'Währung' },
    sample: { en: 'CHF', de: 'CHF' } },
  { key: 'issuer_company_name', category: 'issuer', conditional: false,
    label: { en: 'Your company name', de: 'Ihr Firmenname' },
    sample: { en: 'Studio Example', de: 'Studio Beispiel' } },
  { key: 'issuer_address', category: 'issuer', conditional: false,
    label: { en: 'Your address', de: 'Ihre Adresse' },
    sample: { en: 'Weg 1, 9490, Vaduz', de: 'Weg 1, 9490, Vaduz' } },
].map((entry) => Object.freeze(entry)));

// Keys contract texts may use: derived from the registry, so the allowlist
// and the picker can't drift apart.
const CONTRACT_PLACEHOLDERS = Object.freeze(CONTRACT_PLACEHOLDER_REGISTRY.map((entry) => entry.key));

/** Every placeholder key used in `text`, in order of first appearance. */
function findPlaceholders(text) {
  if (typeof text !== 'string' || !text) return [];
  const keys = [];
  // Conditionals first: `{{#if event_date}}` names a key too, and a typo in
  // one used to publish without a word — the clause then simply never
  // appeared on any document.
  for (const match of text.matchAll(CONDITIONAL_PATTERN)) {
    if (!keys.includes(match[2])) keys.push(match[2]);
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
 * missing one included — drops the block; `{{#unless key}}…{{/unless}}` keeps
 * its block exactly then. A plain `{{key}}` stays visible
 * when it is unknown, but leaving `{{#if …}}` markup in a contract body
 * would print it on the document, so a typo is caught earlier instead:
 * findPlaceholders reports conditional keys too, and publishing a template
 * with an unknown one is refused.
 */
function renderConditionals(text, values = {}) {
  if (typeof text !== 'string' || !text) return text;
  return text.replace(CONDITIONAL_PATTERN, (match, kind, key, inner) => {
    const value = values && Object.prototype.hasOwnProperty.call(values, key) ? values[key] : undefined;
    const present = value !== undefined && value !== null && value !== '' && value !== false && value !== 0;
    return present === (kind === 'if') ? inner : '';
  });
}

// Every opening and closing conditional tag, well-formed or not, so the check
// can tell a nested block (which the non-greedy CONDITIONAL_PATTERN mis-pairs)
// and an unclosed one from a correct block.
const CONDITIONAL_TAG = /\{\{\s*(?:#(if|unless)\s+\w+|\/(if|unless))\s*\}\}/g;

/**
 * What is wrong with the `{{#if}}` blocks in `text`: `CONDITIONAL_NESTED`
 * when one opens inside another (the renderer can't pair them), and
 * `CONDITIONAL_UNCLOSED` for an opening without its `{{/if}}` or a closing
 * without its opening. Empty when every block is flat and closed.
 */
function conditionalProblems(text) {
  if (typeof text !== 'string' || !text) return [];
  const problems = new Set();
  const open = [];
  for (const match of text.matchAll(CONDITIONAL_TAG)) {
    if (match[1]) {
      if (open.length) problems.add('CONDITIONAL_NESTED');
      open.push(match[1]);
    } else if (open.pop() !== match[2]) {
      // A closing tag with nothing open, or `{{/unless}}` closing an `#if`.
      problems.add('CONDITIONAL_UNCLOSED');
    }
  }
  if (open.length) problems.add('CONDITIONAL_UNCLOSED');
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
  CONTRACT_PLACEHOLDER_REGISTRY,
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
