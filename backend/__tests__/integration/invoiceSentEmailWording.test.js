/**
 * The English invoice email no longer tells every customer the IBAN is on
 * the PDF: a US invoice carries no IBAN. An install still holding the old
 * default gets the new sentence; a text an admin edited is left alone.
 */

const { bootCrmDb } = require('./helpers/crmDb');

jest.setTimeout(120000);

let db;
let cleanup;

const seed = () => new Promise((resolve, reject) => {
  jest.isolateModules(() => {
    require('../../src/services/crmEmailTemplates').ensureCrmEmailTemplatesSeeded(db, null).then(resolve, reject);
  });
});

const english = async () => {
  const row = await db('email_templates').where({ template_key: 'invoice_sent' }).first();
  return db('email_template_translations').where({ template_id: row.id, language: 'en' }).first();
};

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  await seed();
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

test('a new install\'s English invoice email mentions no IBAN', async () => {
  const en = await english();
  expect(en.body_html).toContain('The payment details are on the attached PDF.');
  expect(en.body_html).not.toContain('IBAN');
});

test('the German one keeps its IBAN sentence', async () => {
  const row = await db('email_templates').where({ template_key: 'invoice_sent' }).first();
  const de = await db('email_template_translations').where({ template_id: row.id, language: 'de' }).first();
  expect(de.body_html).toContain('IBAN');
});

test('an install still holding the old default gets the new sentence', async () => {
  const old = require('../../src/services/crmEmailTemplates').PREVIOUS_DEFAULTS.invoice_sent.en;
  const { id } = await english();
  await db('email_template_translations').where({ id }).update(old);

  await seed();

  expect((await english()).body_html).not.toContain('IBAN');
});

test('an English text an admin edited is left alone', async () => {
  const old = require('../../src/services/crmEmailTemplates').PREVIOUS_DEFAULTS.invoice_sent.en;
  const { id } = await english();
  const edited = `${old.body_html}<p>Pay by Zelle to hello@example.com.</p>`;
  await db('email_template_translations').where({ id }).update({ ...old, body_html: edited });

  await seed();

  expect((await english()).body_html).toBe(edited);
});
