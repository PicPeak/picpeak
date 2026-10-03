/**
 * Customer password resets and invitation acceptance claim their single-use
 * row inside the transaction, so of two racing submissions exactly one may
 * set credentials.
 *
 * Before: both flows validated the row (used_at / accepted_at IS NULL) before
 * bcrypt and before the transaction, then updated the account by id alone and
 * stamped the row by id alone. Two concurrent submissions both passed the
 * read, both committed, and the later one overwrote the password the first
 * had set. Cancelling an invitation deleted the row unconditionally, even
 * after an acceptance had committed. Scanner finding 4adb72b7.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const bcrypt = require('bcrypt');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-claim-races-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'claim-races-secret-with-32-chars!!!!';

jest.mock('../../src/services/emailProcessor', () => ({ queueEmail: jest.fn(async () => {}) }));
jest.mock('../../src/services/workflows', () => ({ emitWorkflowEvent: jest.fn(async () => {}) }));

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

let db; let cleanup; let adminId; let service;
// Epoch milliseconds, the shape the service itself stores on SQLite.
const future = () => Date.now() + 86400000;
const hex = () => crypto.randomBytes(32).toString('hex');

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  // Under Jest the sqlite3 binding does not recognise sandbox-created Dates
  // (CLAUDE.md: they land as the string "[object Object]"), so the service's
  // `expires_at > new Date()` reads would never match. Bind Dates as epoch
  // milliseconds, which is what the binding does in production. Patched on
  // the prototype because knex builds each transaction's client from it.
  const proto = db.client.constructor.prototype;
  const prepBindings = proto.prepBindings;
  proto.prepBindings = function (bindings) {
    const prepared = prepBindings.call(this, bindings);
    if (!Array.isArray(prepared)) return prepared;
    return prepared.map((v) => (Object.prototype.toString.call(v) === '[object Date]' ? v.getTime() : v));
  };
  ({ adminId } = await seedMinimal(db));
  service = require('../../src/services/customerAccountsService');
}, 120000);
afterAll(async () => {
  await require('../../src/services/serviceShutdown').stopServices();
  if (cleanup) await cleanup();
});

const outcomes = (settled) => ({
  ok: settled.filter((r) => r.status === 'fulfilled'),
  failed: settled.filter((r) => r.status === 'rejected'),
});

describe('applyPasswordReset', () => {
  async function seedReset(email) {
    const [cid] = await db('customer_accounts').insert({
      email, display_name: 'R', password_hash: await bcrypt.hash('old-pass', 4), is_active: 1,
      created_at: new Date().toISOString(),
    }).returning('id');
    const customerId = cid?.id ?? cid;
    const token = hex();
    await db('customer_password_resets').insert({ token, customer_account_id: customerId, expires_at: future(), created_at: new Date().toISOString() });
    return { customerId, token };
  }

  it('lets exactly one of two concurrent submissions set the password', async () => {
    const { customerId, token } = await seedReset('race-reset@example.com');
    const settled = await Promise.allSettled([
      service.applyPasswordReset({ token, password: 'First-Password-1' }),
      service.applyPasswordReset({ token, password: 'Second-Password-2' }),
    ]);
    const { ok, failed } = outcomes(settled);
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason.statusCode).toBe(400);

    const row = await db('customer_accounts').where({ id: customerId }).first();
    const winner = settled[0].status === 'fulfilled' ? 'First-Password-1' : 'Second-Password-2';
    expect(await bcrypt.compare(winner, row.password_hash)).toBe(true);
    const reset = await db('customer_password_resets').where({ token }).first();
    expect(reset.used_at).not.toBeNull();
  });

  it('still refuses a sequential replay of a used link', async () => {
    const { token } = await seedReset('replay-reset@example.com');
    await service.applyPasswordReset({ token, password: 'First-Password-1' });
    await expect(service.applyPasswordReset({ token, password: 'Second-Password-2' }))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('acceptInvitation', () => {
  async function seedPassiveInvite(email) {
    const [cid] = await db('customer_accounts').insert({
      email, display_name: 'Passive', password_hash: null, is_active: 1, created_at: new Date().toISOString(),
    }).returning('id');
    const customerId = cid?.id ?? cid;
    const token = hex();
    const [iid] = await db('customer_invitations').insert({
      email, token, invited_by: adminId, expires_at: future(), created_at: new Date().toISOString(),
    }).returning('id');
    return { customerId, token, invitationId: iid?.id ?? iid };
  }

  it('lets exactly one of two concurrent acceptances promote a passive customer', async () => {
    const { customerId, token, invitationId } = await seedPassiveInvite('race-invite@example.com');
    const settled = await Promise.allSettled([
      service.acceptInvitation({ token, name: 'A', password: 'First-Password-1' }),
      service.acceptInvitation({ token, name: 'B', password: 'Second-Password-2' }),
    ]);
    const { ok, failed } = outcomes(settled);
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(ok[0].value.customerId).toBe(customerId);

    const row = await db('customer_accounts').where({ id: customerId }).first();
    const winner = settled[0].status === 'fulfilled' ? 'First-Password-1' : 'Second-Password-2';
    expect(await bcrypt.compare(winner, row.password_hash)).toBe(true);
    const invitation = await db('customer_invitations').where({ id: invitationId }).first();
    expect(invitation.accepted_at).not.toBeNull();
    expect(invitation.accepted_customer_id).toBe(customerId);
  });

  it('does not promote a customer who gained a password since the invitation was read', async () => {
    const { customerId, token } = await seedPassiveInvite('promoted-meanwhile@example.com');
    // The same invitation accepted through another path first.
    await service.acceptInvitation({ token, name: 'A', password: 'First-Password-1' });
    await expect(service.acceptInvitation({ token, name: 'B', password: 'Second-Password-2' }))
      .rejects.toMatchObject({ statusCode: 400 });
    const row = await db('customer_accounts').where({ id: customerId }).first();
    expect(await bcrypt.compare('First-Password-1', row.password_hash)).toBe(true);
  });

  it('cancellation refuses an invitation that was accepted in the meantime', async () => {
    const { token, invitationId } = await seedPassiveInvite('cancel-after-accept@example.com');
    await service.acceptInvitation({ token, name: 'A', password: 'First-Password-1' });
    await expect(service.cancelInvitation(invitationId, adminId)).rejects.toMatchObject({ statusCode: 409 });
    expect(await db('customer_invitations').where({ id: invitationId }).first()).toBeDefined();
  });

  it('cancellation still removes a pending invitation', async () => {
    const { invitationId } = await seedPassiveInvite('cancel-pending@example.com');
    await service.cancelInvitation(invitationId, adminId);
    expect(await db('customer_invitations').where({ id: invitationId }).first()).toBeUndefined();
  });
});
