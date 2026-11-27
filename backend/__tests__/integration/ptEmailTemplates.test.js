/**
 * Every email template has Brazilian Portuguese content that uses the same
 * template variables as its English version (issue 2617).
 *
 * A fresh install gets the pt rows from two places: migration 378 for the
 * templates migrations create, and the boot seeders for the CRM, contract,
 * reminder and delivery templates they create after the migrations ran. This
 * boots exactly that sequence.
 */

const { bootCrmDb } = require('./helpers/crmDb');
const { PT_EMAIL_TEMPLATES } = require('../../src/services/ptEmailTemplates');

// Variables and block helpers ({{#if x}}, {{/if}}, {{else}}); an unknown or
// renamed token would go out as literal text, a missing one drops the value.
const tokens = (...parts) => {
  const found = new Set();
  for (const part of parts) {
    for (const match of String(part || '').matchAll(/\{\{\{?\s*([^}]+?)\s*\}?\}\}/g)) found.add(match[1].replace(/\s+/g, ' '));
  }
  return [...found].sort();
};

describe('pt email templates', () => {
  let db; let cleanup; let byKey;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { seedEmailTemplatesAndRecoverQueue } = require('../../src/services/_emailTemplateBoot');
    await seedEmailTemplatesAndRecoverQueue(db, null);
    const rows = await db('email_templates as t')
      .join('email_template_translations as tr', 'tr.template_id', 't.id')
      .select('t.template_key', 'tr.language', 'tr.subject', 'tr.body_html', 'tr.body_text');
    byKey = {};
    for (const row of rows) (byKey[row.template_key] = byKey[row.template_key] || {})[row.language] = row;
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('exists with content for every template a fresh install has', () => {
    const keys = Object.keys(byKey);
    expect(keys.length).toBeGreaterThan(60);
    const missing = keys.filter((key) => !byKey[key].pt || !String(byKey[key].pt.subject || '').trim() || !String(byKey[key].pt.body_html || '').trim());
    expect(missing).toEqual([]);
  });

  it('uses exactly the template variables of the English version', () => {
    const mismatched = [];
    for (const [key, langs] of Object.entries(byKey)) {
      if (!langs.pt || !langs.en) continue;
      const fields = ['subject', 'body_html', 'body_text'];
      // The content added for issue 2617 mirrors English field by field. Older
      // pt rows (migrations 075 / 099) are compared per template: their plain
      // text repeats the link and password that the short English text body
      // leaves to the HTML part.
      const compared = PT_EMAIL_TEMPLATES[key] ? fields.map((field) => [field]) : [fields];
      for (const group of compared) {
        const en = tokens(...group.map((field) => langs.en[field]));
        const pt = tokens(...group.map((field) => langs.pt[field]));
        if (en.join() !== pt.join()) mismatched.push(`${key}.${group.join('+')}`);
      }
    }
    expect(mismatched).toEqual([]);
  });
});
