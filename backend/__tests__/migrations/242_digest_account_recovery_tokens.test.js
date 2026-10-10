process.env.JWT_SECRET = process.env.JWT_SECRET || 'migration-recovery-token-secret-at-least-32-chars';
process.env.BCRYPT_ROUNDS = '4';

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');
const migration = require('../../migrations/core/242_digest_account_recovery_tokens');
const {
  decryptEmailData, encryptEmailData, isEncryptedEmailData, PROTECTED_PENDING_STATUS,
} = require('../../src/utils/emailQueueEncryption');
const { MASK } = require('../../src/utils/emailSecretRedaction');
const {
  hardenAccountRecoveryStorage,
  installAccountRecoveryWriteGuards,
  removeAccountRecoveryWriteGuards,
} = require('../../src/services/accountRecoveryStorageHardening');

jest.setTimeout(120000);

let db; let cleanup; let adminId; let roleId; let customerId; let users; let customers;
const rawAdmin = 'a'.repeat(64);
const rawCustomer = 'b'.repeat(64);
const rawReset = 'c'.repeat(64);
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  const proto = db.client.constructor.prototype;
  const prepBindings = proto.prepBindings;
  proto.prepBindings = function prepareCrossRealmDates(bindings) {
    const prepared = prepBindings.call(this, bindings);
    if (!Array.isArray(prepared)) return prepared;
    return prepared.map((value) => (Object.prototype.toString.call(value) === '[object Date]'
      ? value.getTime() : value));
  };
  ({ adminId } = await seedMinimal(db));
  roleId = (await db('roles').where({ name: 'editor' }).first()).id;
  const inserted = await db('customer_accounts').insert({
    email: 'migration-reset@example.com', password_hash: 'x', is_active: true,
    created_at: new Date().toISOString(),
  }).returning('id');
  customerId = inserted[0]?.id ?? inserted[0];
  users = require('../../src/services/userManagementService');
  customers = require('../../src/services/customerAccountsService');
});

afterAll(async () => { if (cleanup) await cleanup(); });

