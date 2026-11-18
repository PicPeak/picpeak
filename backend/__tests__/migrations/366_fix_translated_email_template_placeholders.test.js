const { bootCrmDb } = require('../integration/helpers/crmDb');
const migration = require('../../migrations/core/366_fix_translated_email_template_placeholders');
const { TRANSLATIONS: SEEDED_099 } = require('../../migrations/core/099_seed_missing_email_template_translations');

jest.setTimeout(120000);

let db; let cleanup;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
});

afterAll(async () => { if (cleanup) await cleanup(); });

const PLACEHOLDER = /\{\{\s*(?:#if\s+)?(\w+)\s*\}\}/g;
const placeholdersIn = (row) => new Set(
  [row.subject, row.body_html, row.body_text]
    .filter((v) => typeof v === 'string')
    .flatMap((v) => [...v.matchAll(PLACEHOLDER)].map((m) => m[1])),
);

async function translation(key, language) {
  const template = await db('email_templates').where({ template_key: key }).first();
  return db('email_template_translations').where({ template_id: template.id, language }).first();
}

async function setTranslation(key, language, content) {
  const row = await translation(key, language);
  await db('email_template_translations').where({ id: row.id }).update(content);
}

test('no translation uses a placeholder its English template does not', async () => {
  const rows = await db('email_template_translations as tr')
    .join('email_templates as t', 't.id', 'tr.template_id')
    .select('t.template_key', 'tr.language', 'tr.subject', 'tr.body_html', 'tr.body_text');
  const english = new Map(rows.filter((r) => r.language === 'en').map((r) => [r.template_key, placeholdersIn(r)]));

  const stray = [];
  for (const row of rows) {
    const allowed = english.get(row.template_key);
    if (!allowed || row.language === 'en') continue;
    for (const name of placeholdersIn(row)) {
      if (!allowed.has(name)) stray.push(`${row.template_key} (${row.language}): {{${name}}}`);
    }
  }
  expect(stray).toEqual([]);
});

test('the repaired templates use only what their senders pass', async () => {
  for (const [key, sent] of Object.entries(migration.SENT_VARIABLES)) {
    for (const language of Object.keys(migration.CORRECTED[key])) {
      const row = await translation(key, language);
      for (const name of placeholdersIn(row)) expect(`${key}:${name}`).toBe(`${key}:${sent.includes(name) ? name : '(not sent)'}`);
    }
  }
});

test('replaces an untouched seeded row with the corrected copy', async () => {
  const seeded = SEEDED_099.admin_invitation.ru;
  await setTranslation('admin_invitation', 'ru', seeded);
  expect((await translation('admin_invitation', 'ru')).body_html).toContain('{{invitation_link}}');

  await migration.up(db);

  const row = await translation('admin_invitation', 'ru');
  expect(row.subject).toBe(migration.CORRECTED.admin_invitation.ru.subject);
  expect(row.body_html).toContain('href="{{invite_link}}"');
  expect(row.body_html).not.toMatch(/invitation_link|inviter_name/);
});

test('keeps an edited row\'s wording and renames only the placeholders with an equivalent', async () => {
  await setTranslation('admin_invitation', 'fr', {
    subject: 'Invitation maison',
    body_html: '<p>Texte maison de {{inviter_name}} : <a href="{{invitation_link}}">ici</a></p>',
    body_text: 'Texte maison : {{invitation_link}}',
  });
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

  await migration.up(db);

  const row = await translation('admin_invitation', 'fr');
  expect(row.subject).toBe('Invitation maison');
  expect(row.body_html).toBe('<p>Texte maison de {{inviter_name}} : <a href="{{invite_link}}">ici</a></p>');
  expect(row.body_text).toBe('Texte maison : {{invite_link}}');
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('{{inviter_name}}'));
  warn.mockRestore();
});

test('leaves a row alone once it uses only filled placeholders, so a re-run changes nothing', async () => {
  await setTranslation('backup_completed', 'nl', { subject: 'Eigen onderwerp', body_html: '<p>{{total_size}}</p>', body_text: '{{total_size}}' });
  const before = await translation('backup_completed', 'nl');
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

  await migration.up(db);
  await migration.up(db);
  warn.mockRestore();

  expect(await translation('backup_completed', 'nl')).toEqual(before);
});
