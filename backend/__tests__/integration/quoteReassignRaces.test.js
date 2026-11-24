/**
 * A reopened quote moved to another customer while the old customer is still
 * using it.
 *
 * Routes and services -> SQLite with the full core-migration run
 * (helpers/crmDb). Each case runs the competing change at a fixed point
 * between the two steps it races, through a hook on a call made there.
 * Pins:
 *   - a portal answer is bound to the signed-in customer, also when the
 *     token lookup finds the link sent to the customer the quote moved to;
 *   - a public link read (view, unverified shell, totals, code request) that
 *     overlapped the move shows nothing of the new customer (410);
 *   - the portal view of a quote moved away meanwhile shows nothing (404);
 *   - a customer change is refused when the quote was attached to a project
 *     after it was read, and attaching is refused when the customer changed.
 */

jest.mock('../../src/utils/appSettings', () => {
  const real = jest.requireActual('../../src/utils/appSettings');
  return {
    ...real,
    getAppSetting: async (key, ...rest) => {
      const hook = global.__reassignSettingHook;
      if (hook && key === hook.key) {
        global.__reassignSettingHook = null;
        await hook.run();
      }
      return real.getAppSetting(key, ...rest);
    },
  };
});

jest.mock('../../src/services/accountingHistory', () => {
  const real = jest.requireActual('../../src/services/accountingHistory');
  return {
    ...real,
    auditedUpdate: async (conn, table, where, values, context = {}) => {
      const hook = global.__reassignAuditHook;
      if (hook && table === 'quotes' && String(context.source || '').startsWith('project.')) {
        global.__reassignAuditHook = null;
        await hook();
      }
      return real.auditedUpdate(conn, table, where, values, context);
    },
  };
});

const request = require('supertest');
const uuid = () => require('crypto').randomUUID();
const {
  bootCrmDb, seedMinimal, assignAdminRole, buildRouteApp, setFeatureFlags,
} = require('./helpers/crmDb');

jest.setTimeout(120000);

let db;
let cleanup;
let tmpDir;
let adminId;
let customerId;
let otherCustomerId;
let quoteService;
let projectService;
let views;
let publicApp;
let portal;
let viewHook = null;

const prevCwd = process.cwd();

async function insertId(table, row) {
  const [inserted] = await db(table).insert(row).returning('id');
  return inserted?.id ?? inserted;
}

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  ({ adminId, customerId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  await setFeatureFlags(db, { quotes: true });
  await require('../../src/utils/appSettings').upsertAppSetting('customer_feature_quotes_enabled', 'true', 'customer');
  otherCustomerId = await insertId('customer_accounts', {
    email: 'new-owner@example.com', display_name: 'New Owner', preferred_language: 'en', is_active: 1,
    created_at: new Date().toISOString(),
  });
  quoteService = require('../../src/services/quoteService');
  projectService = require('../../src/services/projectService');
  views = require('../../src/services/publicDocumentViews');
  // One hook point for every read the routes make between checking the link
  // (or the session's ownership) and answering. Installed before the routers
  // load, so a reference they keep goes through it too.
  for (const name of ['buildQuoteView', 'quoteVerificationTarget', 'usableQuoteTokens']) {
    const real = views[name];
    jest.spyOn(views, name).mockImplementation(async (...args) => {
      if (viewHook && viewHook.name === name) {
        const { run } = viewHook;
        viewHook = null;
        await run();
      }
      return real(...args);
    });
  }
  publicApp = buildRouteApp('/api/public/quotes', require('../../src/routes/publicQuotes'));
  portal = buildRouteApp('/api/customer', require('../../src/routes/customer'));
}, 120000);

