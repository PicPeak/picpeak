/**
 * The contract designer (#1445) and the signing lifecycle (#1446) together.
 *
 * - A system-template revision published at boot carries the default
 *   declarations, and a contract made from it asks the signer for them.
 * - The pre-publication check reports a draft without a required
 *   declaration as a located finding (#1445 check, #1446 rule).
 * - A clause hidden by "Show only if" stays in the frozen, hashed snapshot
 *   beside the declarations and the legal notice; the signing page leaves it
 *   out, shows the declarations, and signing passes the content-hash check.
 *
 * Harness copied from contractSigningLifecycle.test.js.
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
let templatesApp;

const prevCwd = process.cwd();
const auth = { get Authorization() { return `Bearer ${token}`; } };

async function setFlag(key, value) {
  const updated = await db('feature_flags').where({ key }).update({ value });
  if (!updated) await db('feature_flags').insert({ key, value });
  require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
}

async function ok(req, status = [200, 201]) {
  const res = await req;
  if (!status.includes(res.status)) throw new Error(`${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

const sentCodes = [];

async function lastMail(type, to) {
  if (type === 'contract_signing_code') {
    const mail = [...sentCodes].reverse().find((m) => m.to === to);
    return mail ? mail.variables : null;
  }
  const row = await db('email_queue').where({ email_type: type, recipient_email: to }).orderBy('id', 'desc').first();
  if (!row) return null;
  return typeof row.email_data === 'string' ? JSON.parse(row.email_data) : row.email_data;
}

const linkToken = (mail) => mail.response_url.split('/').pop();

let ipCounter = 0;
const nextIp = () => {
  ipCounter += 1;
  return `198.51.100.${ipCounter % 250}`;
};
const asSigner = (req) => req.set('X-Forwarded-For', nextIp());
const sign = (session, body) => asSigner(request(signingApp).post('/api/public/contract-signing/session/sign'))
  .set('X-Signing-Session', session).send({ consents: [{ key: 'acceptance', accepted: true }], ...body });
const sessionView = async (session) => (await ok(asSigner(request(signingApp).get('/api/public/contract-signing/session'))
  .set('X-Signing-Session', session))).contract;

async function newContract(extra = {}) {
  const { contract } = await ok(request(contractsApp).post('/api/admin/contracts').set(auth)
    .send({ customerAccountId: customerId, ...extra }));
  return contract.id;
}

async function sendContract(id) {
  return ok(request(contractsApp).post(`/api/admin/contracts/${id}/send`).set(auth));
}

async function minuteLater() {
  const rows = await db('contract_signing_otps').select('id', 'created_at');
  for (const row of rows) {
    const at = new Date(row.created_at).getTime();
    if (Number.isFinite(at)) {
      await db('contract_signing_otps').where({ id: row.id })
        .update({ created_at: new Date(at - 61 * 1000).toISOString() });
    }
  }
}

async function verifiedSession(linkTok, email) {
  await minuteLater();
  await ok(asSigner(request(signingApp).post(`/api/public/contract-signing/invite/${linkTok}/code`)));
  const { code } = await lastMail('contract_signing_code', email);
  const verified = await ok(asSigner(request(signingApp).post(`/api/public/contract-signing/invite/${linkTok}/verify`)).send({ code }));
  return verified.sessionToken;
}

/** A sent single-signer contract and its first signer's session. */
async function sentWithSession(extra = {}) {
  const id = await newContract(extra);
  await sendContract(id);
  const session = await verifiedSession(linkToken(await lastMail('contract_sent', customerEmail)), customerEmail);
  return { id, session };
}

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  const emailProcessor = require('../../src/services/emailProcessor');
  jest.spyOn(emailProcessor, 'sendTemplateEmail').mockImplementation(async (to, templateKey, variables) => {
    if (templateKey !== 'contract_signing_code') throw new Error(`unexpected immediate email ${templateKey}`);
    sentCodes.push({ to, variables });
    return { success: true };
  });
  process.chdir(tmpDir);
  db.client.pool.acquireTimeoutMillis = 2000;
  ({ adminId, customerId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  await setFlag('contracts', true);
  await setFlag('quotes', true);
  customerEmail = (await db('customer_accounts').where({ id: customerId }).first()).email.toLowerCase();
  await db('customer_accounts').where({ id: customerId }).update({ first_name: 'Anna', last_name: 'Muster' });
  const profile = await db('business_profile').where({ id: 1 }).first();
  if (profile) await db('business_profile').where({ id: 1 }).update({ email: 'studio@example.com', company_name: 'Studio Test' });
  else await db('business_profile').insert({ id: 1, email: 'studio@example.com', company_name: 'Studio Test' });

  contractsApp = buildRouteApp('/api/admin/contracts', require('../../src/routes/adminContracts'));
  signingApp = buildRouteApp('/api/public/contract-signing', require('../../src/routes/publicContractSigning'));
  templatesApp = buildRouteApp('/api/admin/contract-templates', require('../../src/routes/adminContractTemplates'));
}, 120000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

const DEFAULT_WORDING = {
  en: 'I have read this contract and agree to be bound by its terms.',
  de: 'Ich habe diesen Vertrag gelesen und erkläre mich mit seinen Bedingungen einverstanden.',
};

test('a system revision published at boot carries the default declarations', async () => {
  const defaultTemplate = require('../../src/services/contract/defaultTemplate');
  await defaultTemplate.ensureDefaultTemplate();
  const system = await db('contract_templates').where({ is_system: true }).first();
  const before = await db('contract_template_versions').where({ template_id: system.id }).orderBy('version_number', 'desc').first();
  const next = await defaultTemplate.publishSystemRevision(system, defaultTemplate.SYSTEM_TEMPLATE_REVISION + 1);
  expect(next).toBe(Number(before.version_number) + 1);

  const version = await db('contract_template_versions').where({ template_id: system.id, version_number: next }).first();
  expect(version.status).toBe('published');
  expect(parsed(version.consents)).toEqual([{ key: 'acceptance', required: true, version: 1, text: DEFAULT_WORDING }]);
  // Not a backfilled row: this version's hash was computed with its declarations.
  expect(version.consents_backfilled_at == null).toBe(true);
  const api = await ok(request(templatesApp).get(`/api/admin/contract-templates/${system.id}/versions/${next}`).set(auth));
  expect(api.version.consents).toEqual([
    { key: 'acceptance', required: true, version: 1, text: DEFAULT_WORDING },
  ]);

  // A contract made from it asks its signer for exactly that.
  const { id, session } = await sentWithSession({ templateVersionId: version.id });
  const contract = await db('contracts').where({ id }).first();
  expect(parsed(contract.rendered_content).consents.map((c) => c.key)).toEqual(['acceptance']);
  const view = await sessionView(session);
  expect(view.consents.map((c) => [c.key, c.required])).toEqual([['acceptance', true]]);
  await ok(sign(session, { name: 'Anna Muster', mode: 'typed' }));
});

test('the pre-publication check reports a draft without a required declaration', async () => {
  const url = '/api/admin/contract-templates';
  const [block] = await db('contract_blocks').where({ is_active: true }).orderBy('id').limit(1);
  const created = await ok(request(templatesApp).post(url).set(auth).send({ name: `Check ${Date.now()}` }));
  const saved = await ok(request(templatesApp).put(`${url}/${created.template.id}/draft`).set(auth).send({
    lockVersion: created.template.lockVersion,
    items: [{ kind: 'block', blockId: block.id }],
    consents: [{ key: 'newsletter', required: false, text: { en: 'Send me news.' } }],
  }));
  const check = await ok(request(templatesApp).post(`${url}/${created.template.id}/publish-check`).set(auth));
  expect(check.ok).toBe(false);
  expect(check.findings).toContainEqual(expect.objectContaining({ code: 'CONSENT_REQUIRED_MISSING', severity: 'error' }));
  const refused = await request(templatesApp).post(`${url}/${created.template.id}/publish`).set(auth)
    .send({ lockVersion: saved.template.lockVersion });
  expect(refused.status).toBe(400);
  expect(refused.body.details.findings.map((f) => f.code)).toContain('CONSENT_REQUIRED_MISSING');
});

test('a hidden clause stays in the hashed snapshot beside the declarations; the signer sees neither it nor its heading', async () => {
  const { canonicalSha256 } = require('../../src/utils/canonicalJson');
  const id = await newContract();
  await ok(request(contractsApp).put(`/api/admin/contracts/${id}`).set(auth).send({
    textSections: [
      { section: 'closing', position: 1, heading: 'Nur mit Anlass', body: { de: '{{#if event_name}}Für {{event_name}}.{{/if}}', en: '{{#if event_name}}For {{event_name}}.{{/if}}' } },
      { section: 'closing', position: 2, heading: 'Schlusswort', body: { de: 'Danke.', en: 'Thank you.' } },
    ],
  }));
  await sendContract(id);
  const contract = await db('contracts').where({ id }).first();
  const snapshot = parsed(contract.rendered_content);
  // Frozen: the clause template (visibility follows from it), the
  // declarations and the legal notice — all under one hash.
  expect(snapshot.clauses.map((c) => c.name)).toEqual(expect.arrayContaining(['Nur mit Anlass', 'Schlusswort']));
  expect(snapshot.consents.map((c) => c.key)).toEqual(['acceptance']);
  expect(snapshot).toHaveProperty('legalNotice');
  expect(canonicalSha256(snapshot)).toBe(contract.rendered_content_sha256);

  const session = await verifiedSession(linkToken(await lastMail('contract_sent', customerEmail)), customerEmail);
  const view = await sessionView(session);
  const names = view.sections.flatMap((s) => s.blocks.map((b) => b.name));
  expect(names).toContain('Schlusswort');
  expect(names).not.toContain('Nur mit Anlass');
  expect(view.consents.map((c) => c.key)).toEqual(['acceptance']);
  expect(view.contentSha256).toBe(contract.rendered_content_sha256);

  // Signing re-hashes the frozen snapshot under the lock: it still matches.
  await ok(sign(session, { name: 'Anna Muster', mode: 'typed' }));
  const signer = await db('contract_signers').where({ contract_id: id, role: 'customer' }).first();
  expect(signer.status).toBe('signed');
  expect(signer.content_sha256).toBe(contract.rendered_content_sha256);
  const answers = await db('contract_signer_consents').where({ signer_id: signer.id });
  expect(answers.map((a) => [a.consent_key, !!a.accepted])).toEqual([['acceptance', true]]);
});
