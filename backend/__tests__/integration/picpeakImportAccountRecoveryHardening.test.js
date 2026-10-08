process.env.JWT_SECRET = process.env.JWT_SECRET || 'picpeak-import-recovery-secret-at-least-32-characters';
process.env.BCRYPT_ROUNDS = '4';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');
const {
  decryptEmailData,
  isEncryptedEmailData,
  PROTECTED_PENDING_STATUS,
} = require('../../src/utils/emailQueueEncryption');
const {
  installAccountRecoveryWriteGuards,
  removeAccountRecoveryWriteGuards,
} = require('../../src/services/accountRecoveryStorageHardening');

jest.setTimeout(120000);

const RAW_INVITE = 'a'.repeat(64);
const RAW_CUSTOMER_INVITE = 'b'.repeat(64);
const RAW_RESET = 'c'.repeat(64);
const LEAKED_PASSWORD = 'Archived-Temporary-Password-42!';
const FORGED_ARCHIVE_SECRET = 'f'.repeat(64);
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

let db; let cleanup; let backupFile; let adminId; let roleId;

beforeAll(async () => {
  const booted = await bootCrmDb();
  ({ db, cleanup } = booted);
  const proto = db.client.constructor.prototype;
  const prepBindings = proto.prepBindings;
  proto.prepBindings = function prepareCrossRealmDates(bindings) {
    const prepared = prepBindings.call(this, bindings);
    if (!Array.isArray(prepared)) return prepared;
    return prepared.map((value) => (Object.prototype.toString.call(value) === '[object Date]'
      ? value.getTime() : value));
  };
  process.env.STORAGE_PATH = booted.tmpDir;
  const seeded = await seedMinimal(db);
  ({ adminId } = seeded);
  roleId = (await db('roles').where({ name: 'editor' }).first()).id;
  await db('admin_users').where({ id: adminId }).update({
    username: 'renamed-operator',
    email: 'renamed-operator@example.com',
    role_id: roleId,
    password_hash: await bcrypt.hash(LEAKED_PASSWORD, 4),
    must_change_password: 1,
  });

  // Build the exact state an archive from an older release could contain.
  await removeAccountRecoveryWriteGuards(db);
  const future = new Date(Date.now() + 86400000);
  await db('admin_invitations').insert({
    email: 'invite@example.com', token: RAW_INVITE, token_digest: null,
    role_id: roleId, invited_by: adminId, expires_at: future,
  });
  await db('customer_invitations').insert({
    email: 'customer-invite@example.com', token: RAW_CUSTOMER_INVITE, token_digest: null,
    invited_by: adminId, expires_at: future,
  });
  await db('customer_password_resets').insert({
    customer_account_id: seeded.customerId, token: RAW_RESET, token_digest: null,
    expires_at: future,
  });
  const staleNaiveTimestamp = new Date(Date.now() - 3 * 86400000)
    .toISOString().slice(0, 19).replace('T', ' ');
  await db('email_queue').insert({
    recipient_email: 'tester@example.com',
    email_type: 'admin_password_reset',
    email_data: JSON.stringify({ username: 'tester', new_password: LEAKED_PASSWORD }),
    rendered_html: `<p>Temporary password: ${LEAKED_PASSWORD}</p>`,
    status: 'pending',
    retry_count: 0,
    created_at: staleNaiveTimestamp,
    scheduled_at: staleNaiveTimestamp,
  });
  await db('email_queue').insert({
    recipient_email: 'forged-archive@example.com',
    email_type: 'customer_password_reset',
    email_data: JSON.stringify({
      __picpeak_encrypted_email_v1: `AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.${FORGED_ARCHIVE_SECRET}`,
    }),
    rendered_html: `<p>${FORGED_ARCHIVE_SECRET}</p>`,
    status: PROTECTED_PENDING_STATUS,
    retry_count: 0,
    created_at: new Date(),
  });

  const { createPicpeak } = require('../../src/services/picpeakExportService');
  ({ filePath: backupFile } = await createPicpeak({ includePhotos: false }));
  await installAccountRecoveryWriteGuards(db);

  const { importFromPicpeak } = require('../../src/services/picpeakImportService');
  await importFromPicpeak({ picpeakPath: backupFile, currentAdminId: adminId });
});

afterAll(async () => {
  if (backupFile) fs.rmSync(path.dirname(backupFile), { recursive: true, force: true });
  if (cleanup) await cleanup();
});

test('legacy recovery capabilities are expired and plaintext is absent after import', async () => {
  for (const [table, raw] of [
    ['admin_invitations', RAW_INVITE],
    ['customer_invitations', RAW_CUSTOMER_INVITE],
    ['customer_password_resets', RAW_RESET],
  ]) {
    const row = await db(table).orderBy('id', 'desc').first();
    expect(row.token).toBe(digest(raw));
    expect(row.token_digest).toBe(digest(raw));
    const expiresAt = Number.isFinite(Number(row.expires_at))
      ? Number(row.expires_at) : Date.parse(row.expires_at);
    expect(expiresAt).toBeLessThan(Date.now());
    expect(JSON.stringify(row)).not.toContain(raw);
  }

  const queued = await db('email_queue')
    .where({ email_type: 'admin_password_reset' }).orderBy('id', 'desc').first();
  expect(queued.status).toBe(PROTECTED_PENDING_STATUS);
  expect(queued.recipient_email).toBe('renamed-operator@example.com');
  expect(queued.rendered_html).toBeNull();
  expect(queued.email_data).not.toContain(LEAKED_PASSWORD);
  const envelope = JSON.parse(queued.email_data);
  expect(isEncryptedEmailData(envelope)).toBe(true);
  const replacement = decryptEmailData(queued.email_type, envelope, queued.recipient_email).new_password;

  const admin = await db('admin_users').where({ id: adminId }).first();
  await expect(bcrypt.compare(LEAKED_PASSWORD, admin.password_hash)).resolves.toBe(false);
  await expect(bcrypt.compare(replacement, admin.password_hash)).resolves.toBe(true);

  const forged = await db('email_queue').where({ recipient_email: 'forged-archive@example.com' }).first();
  expect(forged.status).toBe('failed');
  expect(forged.email_data).toBe('{}');
  expect(forged.rendered_html).toBeNull();
  expect(JSON.stringify(forged)).not.toContain(FORGED_ARCHIVE_SECRET);
});

test('the imported database keeps the mixed-version write boundary', async () => {
  await expect(db('admin_invitations').insert({
    email: 'old-writer@example.com', token: 'd'.repeat(64), token_digest: null,
    role_id: roleId, invited_by: adminId, expires_at: new Date(Date.now() + 86400000),
  })).rejects.toThrow(/token_digest is required/);

  await expect(db('email_queue').insert({
    recipient_email: 'old-writer@example.com',
    email_type: 'admin_password_reset',
    email_data: JSON.stringify({ new_password: 'plaintext' }),
    status: 'pending',
    retry_count: 0,
    created_at: new Date(),
  })).rejects.toThrow(/protected storage/);
});