test('digests and expires legacy capabilities, and protects pending recovery mail', async () => {
  const leakedAdminPassword = 'Temporary-Password-42!';
  const future = new Date(Date.now() + 86400000).toISOString();
  await db('admin_users').where({ id: adminId }).update({
    password_hash: await bcrypt.hash(leakedAdminPassword, 4),
    must_change_password: 1,
    username: 'renamed-admin',
    email: 'renamed-admin@example.com',
  });
  // Simulate rows created before the migration installed its write boundary.
  await removeAccountRecoveryWriteGuards(db);
  await db('admin_invitations').insert({
    email: 'admin-invite@example.com', token: rawAdmin, token_digest: null,
    role_id: roleId, invited_by: adminId, expires_at: future,
  });
  await db('customer_invitations').insert({
    email: 'customer-invite@example.com', token: rawCustomer, token_digest: null,
    invited_by: adminId, expires_at: future,
  });
  await db('customer_password_resets').insert({
    token: rawReset, token_digest: null, customer_account_id: customerId, expires_at: future,
  });
  const inviteMail = (await db('email_queue').insert({
    recipient_email: 'customer-invite@example.com', email_type: 'customer_invitation',
    email_data: JSON.stringify({ invite_link: `https://photos.example/customer/invite/${rawCustomer}` }),
    rendered_html: `<a href="https://photos.example/customer/invite/${rawCustomer}">Join</a>`,
    status: 'pending', retry_count: 0, created_at: new Date().toISOString(),
  }).returning('id'))[0];
  const resetMail = (await db('email_queue').insert({
    recipient_email: 'tester@example.com', email_type: 'admin_password_reset',
    email_data: JSON.stringify({ username: 'tester', new_password: leakedAdminPassword }),
    rendered_html: `<p>Your temporary password is ${leakedAdminPassword}</p>`,
    status: 'failed', retry_count: 3, created_at: new Date().toISOString(),
  }).returning('id'))[0];
  const stalePassword = 'Stale-Temporary-Password-42!';
  const staleResetMail = (await db('email_queue').insert({
    recipient_email: 'missing-admin@example.com', email_type: 'admin_password_reset',
    email_data: JSON.stringify({ username: 'missing-admin', new_password: stalePassword }),
    rendered_html: `<p>Your temporary password is ${stalePassword}</p>`,
    status: 'pending', retry_count: 0, created_at: new Date().toISOString(),
  }).returning('id'))[0];
  const sealedRecipient = 'already-sealed@example.com';
  const sealedLink = `https://photos.example/customer/reset-password/${'d'.repeat(64)}`;
  const sealedData = JSON.stringify(encryptEmailData(
    'customer_password_reset', { reset_link: sealedLink }, sealedRecipient,
  ));
  const sealedMail = (await db('email_queue').insert({
    recipient_email: sealedRecipient, email_type: 'customer_password_reset',
    email_data: sealedData, rendered_html: `<a href="${sealedLink}">Reset</a>`,
    status: 'pending', retry_count: 0, created_at: new Date().toISOString(),
  }).returning('id'))[0];
  const forgedSecret = 'f'.repeat(64);
  const forgedMail = (await db('email_queue').insert({
    recipient_email: 'forged@example.com', email_type: 'customer_password_reset',
    email_data: JSON.stringify({
      __picpeak_encrypted_email_v1: `AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.${forgedSecret}`,
    }),
    rendered_html: `<p>${forgedSecret}</p>`,
    status: PROTECTED_PENDING_STATUS, retry_count: 0, created_at: new Date().toISOString(),
  }).returning('id'))[0];
  const inviteMailId = inviteMail?.id ?? inviteMail;
  const resetMailId = resetMail?.id ?? resetMail;
  const staleResetMailId = staleResetMail?.id ?? staleResetMail;
  const sealedMailId = sealedMail?.id ?? sealedMail;
  const forgedMailId = forgedMail?.id ?? forgedMail;

  await migration.up(db);

  for (const [table, raw] of [
    ['admin_invitations', rawAdmin],
    ['customer_invitations', rawCustomer],
    ['customer_password_resets', rawReset],
  ]) {
    const row = await db(table).orderBy('id', 'desc').first();
    expect(row.token).toBe(digest(raw));
    expect(row.token_digest).toBe(digest(raw));
    expect(typeof row.expires_at).toBe('number');
    expect(row.expires_at).toBeLessThan(Date.now());
  }

  expect(await users.validateInvitationToken(rawAdmin)).toBeNull();
  await expect(users.acceptInvitation({
    token: rawAdmin, username: 'expired-migration-admin', password: 'Password-Expired-2026!',
  })).rejects.toThrow(/invalid or expired/i);
  expect(await customers.validateInvitationToken(rawCustomer)).toBeNull();
  await expect(customers.acceptInvitation({
    token: rawCustomer, name: 'Expired', password: 'Password-Expired-2026!',
  })).rejects.toThrow(/invalid or expired/i);
  expect(await customers.validatePasswordResetToken(rawReset)).toBeNull();
  await expect(customers.applyPasswordReset({
    token: rawReset, password: 'Password-Expired-2026!',
  })).rejects.toThrow(/invalid or expired/i);

  const invalidated = await db('email_queue').where({ id: inviteMailId }).first();
  expect(invalidated.status).toBe('failed');
  expect(invalidated.email_data).not.toContain(rawCustomer);
  expect(invalidated.rendered_html).not.toContain(rawCustomer);

  const protectedReset = await db('email_queue').where({ id: resetMailId }).first();
  const encryptedData = JSON.parse(protectedReset.email_data);
  expect(protectedReset.status).toBe(PROTECTED_PENDING_STATUS);
  expect(protectedReset.recipient_email).toBe('renamed-admin@example.com');
  expect(isEncryptedEmailData(encryptedData)).toBe(true);
  expect(protectedReset.email_data).not.toContain(leakedAdminPassword);
  expect(protectedReset.rendered_html).toBeNull();
  const replacementPassword = decryptEmailData(
    protectedReset.email_type, encryptedData, protectedReset.recipient_email,
  ).new_password;
  expect(replacementPassword).not.toBe(leakedAdminPassword);
  const admin = await db('admin_users').where({ id: adminId }).first();
  await expect(bcrypt.compare(leakedAdminPassword, admin.password_hash)).resolves.toBe(false);
  await expect(bcrypt.compare(replacementPassword, admin.password_hash)).resolves.toBe(true);

  const staleReset = await db('email_queue').where({ id: staleResetMailId }).first();
  expect(staleReset.status).toBe('failed');
  expect(staleReset.email_data).not.toContain(stalePassword);
  expect(staleReset.rendered_html).toBeNull();

  const alreadySealed = await db('email_queue').where({ id: sealedMailId }).first();
  expect(alreadySealed.email_data).toBe(sealedData);
  expect(alreadySealed.rendered_html).toBeNull();
  expect(alreadySealed.email_data).not.toContain(sealedLink);
  expect(alreadySealed.status).toBe(PROTECTED_PENDING_STATUS);

  const forged = await db('email_queue').where({ id: forgedMailId }).first();
  expect(forged.status).toBe('failed');
  expect(forged.email_data).toBe('{}');
  expect(forged.rendered_html).toBeNull();
  expect(JSON.stringify(forged)).not.toContain(forgedSecret);

  await expect(db('admin_invitations').insert({
    email: 'old-writer@example.com', token: 'e'.repeat(64), token_digest: null,
    role_id: roleId, invited_by: adminId, expires_at: future,
  })).rejects.toThrow(/token_digest is required/);
  await expect(db('email_queue').insert({
    recipient_email: 'old-writer@example.com', email_type: 'admin_password_reset',
    email_data: JSON.stringify({ new_password: 'plaintext-secret' }),
    status: 'pending', retry_count: 0, created_at: new Date().toISOString(),
  })).rejects.toThrow(/protected storage/);
  await expect(db('email_queue').insert({
    recipient_email: 'old-writer@example.com', email_type: 'customer_password_reset',
    email_data: JSON.stringify({
      __picpeak_encrypted_email_v1: 'AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AA',
      reset_link: 'raw-secret',
    }),
    status: PROTECTED_PENDING_STATUS, retry_count: 0, created_at: new Date().toISOString(),
  })).rejects.toThrow(/protected storage/);

  const ciphertext = protectedReset.email_data;
  await migration.up(db);
  expect((await db('email_queue').where({ id: resetMailId }).first()).email_data).toBe(ciphertext);
});

