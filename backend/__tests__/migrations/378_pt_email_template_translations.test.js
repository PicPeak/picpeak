/**
 * Migration 378 fills pt email-template content on upgraded installs
 * (issue 2617). What it must never do is overwrite a pt row an admin wrote,
 * or leave a legacy-column-only template with a lone pt row that English and
 * German recipients would then receive.
 *
 * Runs on SQLite always; on PostgreSQL too when PICPEAK_PG_TEST_URL points at
 * a throwaway database (own schema, dropped before and after).
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const knexFactory = require('knex');

const migration = require('../../migrations/core/378_pt_email_template_translations');
const { PT_EMAIL_TEMPLATES } = require('../../src/services/ptEmailTemplates');

const SCHEMA = 'mig378_pt_email_test';

async function createSchema(db) {
  await db.schema.createTable('email_templates', (t) => {
    t.increments('id').primary();
    t.string('template_key').unique().notNullable();
    for (const lang of ['en', 'de']) {
      t.text(`subject_${lang}`); t.text(`body_html_${lang}`); t.text(`body_text_${lang}`);
    }
    t.text('variables');
  });
  await db.schema.createTable('email_template_translations', (t) => {
    t.increments('id').primary();
    t.integer('template_id').notNullable().references('id').inTable('email_templates').onDelete('CASCADE');
    t.string('language', 10).notNullable();
    t.text('subject'); t.text('body_html'); t.text('body_text');
    t.timestamp('created_at'); t.timestamp('updated_at');
    t.unique(['template_id', 'language']);
  });
}

async function insertTemplate(db, row) {
  const [inserted] = await db('email_templates').insert(row).returning('id');
  return typeof inserted === 'object' ? inserted.id : inserted;
}

const translation = (db, templateId, language) =>
  db('email_template_translations').where({ template_id: templateId, language }).first();

function suite(label, connect) {
  describe(`migration 378 — pt email templates (${label})`, () => {
    let db; let teardown; let ids;

    beforeAll(async () => {
      ({ db, teardown } = await connect());
      await createSchema(db);
      const now = new Date().toISOString();
      ids = {
        plain: await insertTemplate(db, { template_key: 'archive_complete' }),
        edited: await insertTemplate(db, { template_key: 'gallery_expired' }),
        blank: await insertTemplate(db, { template_key: 'invoice_sent' }),
        legacy: await insertTemplate(db, {
          template_key: 'transfer_ready',
          subject_en: '{{transfer_title}} — your files are ready to download',
          body_html_en: '<p>Hello</p>',
          body_text_en: 'Hello',
          subject_de: '{{transfer_title}} — Ihre Dateien stehen bereit',
          body_html_de: '<p>Hallo</p>',
          body_text_de: 'Hallo',
        }),
        legacyWithBlankPt: await insertTemplate(db, {
          template_key: 'transfer_files_received',
          subject_en: 'Files received', body_html_en: '<p>Received</p>', body_text_en: 'Received',
          subject_de: 'Dateien erhalten', body_html_de: '<p>Erhalten</p>', body_text_de: 'Erhalten',
        }),
        germanSubjectOnly: await insertTemplate(db, {
          template_key: 'transfer_request',
          subject_en: 'Please upload', body_html_en: '<p>Upload: {{upload_url}}</p>', body_text_en: 'Upload: {{upload_url}}',
          subject_de: 'Bitte hochladen', body_html_de: '', body_text_de: '',
        }),
        loneRu: await insertTemplate(db, {
          template_key: 'transfer_link_expired',
          subject_en: 'Link expired', body_html_en: '<p>Expired</p>', body_text_en: 'Expired',
          subject_de: 'Link abgelaufen', body_html_de: '<p>Abgelaufen</p>', body_text_de: 'Abgelaufen',
        }),
        ownPtOnly: await insertTemplate(db, {
          template_key: 'quote_sent',
          subject_en: 'Quote', body_html_en: '<p>Quote</p>', body_text_en: 'Quote',
        }),
      };
      await db('email_template_translations').insert([
        { template_id: ids.loneRu, language: 'ru', subject: 'Ссылка истекла', body_html: '<p>ru</p>', body_text: 'ru', created_at: now, updated_at: now },
        { template_id: ids.ownPtOnly, language: 'pt', subject: 'Meu orçamento', body_html: '<p>meu</p>', body_text: 'meu', created_at: now, updated_at: now },
        { template_id: ids.legacyWithBlankPt, language: 'pt', subject: '', body_html: '', body_text: '', created_at: now, updated_at: now },
        { template_id: ids.plain, language: 'en', subject: 'Archive Complete', body_html: '<p>x</p>', body_text: 'x', created_at: now, updated_at: now },
        { template_id: ids.edited, language: 'en', subject: 'Expired', body_html: '<p>x</p>', body_text: 'x', created_at: now, updated_at: now },
        { template_id: ids.edited, language: 'pt', subject: 'Minha versão', body_html: '<p>meu texto</p>', body_text: 'meu texto', created_at: now, updated_at: now },
        { template_id: ids.blank, language: 'en', subject: 'Invoice', body_html: '<p>x</p>', body_text: 'x', created_at: now, updated_at: now },
        { template_id: ids.blank, language: 'pt', subject: '', body_html: '', body_text: null, created_at: now, updated_at: now },
      ]);
      await migration.up(db);
    }, 60000);

    afterAll(async () => { if (teardown) await teardown(); });

    it('adds the pt row a template lacks', async () => {
      const pt = await translation(db, ids.plain, 'pt');
      expect(pt.subject).toBe(PT_EMAIL_TEMPLATES.archive_complete.subject);
      expect(pt.body_html).toBe(PT_EMAIL_TEMPLATES.archive_complete.body_html);
    });

    it('fills an empty pt row but keeps one an admin wrote', async () => {
      expect((await translation(db, ids.blank, 'pt')).subject).toBe(PT_EMAIL_TEMPLATES.invoice_sent.subject);
      const edited = await translation(db, ids.edited, 'pt');
      expect(edited.subject).toBe('Minha versão');
      expect(edited.body_text).toBe('meu texto');
    });

    it('materialises en / de from the legacy columns before adding pt', async () => {
      const en = await translation(db, ids.legacy, 'en');
      const de = await translation(db, ids.legacy, 'de');
      expect(en).toMatchObject({ subject: '{{transfer_title}} — your files are ready to download', body_text: 'Hello' });
      expect(de).toMatchObject({ subject: '{{transfer_title}} — Ihre Dateien stehen bereit', body_text: 'Hallo' });
      expect((await translation(db, ids.legacy, 'pt')).subject).toBe(PT_EMAIL_TEMPLATES.transfer_ready.subject);
    });

    it('materialises en / de per language even when an empty pt row exists', async () => {
      expect(await translation(db, ids.legacyWithBlankPt, 'en')).toMatchObject({ subject: 'Files received', body_html: '<p>Received</p>' });
      expect(await translation(db, ids.legacyWithBlankPt, 'de')).toMatchObject({ subject: 'Dateien erhalten', body_text: 'Erhalten' });
      expect((await translation(db, ids.legacyWithBlankPt, 'pt')).subject).toBe(PT_EMAIL_TEMPLATES.transfer_files_received.subject);
    });

    it('gives German the English bodies the renderer used when only the German subject existed', async () => {
      expect(await translation(db, ids.germanSubjectOnly, 'de')).toMatchObject({
        subject: 'Bitte hochladen', body_html: '<p>Upload: {{upload_url}}</p>', body_text: 'Upload: {{upload_url}}',
      });
    });

    // English (and through it German and every other language) was served the
    // lone Russian row; that is what the new English row has to hold.
    it('pins the row other languages were served when a template has only a ru row', async () => {
      expect(await translation(db, ids.loneRu, 'en')).toMatchObject({ subject: 'Ссылка истекла', body_html: '<p>ru</p>', body_text: 'ru' });
      expect(await translation(db, ids.loneRu, 'de')).toBeUndefined();
      expect((await translation(db, ids.loneRu, 'ru')).subject).toBe('Ссылка истекла');
      expect((await translation(db, ids.loneRu, 'pt')).subject).toBe(PT_EMAIL_TEMPLATES.transfer_link_expired.subject);
    });

    it('leaves a template alone whose pt row an admin wrote', async () => {
      const rows = await db('email_template_translations').where({ template_id: ids.ownPtOnly });
      expect(rows.map((row) => [row.language, row.subject])).toEqual([['pt', 'Meu orçamento']]);
    });

    it('is idempotent and skips templates the install does not have', async () => {
      const before = await db('email_template_translations').count({ n: '*' }).first();
      await migration.up(db);
      const after = await db('email_template_translations').count({ n: '*' }).first();
      expect(Number(after.n)).toBe(Number(before.n));
      expect(Number(before.n)).toBe(19);
    });

    it('down() removes only the pt rows it wrote', async () => {
      await migration.down(db);
      expect(await translation(db, ids.plain, 'pt')).toBeUndefined();
      expect(await translation(db, ids.legacy, 'pt')).toBeUndefined();
      expect((await translation(db, ids.edited, 'pt')).subject).toBe('Minha versão');
      expect(await translation(db, ids.legacy, 'en')).toBeDefined();
    });
  });
}

suite('SQLite', async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-mig378-'));
  const db = knexFactory({ client: 'sqlite3', connection: { filename: path.join(tmpDir, 'db.sqlite') }, useNullAsDefault: true });
  return {
    db,
    teardown: async () => { await db.destroy(); await fs.promises.rm(tmpDir, { recursive: true, force: true }); },
  };
});

const PG_URL = process.env.PICPEAK_PG_TEST_URL;
const connectPg = async () => {
  const bootstrap = knexFactory({ client: 'pg', connection: PG_URL, pool: { min: 0, max: 1 } });
  await bootstrap.raw(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await bootstrap.raw(`CREATE SCHEMA ${SCHEMA}`);
  await bootstrap.destroy();
  const db = knexFactory({ client: 'pg', connection: PG_URL, searchPath: [SCHEMA], pool: { min: 0, max: 2 } });
  return {
    db,
    teardown: async () => { await db.raw(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); await db.destroy(); },
  };
};
if (PG_URL) suite('PostgreSQL', connectPg);
else describe.skip('migration 378 — pt email templates (PostgreSQL, needs PICPEAK_PG_TEST_URL)', () => { it('runs on PostgreSQL', () => {}); });
