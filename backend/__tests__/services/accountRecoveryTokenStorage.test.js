/** Raw invitation/reset capabilities never enter the database. */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'account-recovery-storage-test-secret-at-least-32';

const { bootCrmDb, seedMinimal, assignAdminRole } = require('../integration/helpers/crmDb');
const { digestCapabilityToken } = require('../../src/utils/capabilityToken');
const { decryptEmailData, isEncryptedEmailData } = require('../../src/utils/emailQueueEncryption');

jest.setTimeout(120000);

let db; let cleanup; let adminId; let editorRoleId; let users; let customers;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  // Jest's VM creates Date objects from another realm; sqlite3 otherwise
  // binds service-created expiries as "[object Object]" in this integration.
  const proto = db.client.constructor.prototype;
  const prepBindings = proto.prepBindings;
  proto.prepBindings = function prepareCrossRealmDates(bindings) {
    const prepared = prepBindings.call(this, bindings);
    // SQLite only: PostgreSQL binds the Date itself, and a number in a
    // timestamptz column is refused.
    if (this.config.client === 'pg' || !Array.isArray(prepared)) return prepared;
    return prepared.map((value) => (Object.prototype.toString.call(value) === '[object Date]'
      ? value.getTime() : value));
  };
  ({ adminId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  editorRoleId = (await db('roles').where({ name: 'editor' }).first()).id;
  users = require('../../src/services/userManagementService');
  customers = require('../../src/services/customerAccountsService');
}, 120000);

afterAll(async () => { if (cleanup) await cleanup(); });

/** email_data as stored: text on SQLite, already parsed jsonb on PostgreSQL. */
function storedEmailData(row) {
  return typeof row.email_data === 'string' ? JSON.parse(row.email_data) : row.email_data;
}

/** The token from the invitation mail: the only place it is handed out. */
async function mailedAdminInviteToken(email) {
  const queued = await db('email_queue')
    .where({ email_type: 'admin_invitation', recipient_email: email })
    .orderBy('id', 'desc').first();
  const mailed = decryptEmailData(queued.email_type, storedEmailData(queued), queued.recipient_email);
  return mailed.invite_link.split('/invite/')[1];
}

test('admin invitations store a digest and are claimed atomically', async () => {
  const created = await users.createInvitation({
    email: 'digest-admin@example.com', roleId: editorRoleId,
    invitedById: adminId, inviterRoleName: 'super_admin',
  });
  // The raw token reaches only the invited mailbox, not the inviter.
  expect(created).not.toHaveProperty('token');
  const queued = await db('email_queue').where({ email_type: 'admin_invitation' })
    .orderBy('id', 'desc').first();
  expect(isEncryptedEmailData(storedEmailData(queued))).toBe(true);
  const token = await mailedAdminInviteToken('digest-admin@example.com');
  expect(JSON.stringify(queued.email_data)).not.toContain(token);

  const digest = digestCapabilityToken(token);
  const row = await db('admin_invitations').where({ id: created.id }).first();
  expect(row.token).toBe(digest);
  expect(row.token_digest).toBe(digest);
  expect(row.token).not.toBe(token);
  expect(await users.validateInvitationToken(token)).toBeTruthy();
  expect(await users.validateInvitationToken(digest)).toBeNull();

  const settled = await Promise.allSettled([
    users.acceptInvitation({ token, username: 'digest-admin-a', password: 'Password-A-2026!' }),
    users.acceptInvitation({ token, username: 'digest-admin-b', password: 'Password-B-2026!' }),
  ]);
  expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(1);
  expect(await db('admin_users').where({ email: 'digest-admin@example.com' })).toHaveLength(1);
});

test('customer invitations store only a digest and encrypt the queued link', async () => {
  const created = await customers.createInvitation({
    email: 'digest-customer@example.com', invitedById: adminId,
  });
  const digest = digestCapabilityToken(created.token);
  const row = await db('customer_invitations').where({ id: created.id }).first();
  expect(row.token).toBe(digest);
  expect(row.token_digest).toBe(digest);
  expect(row.token).not.toBe(created.token);
  expect(await customers.validateInvitationToken(created.token)).toBeTruthy();
  expect(await customers.validateInvitationToken(digest)).toBeNull();

  const queued = await db('email_queue').where({ email_type: 'customer_invitation' })
    .orderBy('id', 'desc').first();
  expect(JSON.stringify(queued.email_data)).not.toContain(created.token);
  const plaintext = decryptEmailData(queued.email_type, storedEmailData(queued), queued.recipient_email);
  expect(plaintext.invite_link).toContain(created.token);
});

test('customer password resets store only a digest and encrypt the queued link', async () => {
  const inserted = await db('customer_accounts').insert({
    email: 'digest-reset@example.com', password_hash: 'x', is_active: true,
    created_at: new Date().toISOString(),
  }).returning('id');
  const customerId = inserted[0]?.id ?? inserted[0];
  await customers.createPasswordReset({ customerId, requestedByAdminId: adminId });

  const queued = await db('email_queue').where({ email_type: 'customer_password_reset' })
    .orderBy('id', 'desc').first();
  const plaintext = decryptEmailData(queued.email_type, storedEmailData(queued), queued.recipient_email);
  const rawToken = plaintext.reset_link.split('/').pop();
  const digest = digestCapabilityToken(rawToken);
  const row = await db('customer_password_resets').where({ customer_account_id: customerId }).first();
  expect(row.token).toBe(digest);
  expect(row.token_digest).toBe(digest);
  expect(JSON.stringify(queued.email_data)).not.toContain(rawToken);
  expect(await customers.validatePasswordResetToken(rawToken)).toBeTruthy();
  expect(await customers.validatePasswordResetToken(digest)).toBeNull();
});

test('admin invitation cancellation and acceptance cannot both win', async () => {
  const created = await users.createInvitation({
    email: 'cancel-race-admin@example.com', roleId: editorRoleId,
    invitedById: adminId, inviterRoleName: 'super_admin',
  });
  const token = await mailedAdminInviteToken('cancel-race-admin@example.com');
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  const settled = await Promise.allSettled([
    users.acceptInvitation({
      token, username: 'cancel-race-admin', password: 'Password-Race-2026!',
    }),
    users.cancelInvitation(created.id, adminId),
  ]);
  expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const invitation = await db('admin_invitations').where({ id: created.id }).first();
  const account = await db('admin_users').where({ email: 'cancel-race-admin@example.com' }).first();
  if (account) {
    expect(invitation).toBeTruthy();
    expect(invitation.accepted_at).not.toBeNull();
  } else {
    expect(invitation).toBeUndefined();
  }
});