test('credential rotation rolls back if the protected queue replacement fails', async () => {
  const leaked = 'Atomic-Temporary-Password-42!';
  const inserted = await db('admin_users').insert({
    username: 'atomic-admin', email: 'atomic-admin@example.com', role_id: roleId,
    password_hash: await bcrypt.hash(leaked, 4), must_change_password: 1,
    created_at: new Date(), updated_at: new Date(),
  }).returning('id');
  const atomicAdminId = inserted[0]?.id ?? inserted[0];
  const tokenInsert = await db('api_tokens').insert({
    name: 'atomic-token', hashed_token: digest('atomic-api-token'), scopes: 'read',
    created_by: atomicAdminId,
  }).returning('id');
  const apiTokenId = tokenInsert[0]?.id ?? tokenInsert[0];

  await removeAccountRecoveryWriteGuards(db);
  const queueInsert = await db('email_queue').insert({
    recipient_email: 'atomic-admin@example.com', email_type: 'admin_password_reset',
    email_data: JSON.stringify({ username: 'atomic-admin', new_password: leaked }),
    status: 'failed', retry_count: 3, created_at: new Date(),
  }).returning('id');
  const queueId = queueInsert[0]?.id ?? queueInsert[0];
  await db.raw(`
    CREATE TRIGGER test_recovery_rotation_abort BEFORE UPDATE ON email_queue
    WHEN NEW.id = ${Number(queueId)} BEGIN SELECT RAISE(ABORT, 'injected queue failure'); END
  `);

  await expect(hardenAccountRecoveryStorage(db)).rejects.toThrow(/injected queue failure/);
  let admin = await db('admin_users').where({ id: atomicAdminId }).first();
  await expect(bcrypt.compare(leaked, admin.password_hash)).resolves.toBe(true);
  expect((await db('api_tokens').where({ id: apiTokenId }).first()).revoked_at).toBeNull();

  await db.raw('DROP TRIGGER test_recovery_rotation_abort');
  await hardenAccountRecoveryStorage(db);
  await installAccountRecoveryWriteGuards(db);
  admin = await db('admin_users').where({ id: atomicAdminId }).first();
  await expect(bcrypt.compare(leaked, admin.password_hash)).resolves.toBe(false);
  expect((await db('api_tokens').where({ id: apiTokenId }).first()).revoked_at).not.toBeNull();
  expect((await db('email_queue').where({ id: queueId }).first()).status)
    .toBe(PROTECTED_PENDING_STATUS);
});

