/**
 * What erasing a customer does to their contracts (#1446, plan slice 1c).
 *
 * Erasure used to anonymise `customer_accounts` and stop there: a live
 * signing link on an unsigned contract kept working, and the customer's name
 * and address stayed in the frozen `rendered_content` of a contract nobody
 * had signed. The rule now (services/contract/erasure.js):
 *
 *   - no signature yet  → cancelled, redacted, every way in revoked;
 *   - no signature, already declined or cancelled → redacted and revoked the
 *     same way, its status left as it is;
 *   - at least one signature → kept whole as the contractual record, but the
 *     live invitations and sessions are revoked all the same.
 */

const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

jest.setTimeout(120000);

const parsed = (value) => (typeof value === 'string' ? JSON.parse(value) : value);

let db;
let cleanup;
let tmpDir;
let adminId;
let customerId;
let customerEmail;
let token;
let contractsApp;
let signingApp;

const prevCwd = process.cwd();
const auth = { get Authorization() { return `Bearer ${token}`; } };
const sentCodes = [];

let ipCounter = 0;
const asSigner = (req) => {
  ipCounter += 1;
  return req.set('X-Forwarded-For', `203.0.113.${ipCounter % 250}`);
};

async function ok(req, status = [200, 201]) {
  const res = await req;
  if (!status.includes(res.status)) throw new Error(`${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

async function queuedMail(type, to) {
  const row = await db('email_queue').where({ email_type: type, recipient_email: to }).orderBy('id', 'desc').first();
  return row ? parsed(row.email_data) : null;
}

const linkToken = (mail) => mail.response_url.split('/').pop();

/** A contract sent to the seeded customer, and the signer's live link. */
async function sentContract() {
  const { contract } = await ok(request(contractsApp).post('/api/admin/contracts').set(auth).send({ customerAccountId: customerId }));
  await ok(request(contractsApp).post(`/api/admin/contracts/${contract.id}/send`).set(auth));
  return { id: contract.id, link: linkToken(await queuedMail('contract_sent', customerEmail)) };
}

/** Link → code → session, the way a signer gets in. */
async function verifiedSession(link) {
  // The suite sends more than one code a minute; move the earlier ones back.
  for (const row of await db('contract_signing_otps').select('id', 'created_at')) {
    const at = new Date(row.created_at).getTime();
    if (Number.isFinite(at)) {
      await db('contract_signing_otps').where({ id: row.id }).update({ created_at: new Date(at - 61 * 1000).toISOString() });
    }
  }
  await ok(asSigner(request(signingApp).post(`/api/public/contract-signing/invite/${link}/code`)));
  const { code } = sentCodes[sentCodes.length - 1].variables;
  const verified = await ok(asSigner(request(signingApp).post(`/api/public/contract-signing/invite/${link}/verify`)).send({ code }));
  return verified.sessionToken;
}

const state = {};

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  const emailProcessor = require('../../src/services/emailProcessor');
  jest.spyOn(emailProcessor, 'sendTemplateEmail').mockImplementation(async (to, templateKey, variables) => {
    sentCodes.push({ to, templateKey, variables });
    return { success: true };
  });
  process.chdir(tmpDir);
  db.client.pool.acquireTimeoutMillis = 2000;
  ({ adminId, customerId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  const flag = await db('feature_flags').where({ key: 'contracts' }).first();
  if (flag) await db('feature_flags').where({ key: 'contracts' }).update({ value: true });
  else await db('feature_flags').insert({ key: 'contracts', value: true });
  require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();

  const profile = await db('business_profile').where({ id: 1 }).first();
  const columns = { email: 'studio@example.com', company_name: 'Studio Test' };
  if (profile) await db('business_profile').where({ id: 1 }).update(columns);
  else await db('business_profile').insert({ id: 1, ...columns });

  await db('customer_accounts').where({ id: customerId }).update({
    first_name: 'Anna', last_name: 'Muster', address_line1: 'Bahnhofstrasse 1', postal_code: '8001', city: 'Zürich',
  });
  customerEmail = (await db('customer_accounts').where({ id: customerId }).first()).email.toLowerCase();

  contractsApp = buildRouteApp('/api/admin/contracts', require('../../src/routes/adminContracts'));
  signingApp = buildRouteApp('/api/public/contract-signing', require('../../src/routes/publicContractSigning'));

  // One contract nobody has signed, and one the customer has.
  state.unsigned = await sentContract();
  state.signed = await sentContract();
  const session = await verifiedSession(state.signed.link);
  await ok(asSigner(request(signingApp).post('/api/public/contract-signing/session/sign'))
    .set('X-Signing-Session', session)
    .send({ name: 'Anna Muster', mode: 'typed', accepted: true }));
  state.signedSession = session;
  state.unsignedSession = await verifiedSession(state.unsigned.link);

  // Two that ended without anyone signing: one the customer declined, one
  // the studio cancelled.
  state.declined = await sentContract();
  await ok(asSigner(request(signingApp).post('/api/public/contract-signing/session/decline'))
    .set('X-Signing-Session', await verifiedSession(state.declined.link))
    .send({ reason: 'Anna Muster found another studio' }));
  state.cancelled = await sentContract();
  state.cancelledSession = await verifiedSession(state.cancelled.link);
  await ok(request(contractsApp).post(`/api/admin/contracts/${state.cancelled.id}/cancel`).set(auth));

  // And one that was signed and then ended up cancelled: the signature makes
  // it the record, whatever its status says.
  state.signedCancelled = await sentContract();
  await ok(asSigner(request(signingApp).post('/api/public/contract-signing/session/sign'))
    .set('X-Signing-Session', await verifiedSession(state.signedCancelled.link))
    .send({ name: 'Anna Muster', mode: 'typed', accepted: true }));
  await db('contracts').where({ id: state.signedCancelled.id }).update({ status: 'cancelled' });

  const contractRow = (id) => db('contracts').where({ id }).first();
  state.beforeErase = {
    unsigned: await contractRow(state.unsigned.id),
    signed: await contractRow(state.signed.id),
    declined: await contractRow(state.declined.id),
    cancelled: await contractRow(state.cancelled.id),
    signedCancelled: await contractRow(state.signedCancelled.id),
  };
  state.eventsBefore = {};
  for (const key of ['declined', 'cancelled']) {
    state.eventsBefore[key] = await db('contract_signing_events')
      .where({ contract_id: state[key].id }).orderBy('id').select('id', 'event_type', 'actor_label', 'event_hash');
  }

  await require('../../src/services/customerAccountsService').eraseCustomer(customerId, adminId);
}, 120000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

test('the frozen snapshot of an unsigned contract holds the customer\'s data before erasure', () => {
  // The fixture the next test depends on: without this, "the name is gone"
  // would pass on a contract that never carried it.
  const snapshot = parsed(state.beforeErase.unsigned.rendered_content);
  expect(snapshot.placeholders.customer_name).toContain('Anna');
  expect(snapshot.placeholders.customer_address).toContain('Bahnhofstrasse');
});

test('an unsigned contract is cancelled and redacted', async () => {
  const contract = await db('contracts').where({ id: state.unsigned.id }).first();
  expect(contract.status).toBe('cancelled');

  const snapshot = parsed(contract.rendered_content);
  expect(snapshot.placeholders.customer_name).toBe('');
  expect(snapshot.placeholders.customer_address).toBe('');
  // The clauses are the contract's own text, not the customer's data.
  expect(snapshot.clauses.length).toBeGreaterThan(0);
  expect(JSON.stringify(snapshot)).not.toContain('Bahnhofstrasse');

  // The hash stays as it was — it is what a signer would have been bound to.
  // The redaction is recorded next to it instead of rewritten into it.
  expect(contract.rendered_content_sha256).toBe(state.beforeErase.unsigned.rendered_content_sha256);
  expect(contract.rendered_content_redacted_at).toBeTruthy();
});

test('every way into an unsigned contract stops working', async () => {
  const invite = await request(signingApp).get(`/api/public/contract-signing/invite/${state.unsigned.link}`);
  expect(invite.status).toBe(410);
  const session = await request(signingApp).get('/api/public/contract-signing/session')
    .set('X-Signing-Session', state.unsignedSession);
  expect(session.status).toBe(401);

  const rows = await db('contract_signers').where({ contract_id: state.unsigned.id });
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.name_enc).toBeNull();
    expect(row.email_enc).toBeNull();
    expect(row.email_hash).toBeNull();
    expect(row.ip_enc).toBeNull();
    expect(row.user_agent_enc).toBeNull();
  }

  const revoked = await db('contract_signing_events')
    .where({ contract_id: state.unsigned.id, event_type: 'revoked' }).first();
  expect(parsed(revoked.payload).reason).toBe('customer_erased');
  // The chain still verifies after the cancellation event.
  expect(await require('../../src/services/contract/signingEvents').verifyChain(state.unsigned.id))
    .toEqual(expect.objectContaining({ ok: true }));
});

test('a signed contract is kept whole, and only its live access is revoked', async () => {
  const contract = await db('contracts').where({ id: state.signed.id }).first();
  expect(contract.status).toBe('signed_by_customer');
  expect(contract.rendered_content).toBe(state.beforeErase.signed.rendered_content);
  expect(contract.rendered_content_redacted_at).toBeFalsy();

  // The evidence of who signed is the record; it stays.
  const signer = await db('contract_signers').where({ contract_id: state.signed.id, role: 'customer' }).first();
  expect(signer.status).toBe('signed');
  expect(signer.name_enc).toMatch(/^v1:/);
  expect(require('../../src/utils/fieldEncryption').tryDecrypt(signer.name_enc)).toBe('Anna Muster');

  // …but the customer's own way back in does not.
  expect((await request(signingApp).get(`/api/public/contract-signing/invite/${state.signed.link}`)).status).toBe(410);
  expect((await request(signingApp).get('/api/public/contract-signing/session')
    .set('X-Signing-Session', state.signedSession)).status).toBe(401);
});

test.each(['declined', 'cancelled'])('a %s contract nobody signed is redacted, its status left as it is', async (key) => {
  // The fixture: before erasure the snapshot and the signer carry the data.
  const before = state.beforeErase[key];
  expect(before.status).toBe(key);
  expect(parsed(before.rendered_content).placeholders.customer_name).toContain('Anna');

  const contract = await db('contracts').where({ id: state[key].id }).first();
  expect(contract.status).toBe(key);
  const snapshot = parsed(contract.rendered_content);
  expect(snapshot.placeholders.customer_name).toBe('');
  expect(snapshot.placeholders.customer_address).toBe('');
  expect(JSON.stringify(snapshot)).not.toContain('Bahnhofstrasse');
  expect(contract.rendered_content_sha256).toBe(before.rendered_content_sha256);
  expect(contract.rendered_content_redacted_at).toBeTruthy();

  const rows = await db('contract_signers').where({ contract_id: state[key].id });
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.name_enc).toBeNull();
    expect(row.email_enc).toBeNull();
    expect(row.email_hash).toBeNull();
    expect(row.ip_enc).toBeNull();
    expect(row.user_agent_enc).toBeNull();
    expect(row.decline_reason_enc).toBeNull();
  }

  // The event log is left as it was: every earlier event unchanged, labels
  // included, and the chain still verifies.
  const events = await db('contract_signing_events')
    .where({ contract_id: state[key].id }).orderBy('id').select('id', 'event_type', 'actor_label', 'event_hash');
  expect(events.slice(0, state.eventsBefore[key].length)).toEqual(state.eventsBefore[key]);
  expect(await require('../../src/services/contract/signingEvents').verifyChain(state[key].id))
    .toEqual(expect.objectContaining({ ok: true }));
});

test('the link of a cancelled contract nobody signed stays dead after erasure', async () => {
  expect((await request(signingApp).get(`/api/public/contract-signing/invite/${state.cancelled.link}`)).status).toBe(410);
  expect((await request(signingApp).get('/api/public/contract-signing/session')
    .set('X-Signing-Session', state.cancelledSession)).status).toBe(401);
});

test('a signed contract that was later cancelled is kept whole', async () => {
  const contract = await db('contracts').where({ id: state.signedCancelled.id }).first();
  expect(contract.status).toBe('cancelled');
  expect(contract.rendered_content).toBe(state.beforeErase.signedCancelled.rendered_content);
  expect(contract.rendered_content_redacted_at).toBeFalsy();
  const signer = await db('contract_signers').where({ contract_id: state.signedCancelled.id, role: 'customer' }).first();
  expect(require('../../src/utils/fieldEncryption').tryDecrypt(signer.name_enc)).toBe('Anna Muster');
  expect(signer.email_hash).toBeTruthy();
});

test('the erasure log names what was cancelled, redacted and kept', async () => {
  const row = await db('activity_logs').where({ activity_type: 'customer_erased' }).orderBy('id', 'desc').first();
  const meta = parsed(row.metadata);
  expect(meta.cancelledContracts).toEqual([state.unsigned.id]);
  expect(meta.redactedContracts).toEqual([state.declined.id, state.cancelled.id]);
  expect(meta.retainedContracts).toEqual([state.signed.id, state.signedCancelled.id]);
});
