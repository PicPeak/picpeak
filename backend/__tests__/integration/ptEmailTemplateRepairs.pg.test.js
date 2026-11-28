/**
 * The before/after rendering scenarios of migration 378 on PostgreSQL
 * (issue 2617). Which row an unordered "any translation" query returns is up
 * to the engine, so the cases that depend on it run here too, through the
 * real processTemplate bound to a PostgreSQL connection.
 *
 * Gated on PICPEAK_PG_TEST_URL; runs in a schema of its own and drops it.
 */
const knex = require('knex');
const crypto = require('crypto');
const { definePtTemplateRepairScenarios } = require('./helpers/ptTemplateRepairScenarios');

const pgUrl = process.env.PICPEAK_PG_TEST_URL;
const pg = pgUrl ? describe : describe.skip;

pg('pt email templates — repair paths (PostgreSQL)', () => {
  let owner; let db; let schema; let processTemplate; let migration;

  beforeAll(async () => {
    schema = `pt_email_${crypto.randomUUID().replace(/-/g, '')}`;
    owner = knex({ client: 'pg', connection: pgUrl });
    await owner.schema.createSchema(schema);
    db = knex({ client: 'pg', connection: pgUrl, searchPath: [schema], pool: { min: 0, max: 4 } });
    jest.doMock('../../src/database/db', () => ({ db, withRetry: (fn) => fn(), logActivity: async () => {} }));

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
    // The wrapper reads its colours, time zone and frontend URL from here.
    await db.schema.createTable('app_settings', (t) => {
      t.string('setting_key').primary(); t.text('setting_value'); t.string('setting_type');
    });

    ({ processTemplate } = require('../../src/services/emailProcessor'));
    migration = require('../../migrations/core/378_pt_email_template_translations');
  }, 60000);

  afterAll(async () => {
    if (db) await db.destroy();
    if (owner) { await owner.schema.dropSchema(schema, true); await owner.destroy(); }
  });

  definePtTemplateRepairScenarios(() => ({ db, processTemplate, migration }));
});