describe('queued admin resets that already reached a final state', () => {
  const queueReset = async (fields) => {
    const inserted = await db('email_queue').insert({
      recipient_email: 'tester@example.com', email_type: 'admin_password_reset',
      status: 'sent', retry_count: 0,
      created_at: new Date().toISOString(), sent_at: new Date().toISOString(), ...fields,
    }).returning('id');
    return inserted[0]?.id ?? inserted[0];
  };
  let warn;
  let currentPassword;

  beforeEach(async () => {
    await db('email_queue').del();
    currentPassword = `Current-Password-${crypto.randomBytes(4).toString('hex')}!`;
    await db('admin_users').where({ id: adminId }).update({
      password_hash: await bcrypt.hash(currentPassword, 4),
      username: 'tester', email: 'tester@example.com',
    });
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => { jest.restoreAllMocks(); });

  test.each([
    ['the archive mask', MASK],
    ['an empty value', ''],
  ])('a row holding %s is left alone without any bcrypt work', async (_label, stored) => {
    const emailData = JSON.stringify({ username: 'tester', new_password: stored });
    const id = await queueReset({ email_data: emailData });
    const before = (await db('admin_users').where({ id: adminId }).first()).password_hash;
    const compare = jest.spyOn(bcrypt, 'compare');
    const hash = jest.spyOn(bcrypt, 'hash');

    await hardenAccountRecoveryStorage(db);

    expect(compare).not.toHaveBeenCalled();
    expect(hash).not.toHaveBeenCalled();
    expect((await db('admin_users').where({ id: adminId }).first()).password_hash).toBe(before);
    const row = await db('email_queue').where({ id }).first();
    expect(row.status).toBe('sent');
    expect(row.email_data).toBe(emailData);
    expect(warn).not.toHaveBeenCalled();
  });

  test('a sent row whose plaintext is still the live password rotates it and names the admin', async () => {
    const id = await queueReset({
      email_data: JSON.stringify({ username: 'tester', new_password: currentPassword }),
      rendered_html: `<p>Your temporary password is ${currentPassword}</p>`,
    });

    await hardenAccountRecoveryStorage(db);

    const admin = await db('admin_users').where({ id: adminId }).first();
    await expect(bcrypt.compare(currentPassword, admin.password_hash)).resolves.toBe(false);
    const row = await db('email_queue').where({ id }).first();
    expect(row.status).toBe(PROTECTED_PENDING_STATUS);
    expect(row.email_data).not.toContain(currentPassword);
    const replacement = decryptEmailData(row.email_type, JSON.parse(row.email_data), row.recipient_email)
      .new_password;
    await expect(bcrypt.compare(replacement, admin.password_hash)).resolves.toBe(true);

    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0][0];
    expect(line).toContain(`"tester" (id ${adminId}, tester@example.com)`);
    expect(line).toMatch(/was reset by the security upgrade/);
    expect(line).toMatch(/new password-reset email was queued/);
    expect(line).not.toContain(currentPassword);
    expect(line).not.toContain(replacement);
  });

  test('a sent row whose plaintext matches no admin is scrubbed only', async () => {
    const stale = 'Long-Gone-Temporary-Password-42!';
    const id = await queueReset({
      email_data: JSON.stringify({ username: 'tester', new_password: stale }),
      rendered_html: `<p>Your temporary password is ${stale}</p>`,
    });
    const before = (await db('admin_users').where({ id: adminId }).first()).password_hash;

    await hardenAccountRecoveryStorage(db);

    expect((await db('admin_users').where({ id: adminId }).first()).password_hash).toBe(before);
    const row = await db('email_queue').where({ id }).first();
    expect(row.status).toBe('sent');
    expect(JSON.parse(row.email_data).new_password).toBe(MASK);
    expect(row.rendered_html).not.toContain(stale);
    expect(warn).not.toHaveBeenCalled();
  });
});

test('logs how many outstanding rows each token table lost, without token material', async () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  const rawOutstanding = '1'.repeat(64);
  const rawAccepted = '2'.repeat(64);
  await removeAccountRecoveryWriteGuards(db);
  await db('admin_invitations').insert([
    {
      email: 'outstanding@example.com', token: rawOutstanding, token_digest: null,
      role_id: roleId, invited_by: adminId, expires_at: future,
    },
    {
      email: 'accepted@example.com', token: rawAccepted, token_digest: null,
      role_id: roleId, invited_by: adminId, expires_at: future, accepted_at: future,
    },
  ]);
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await hardenAccountRecoveryStorage(db);

    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0][0];
    expect(line).toContain('expired 1 outstanding admin_invitations row(s)');
    expect(line).not.toContain(rawOutstanding);
    expect(line).not.toContain(digest(rawOutstanding));

    log.mockClear();
    await hardenAccountRecoveryStorage(db);
    expect(log).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
    await installAccountRecoveryWriteGuards(db);
  }
});