afterAll(async () => {
  global.__reassignSettingHook = null;
  global.__reassignAuditHook = null;
  jest.restoreAllMocks();
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

const draft = () => quoteService.createQuote({
  customerAccountId: customerId, currency: 'CHF', vatRate: 0,
  lineItems: [{ position: 1, quantity: 1, description: 'Wedding day', unit_price_minor: 100000 }],
}, adminId);

// Reopened (edit -> draft), moved to the other customer and sent to them.
async function reassignAndResend(quoteId) {
  await quoteService.updateQuote(quoteId, { eventName: 'Reopened' }, adminId);
  await quoteService.updateQuote(quoteId, { customerAccountId: otherCustomerId }, adminId);
  return quoteService.sendQuote(quoteId, adminId);
}

const portalCookie = () => `customer_token=${require('jsonwebtoken').sign(
  { type: 'customer', customerId, jti: uuid() }, process.env.JWT_SECRET, { issuer: 'picpeak-auth', expiresIn: '1h' },
)}`;

async function grantFor(token) {
  const row = await db('quote_action_tokens').where({ token }).first();
  return require('../../src/services/publicDocumentVerificationService').issueGrant('quote', row, token);
}

let ipSeq = 0;
const nextIp = () => `198.51.100.${(ipSeq += 1)}`;

describe('portal answer', () => {
  test('is refused when the quote moved to another customer after the ownership check', async () => {
    const quoteId = await draft();
    await quoteService.sendQuote(quoteId, adminId);
    viewHook = { name: 'usableQuoteTokens', run: () => reassignAndResend(quoteId) };

    const res = await request(portal).post(`/api/customer/quotes/${quoteId}/respond`)
      .set('Cookie', portalCookie()).send({ action: 'accept' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('QUOTE_CHANGED');
    const row = await db('quotes').where({ id: quoteId }).first();
    expect(row.status).toBe('sent');
    expect(Number(row.customer_account_id)).toBe(otherCustomerId);
    expect(row.accepted_at).toBeNull();
  });

  test('the service refuses a token of a quote that is not the bound customer\'s', async () => {
    const quoteId = await draft();
    await quoteService.sendQuote(quoteId, adminId);
    const { token } = await reassignAndResend(quoteId);
    await expect(quoteService.recordResponse({ token, action: 'decline', customerAccountId: customerId }))
      .rejects.toMatchObject({ statusCode: 409, code: 'QUOTE_CHANGED' });
    expect((await db('quotes').where({ id: quoteId }).first()).status).toBe('sent');
  });
});

describe('public link reads', () => {
  test('the verified view that overlapped the move answers 410 without the new customer\'s data', async () => {
    const quoteId = await draft();
    const { token } = await quoteService.sendQuote(quoteId, adminId);
    const grant = await grantFor(token);
    viewHook = { name: 'buildQuoteView', run: () => reassignAndResend(quoteId) };

    const res = await request(publicApp).get(`/api/public/quotes/${token}`)
      .set('X-Document-Access', grant).set('X-Forwarded-For', nextIp());

    expect(res.status).toBe(410);
    expect(JSON.stringify(res.body)).not.toMatch(/New Owner|new-owner/);
  });

  test('the unverified shell that overlapped the move does not hint at the new customer\'s address', async () => {
    const quoteId = await draft();
    const { token } = await quoteService.sendQuote(quoteId, adminId);
    viewHook = { name: 'quoteVerificationTarget', run: () => reassignAndResend(quoteId) };

    const res = await request(publicApp).get(`/api/public/quotes/${token}`).set('X-Forwarded-For', nextIp());

    expect(res.status).toBe(410);
    expect(JSON.stringify(res.body)).not.toMatch(/ne\*+@|new-owner/);
  });

  test('a code request that overlapped the move mails nobody', async () => {
    const quoteId = await draft();
    const { token } = await quoteService.sendQuote(quoteId, adminId);
    viewHook = { name: 'quoteVerificationTarget', run: () => reassignAndResend(quoteId) };

    const res = await request(publicApp).post(`/api/public/quotes/${token}/verification`).set('X-Forwarded-For', nextIp());

    expect(res.status).toBe(410);
    const codes = await db('public_document_verification_codes').where({ document_kind: 'quote' })
      .whereIn('action_token_id', db('quote_action_tokens').where({ token }).select('id'));
    expect(codes).toHaveLength(0);
  });

  test('a view that did not overlap a move still answers', async () => {
    const quoteId = await draft();
    const { token } = await quoteService.sendQuote(quoteId, adminId);
    const res = await request(publicApp).get(`/api/public/quotes/${token}`)
      .set('X-Document-Access', await grantFor(token)).set('X-Forwarded-For', nextIp());
    expect(res.status).toBe(200);
    expect(res.body.data?.quote?.verificationRequired ?? res.body.quote?.verificationRequired).toBe(false);
  });
});

describe('portal view', () => {
  test('a view that overlapped the move shows nothing', async () => {
    const quoteId = await draft();
    await quoteService.sendQuote(quoteId, adminId);
    viewHook = { name: 'buildQuoteView', run: () => reassignAndResend(quoteId) };

    const res = await request(portal).get(`/api/customer/quotes/${quoteId}`).set('Cookie', portalCookie());

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toMatch(/New Owner|new-owner/);
  });
});

describe('project link', () => {
  const projectOf = (customer) => insertId('projects', {
    name: `Project ${uuid().slice(0, 8)}`, customer_account_id: customer, status: 'active',
    created_by: adminId, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });

  test('a customer change is refused when the quote was attached to the old customer\'s project meanwhile', async () => {
    const quoteId = await draft();
    const project = await projectOf(customerId);
    // Read by updateQuote before its transaction, after the quote was read.
    global.__reassignSettingHook = {
      key: 'crm_invoice_round_total',
      run: () => projectService.assignQuote(project, quoteId, { id: adminId }),
    };

    await expect(quoteService.updateQuote(quoteId, { customerAccountId: otherCustomerId }, adminId))
      .rejects.toMatchObject({ statusCode: 409, code: 'QUOTE_CHANGED' });

    const row = await db('quotes').where({ id: quoteId }).first();
    expect(Number(row.customer_account_id)).toBe(customerId);
    expect(Number(row.project_id)).toBe(project);
  });

  test('attaching is refused when the quote moved to another customer meanwhile', async () => {
    const quoteId = await draft();
    const project = await projectOf(customerId);
    global.__reassignAuditHook = () => quoteService.updateQuote(quoteId, { customerAccountId: otherCustomerId }, adminId);

    await expect(projectService.assignQuote(project, quoteId, { id: adminId }))
      .rejects.toMatchObject({ statusCode: 409, code: 'QUOTE_CHANGED' });

    const row = await db('quotes').where({ id: quoteId }).first();
    expect(Number(row.customer_account_id)).toBe(otherCustomerId);
    expect(row.project_id).toBeNull();
  });
});
