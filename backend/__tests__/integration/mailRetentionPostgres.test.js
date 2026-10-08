const knex = require('knex');
const fs = require('fs').promises;
const path = require('path');
const { randomUUID } = require('crypto');
const pgUrl = process.env.PICPEAK_PG_TEST_URL;
jest.setTimeout(120000);

(pgUrl ? describe : describe.skip)('incoming mail native PostgreSQL admission', () => {
  let owner, db, schema, cleanup, mail, expense, image, previousClient;
  let sequence = 0;
  const claim = (accountKey = 'accounting', bytes = 100000, sender = 'supplier@example.com') => mail.admit({ messageId: `<pg-${++sequence}@example.com>`, accountKey, sender, bytes });
  beforeAll(async () => {
    schema = `mail_retention_${randomUUID().replace(/-/g, '')}`;
    owner = knex({ client: 'pg', connection: pgUrl });
    await owner.schema.createSchema(schema);
    previousClient = process.env.DATABASE_CLIENT;
    process.env.DATABASE_CLIENT = 'pg';
    process.env.NODE_ENV = 'test';
    process.env.SKIP_S3_TESTS = 'true';
    jest.doMock('../../knexfile', () => ({ client: 'pg', connection: pgUrl, searchPath: [schema], pool: { min: 0, max: 12 } }));
    ({ db } = require('../../src/database/db'));
    ({ cleanup } = await require('./helpers/crmDb').bootCrmDb());
    require('../../src/database/db').logActivity = async () => {};
    mail = require('../../src/services/mailRetentionService');
    expense = require('../../src/services/expenseService');
    image = await require('sharp')({ create: { width: 8, height: 8, channels: 3, background: '#112233' } }).png().toBuffer();
  });
  beforeEach(async () => {
    for (const key of Object.keys(process.env).filter(k => k.startsWith('EMAIL_INTAKE_'))) delete process.env[key];
    await db('received_emails').del();
    await db('inbound_documents').del();
    await db('mail_intake_files').del();
    await db('mail_intake_state').del();
    await db('mail_intake_state').insert({ key: 'installation' });
    await fs.rm(path.join(process.env.STORAGE_PATH, 'business-docs', 'inbound'), { recursive: true, force: true });
  });
  afterAll(async () => {
    if (cleanup) await cleanup(); else if (db) await db.destroy();
    if (owner) { await owner.schema.dropSchema(schema, true); await owner.destroy(); }
    if (previousClient === undefined) delete process.env.DATABASE_CLIENT; else process.env.DATABASE_CLIENT = previousClient;
    jest.dontMock('../../knexfile');
  });

  test('separate native connections serialize claims before bytes can oversubscribe either scope', async () => {
    process.env.EMAIL_INTAKE_INSTALLATION_BYTES = '170000';
    process.env.EMAIL_INTAKE_MAILBOX_BYTES = '120000';
    let used = 0;
    const monitor = setInterval(() => { used = Math.max(used, db.client.pool.numUsed()); }, 1);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => claim(i % 2 ? 'customers' : 'accounting')));
    clearInterval(monitor);
    expect(used).toBeGreaterThan(1);
    expect(results.filter(r => !r.skip)).toHaveLength(1);
    expect((await mail._internal.locked(trx => mail._internal.usage(trx))).bytes).toBeLessThanOrEqual(170000);
    for (const key of ['accounting', 'customers']) expect((await mail._internal.locked(trx => mail._internal.usage(trx, key))).bytes).toBeLessThanOrEqual(120000);
  });

  test('persisted sender windows prevent concurrent unique-Message-ID bypass', async () => {
    process.env.EMAIL_INTAKE_SENDER_PER_HOUR = '1';
    const results = await Promise.all(Array.from({ length: 12 }, () => claim('accounting', 20000)));
    expect(results.filter(r => !r.skip)).toHaveLength(1);
    expect(results.filter(r => r.reason?.includes('rate'))).toHaveLength(11);
  });

  test('simultaneous hash captures share physical bytes, settle charges and retain duplicate records', async () => {
    const capture = async () => {
      const held = await claim();
      const filePath = await mail.saveAttachment({ content: image }, held);
      const document = await expense.recordInboundDocument({ source: 'email', filePath, originalFilename: 'supplier.png', mimeType: 'image/png', mailClaim: held }, null);
      await mail.finish(held, { status: 'ingested', body_text: 'löwe 📷', inbound_document_id: document.id });
      return document;
    };
    const docs = await Promise.all([capture(), capture()]);
    expect(docs.map(d => d.status).sort()).toEqual(['duplicate', 'unsorted']);
    const files = await db('mail_intake_files');
    expect(files).toHaveLength(1);
    expect(Number(files[0].byte_size)).toBe(image.length);
    expect(await fs.readFile(require('../../src/utils/storedPath').resolveStoredPath(files[0].file_path))).toEqual(image);
    const expected = 2 * (mail.META_BYTES + mail.AUDIT_BYTES + Buffer.byteLength('löwe 📷')) + image.length;
    expect((await mail._internal.locked(trx => mail._internal.usage(trx))).bytes).toBe(expected);
  });

  test('native timestamp leases fence late workers, and migration reruns preserve UTF-8 byte charges', async () => {
    const held = await claim();
    await mail.sweep({ now: new Date(Date.now() + mail.CLAIM_MS + 1) });
    await expect(mail.saveAttachment({ content: image }, held)).rejects.toThrow(/expired|superseded/);
    await db('received_emails').where({ id: held.id }).update({ status: 'received', body_text: 'löwe 📷', retained_bytes: 0 });
    const migration = require('../../migrations/core/244_incoming_mail_retention');
    await migration.up(db); await migration.up(db);
    expect(Number((await db('received_emails').where({ id: held.id }).first()).retained_bytes)).toBe(mail.META_BYTES + Buffer.byteLength('löwe 📷'));
  });
});
