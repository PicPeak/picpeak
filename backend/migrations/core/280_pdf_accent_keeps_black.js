/**
 * PDF headings follow Branding › Colours from now on (services/pdf/theme.js
 * brandColors): a document whose theme sets no accent takes the brand's
 * filled accent instead of black.
 *
 * An install that has already sent documents keeps the look it had: its
 * "All documents" PDF theme gets the old black accent pinned, unless it
 * already sets one. The admin can clear it in Branding to follow the brand.
 * A fresh install (no quote, invoice or contract yet) follows the brand from
 * its first document. Documents already sent are stored files and never
 * change either way.
 */

const DOCUMENT_TABLES = ['quotes', 'invoices', 'contracts'];

async function hasDocuments(knex) {
  for (const table of DOCUMENT_TABLES) {
    if (!(await knex.schema.hasTable(table))) continue;
    const row = await knex(table).first('id');
    if (row) return true;
  }
  return false;
}

function parse(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('pdf_themes'))) return;
  if (!(await hasDocuments(knex))) return;

  const row = await knex('pdf_themes').where({ scope: 'default' }).first('settings');
  const settings = parse(row && row.settings);
  if (settings.colors && settings.colors.accent) return;

  const next = { ...settings, colors: { ...(settings.colors || {}), accent: '#000000' } };
  const now = new Date().toISOString();
  if (row) {
    await knex('pdf_themes').where({ scope: 'default' }).update({ settings: JSON.stringify(next), updated_at: now });
  } else {
    await knex('pdf_themes').insert({ scope: 'default', settings: JSON.stringify(next), created_at: now, updated_at: now });
  }
};

// The pinned value is indistinguishable from one the admin set, so it stays.
exports.down = async function () {};
