/**
 * Migration 336: the `gallery_created` mail printed its expiry line even for a
 * gallery that never expires — "Your gallery will be available until null".
 *
 * Every sender passes `expiry_date: null` for such a gallery
 * (eventCreationService, adminEvents/crud), but no seeded copy of the template
 * guards the line: legacy 028/026 put it in a warning box, 001/194 and the
 * nl/pt/ru/fr/es/sl seeds in a list item. emailProcessor now prints a null as
 * nothing, which still leaves "available until ." — so the element holding
 * the date goes behind `{{#if expiry_date}}`, the construct
 * safeTemplateReplace already resolves (it drops the block when the value is
 * empty).
 *
 * Not byte-identity with a seeded copy like 194/196: the copies differ per
 * locale and per install history, and an admin who reworded the mail kept the
 * same broken line. The guard only hides an element whose value is missing —
 * with a date set, the mail renders exactly as before. What is wrapped:
 *
 *  - HTML: the innermost <li> or <p> holding {{expiry_date}}, or a <div> that
 *    holds nothing but that <p> (legacy 028's warning box);
 *  - text: the line holding it, with the line break before it, so the lines
 *    around it close up.
 *
 * Skipped, element by element: one that sits inside an `{{#if}}` block (an
 * already guarded one included, so a second run changes nothing) or holds
 * one — safeTemplateReplace does not nest; and one that carries another
 * variable too.
 */

const TEMPLATE_KEY = 'gallery_created';
// The tight form only: safeTemplateReplace substitutes nothing else.
const VAR = String.raw`\{\{expiry_date\}\}`;

// Alternation order matters: at a <div> the whole box is wrapped before its
// inner <p> could be.
const HTML_ELEMENT = new RegExp(
  String.raw`<div\b[^>]*>\s*<p\b[^>]*>(?:(?!<\/p>)[\s\S])*?${VAR}(?:(?!<\/p>)[\s\S])*?<\/p>\s*<\/div>`
  + String.raw`|<(li|p)\b[^>]*>(?:(?!<\/\1>)[\s\S])*?${VAR}(?:(?!<\/\1>)[\s\S])*?<\/\1>`,
  'gi'
);
const TEXT_LINE = new RegExp(String.raw`\n*[^\n]*${VAR}[^\n]*`, 'g');

function insideConditional(body, offset) {
  const before = body.slice(0, offset);
  const opened = (before.match(/\{\{#if\s+\w+\s*\}\}/g) || []).length;
  const closed = (before.match(/\{\{\/if\}\}/g) || []).length;
  return opened > closed;
}

function guard(body, pattern) {
  if (typeof body !== 'string' || !body) return body;
  return body.replace(pattern, (match, ...rest) => {
    const offset = rest.find((value) => typeof value === 'number');
    // Neither around the element nor inside it: an inner {{/if}} would
    // close the new guard early.
    if (insideConditional(body, offset) || /\{\{(#if\s|\/if\}\})/.test(match)) return match;
    // Nor one that carries another value (an edited "password …, available
    // until …" line): hiding it would hide that value too. It keeps the blank
    // date safeTemplateReplace prints.
    if (/\{\{(?!expiry_date\}\})\w+\}\}/.test(match)) return match;
    return `{{#if expiry_date}}${match}{{/if}}`;
  });
}

const guardHtml = (body) => guard(body, HTML_ELEMENT);
const guardText = (body) => guard(body, TEXT_LINE);

function changes(row, fields) {
  const update = {};
  for (const [field, fix] of fields) {
    if (!(field in row)) continue;
    const next = fix(row[field]);
    if (next !== row[field]) update[field] = next;
  }
  return update;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  const template = await knex('email_templates').where({ template_key: TEMPLATE_KEY }).first();
  if (!template) return;
  const now = new Date().toISOString();

  if (await knex.schema.hasTable('email_template_translations')) {
    const rows = await knex('email_template_translations').where({ template_id: template.id });
    for (const row of rows) {
      const update = changes(row, [['body_html', guardHtml], ['body_text', guardText]]);
      if (Object.keys(update).length === 0) continue;
      await knex('email_template_translations').where({ id: row.id }).update({ ...update, updated_at: now });
    }
  }

  // Legacy per-language columns — emailProcessor's fallback path.
  const legacyFields = Object.keys(template)
    .filter((column) => /^body_(html|text)(_[a-z]{2,3})?$/i.test(column))
    .map((column) => [column, /^body_html/i.test(column) ? guardHtml : guardText]);
  const update = changes(template, legacyFields);
  if (Object.keys(update).length > 0) {
    if ('updated_at' in template) update.updated_at = now;
    await knex('email_templates').where({ id: template.id }).update(update);
  }
};

// No-op: removing the guard would bring back "available until null".
exports.down = async function down() {};
