/**
 * access_logs.user_agent holds in-app browser user agents (#1501).
 *
 * Instagram on Android and Facebook Messenger on iOS send user agents longer
 * than 255 characters. With the column at varchar(255) the access_logs insert
 * threw on PostgreSQL and gallery/verify answered 500 "Verification failed".
 * SQLite never enforced the length, so only the real-Postgres case reproduces.
 */
const knex = require('knex');
const { randomUUID } = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const migration = require('../../migrations/core/218_access_logs_user_agent_text');

const LONG_UA = `Mozilla/5.0 (Linux; Android 14; wv) Instagram ${'x'.repeat(260)}`;

test('is a no-op on SQLite', async () => {
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  try {
    await migration.up(db);
    await db.schema.createTable('access_logs', (t) => { t.increments('id'); t.string('user_agent'); });
    await migration.up(db);
    await db('access_logs').insert({ user_agent: LONG_UA });
    expect((await db('access_logs').first()).user_agent).toBe(LONG_UA);
  } finally {
    await db.destroy();
  }
});

const pgUrl = process.env.PICPEAK_PG_TEST_URL;
(pgUrl ? describe : describe.skip)('PostgreSQL access_logs.user_agent', () => {
  let owner, db, schema, tmpDir, cleanup, previousClient, app;
  const slug = 'iab-public-event';

  const columnType = async () => (await db('information_schema.columns')
    .where({ table_schema: schema, table_name: 'access_logs', column_name: 'user_agent' })
    .first('data_type')).data_type;
  const verify = () => request(app).post('/api/auth/gallery/verify')
    .set('User-Agent', LONG_UA).send({ slug, password: '' });

  beforeAll(async () => {
    schema = `access_logs_ua_${randomUUID().replace(/-/g, '')}`;
    owner = knex({ client: 'pg', connection: pgUrl });
    await owner.schema.createSchema(schema);
    previousClient = process.env.DATABASE_CLIENT;
    process.env.DATABASE_CLIENT = 'pg';
    process.env.JWT_SECRET = 'access-logs-ua-test-secret-at-least-32-characters';
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-ua-pg-'));
    process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
    jest.doMock('../../knexfile', () => ({ client: 'pg', connection: pgUrl, searchPath: [schema] }));
    ({ db } = require('../../src/database/db'));
    ({ cleanup } = await require('../integration/helpers/crmDb').bootCrmDb());
    await require('../integration/helpers/crmDb').seedMinimal(db);
    await db('events').insert({
      slug, event_type: 'wedding', event_name: 'In-app browser', event_date: '2026-08-01',
      host_email: 'host@example.com', admin_email: 'admin@example.com',
      password_hash: 'unused', require_password: false,
      share_link: `/gallery/${slug}/share`, share_token: `${slug}-share`,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: true, is_archived: false, is_draft: false, created_at: new Date().toISOString(),
    });
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/auth', require('../../src/routes/auth'));
  }, 120000);

  afterAll(async () => {
    await require('../../src/services/serviceShutdown').stopServices();
    if (cleanup) await cleanup(); else if (db) await db.destroy();
    if (owner) { await owner.schema.dropSchema(schema, true); await owner.destroy(); }
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    if (previousClient === undefined) delete process.env.DATABASE_CLIENT; else process.env.DATABASE_CLIENT = previousClient;
    jest.dontMock('../../knexfile');
  });

  it('a fresh install stores a long user agent and lets the gallery login through', async () => {
    expect(await columnType()).toBe('text');
    const res = await verify();
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });

  it('an upgraded install with the old varchar(255) column is widened by the migration', async () => {
    await db('access_logs').delete();
    await db.raw('ALTER TABLE access_logs ALTER COLUMN user_agent TYPE varchar(255)');
    expect((await verify()).status).toBe(500);

    await migration.up(db);
    await migration.up(db);
    expect(await columnType()).toBe('text');
    expect((await verify()).status).toBe(200);
    const row = await db('access_logs').where({ action: 'login_success' }).orderBy('id', 'desc').first();
    expect(row.user_agent).toBe(LONG_UA);
  });
});
