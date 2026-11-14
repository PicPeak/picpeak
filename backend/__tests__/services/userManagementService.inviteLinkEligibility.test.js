/**
 * Admin invitations: the token reaches only the invited mailbox, and an
 * account created by accepting one does not take over an IdP identity by
 * email until a Super Admin confirms the address.
 *
 * createInvitation returned the raw token to the inviter, and acceptInvitation
 * left email_link_eligible at its TRUE default, so a first SSO login with the
 * invited address linked onto whatever account accepted the invitation.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// Built per run: random bytes plus one character of each class the strength
// rule asks for, so the repo holds no fixed login value.
function freshLoginSecret() {
  return [crypto.randomBytes(12).toString('hex'), 'A', 'a', '7', '#'].join('');
}

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-invitelink-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'invitelink-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-invitelink-storage-'));

const { bootCrmDb, seedMinimal, assignAdminRole } = require('../integration/helpers/crmDb');
const svc = require('../../src/services/userManagementService');
const { resolveAdminFromClaims } = require('../../src/services/oidcService');
const { clearPermissionCache } = require('../../src/middleware/permissions');
const { decryptEmailData } = require('../../src/utils/emailQueueEncryption');

let db; let cleanup; let superId; let editorRoleId;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  // Jest's VM creates Date objects from another realm; sqlite3 otherwise
  // binds service-created expiries as "[object Object]".
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
  ({ adminId: superId } = await seedMinimal(db));
  await assignAdminRole(db, superId, 'super_admin');
  editorRoleId = (await db('roles').where({ name: 'editor' }).first()).id;
  clearPermissionCache();
}, 120000);

afterAll(async () => { if (cleanup) await cleanup(); });

async function mailedToken(email) {
  const row = await db('email_queue')
    .where({ recipient_email: email, email_type: 'admin_invitation' })
    .orderBy('id', 'desc')
    .first();
  const stored = typeof row.email_data === 'string' ? JSON.parse(row.email_data) : row.email_data;
  const data = decryptEmailData(row.email_type, stored, row.recipient_email);
  return data.invite_link.split('/invite/')[1];
}

describe('admin invitations and SSO email linking', () => {
  it('does not hand the invitation token to the inviter', async () => {
    const invitation = await svc.createInvitation({
      email: 'invited-a@example.com', roleId: editorRoleId, invitedById: superId, inviterRoleName: 'super_admin',
    });
    expect(invitation).not.toHaveProperty('token');
    expect(invitation).toEqual(expect.objectContaining({ email: 'invited-a@example.com' }));
    // The mailed link still carries a working token.
    const token = await mailedToken('invited-a@example.com');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const check = await svc.validateInvitationToken(token);
    expect(check).toBeTruthy();
  });

  it('creates the account without SSO email linking until a Super Admin confirms it', async () => {
    await svc.createInvitation({
      email: 'invited-b@example.com', roleId: editorRoleId, invitedById: superId, inviterRoleName: 'super_admin',
    });
    const token = await mailedToken('invited-b@example.com');
    const { userId } = await svc.acceptInvitation({ token, username: 'invited_b', password: freshLoginSecret() });

    const row = await db('admin_users').where({ id: userId }).first();
    expect([false, 0]).toContain(row.email_link_eligible);

    await expect(resolveAdminFromClaims({
      iss: 'https://idp.example.test', sub: 'idp-subject-b', email: 'invited-b@example.com', email_verified: true,
    })).rejects.toMatchObject({ code: 'OIDC_EMAIL_UNVERIFIED' });
    const after = await db('admin_users').where({ id: userId }).first();
    expect(after.external_subject).toBeNull();

    // Confirming the address (a Super Admin saving it unchanged) re-opens the link.
    await svc.updateAdminUser(userId, { email: 'invited-b@example.com' }, superId, { roleName: 'super_admin' });
    const linked = await resolveAdminFromClaims({
      iss: 'https://idp.example.test', sub: 'idp-subject-b', email: 'invited-b@example.com', email_verified: true,
    });
    expect(Number(linked.id)).toBe(Number(userId));
  });
});
