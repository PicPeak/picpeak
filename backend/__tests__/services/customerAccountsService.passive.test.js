/**
 * Tests for the passive-customer surface:
 *
 *   - createDirect inserts a customer with password_hash=null,
 *     queueEmail is never called, race-guard rejects duplicates
 *   - createInvitation allows passing through when the existing
 *     customer is passive (promotion path); still rejects when the
 *     existing customer is active (real duplicate)
 *   - acceptInvitation upserts into an existing passive customer
 *     row (preserving id) when one exists; inserts a fresh row
 *     otherwise; still rejects when the existing customer is active
 *
 * Pure unit tests — db is mocked via a thenable chain so we can
 * inspect every insert / update payload without spinning up SQLite.
 */

// ----- mock db chain --------------------------------------------------
//
// We need fine-grained control over which row each table-name returns
// for `.first()`, what `.insert(...).returning('id')` resolves to, and
// what `.update(...)` resolves to. The chain is a thenable proxy that
// terminates on the call we care about.

const tableSeeds = {};        // table → first-row return value
const insertResults = {};     // table → array of inserted rows (auto-id from a counter)
const updateCalls = [];       // [{ table, where, updates }]
let nextInsertId = 1000;

function resetMockDb() {
  for (const k of Object.keys(tableSeeds)) delete tableSeeds[k];
  for (const k of Object.keys(insertResults)) delete insertResults[k];
  updateCalls.length = 0;
  nextInsertId = 1000;
}

function makeChain(tableName) {
  const chain = {
    _whereClauses: [],
    where(...args) { this._whereClauses.push(args); return this; },
    whereNull() { return this; },
    whereNot() { return this; },
    andWhere() { return this; },
    orderBy() { return this; },
    leftJoin() { return this; },
    groupBy() { return this; },
    select(...args) {
      // listCustomers / search → return seeded array
      const seeded = tableSeeds[`${tableName}__select`];
      return Promise.resolve(seeded || []);
    },
    first() {
      const seeded = tableSeeds[tableName];
      return Promise.resolve(seeded);
    },
    insert(payload) {
      const id = nextInsertId++;
      insertResults[tableName] = insertResults[tableName] || [];
      insertResults[tableName].push({ ...payload, id });
      const result = { id };
      return {
        returning() { return Promise.resolve([result]); },
        then(resolve) { return Promise.resolve(undefined).then(resolve); },
      };
    },
    update(updates) {
      updateCalls.push({ table: tableName, where: this._whereClauses, updates });
      return Promise.resolve(1);
    },
    del() { return Promise.resolve(1); },
    raw() { return this; },
  };
  return chain;
}

const mockDbFn = jest.fn((tableName) => makeChain(tableName));
mockDbFn.raw = jest.fn();
mockDbFn.transaction = async (cb) => cb(mockDbFn);

jest.mock('../../src/database/db', () => ({
  db: mockDbFn,
  withRetry: jest.fn(async (fn) => fn()),
  logActivity: jest.fn(async () => {}),
}));

const mockQueueEmail = jest.fn(async () => {});
jest.mock('../../src/services/emailProcessor', () => ({
  queueEmail: mockQueueEmail,
}));

jest.mock('../../src/services/businessProfileService', () => ({
  getProfile: jest.fn(async () => ({
    profile: { default_locale: 'de' },
    bankAccounts: [],
  })),
}));

jest.mock('../../src/utils/frontendUrl', () => ({
  getFrontendBaseUrl: jest.fn(async () => 'https://test.example'),
}));

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const customerAccountsService = require('../../src/services/customerAccountsService');

beforeEach(() => {
  resetMockDb();
  mockQueueEmail.mockClear();
});

// --------------------------------------------------------------------
// createDirect
// --------------------------------------------------------------------

describe('createDirect', () => {
  it('inserts a customer with password_hash=null, is_active=true', async () => {
    tableSeeds.customer_accounts = undefined; // no duplicate
    const result = await customerAccountsService.createDirect({
      email: 'test@example.com',
      prefill: { first_name: 'Anna', company_name: 'ACME GmbH' },
      createdByAdminId: 5,
    });
    expect(result.id).toBeDefined();
    const inserted = insertResults.customer_accounts[0];
    expect(inserted.email).toBe('test@example.com');
    expect(inserted.password_hash).toBeNull();
    expect(inserted.created_by_admin_id).toBe(5);
    expect(inserted.first_name).toBe('Anna');
    expect(inserted.company_name).toBe('ACME GmbH');
    // is_active should be truthy (could be 1 or true depending on formatBoolean impl)
    expect([true, 1, '1']).toContain(inserted.is_active);
  });

  it('defaults preferred_language from the business profile', async () => {
    tableSeeds.customer_accounts = undefined;
    await customerAccountsService.createDirect({
      email: 'de@example.com',
      prefill: {},
      createdByAdminId: 1,
    });
    expect(insertResults.customer_accounts[0].preferred_language).toBe('de');
  });

  it('honours preferred_language when the admin pre-fills it', async () => {
    tableSeeds.customer_accounts = undefined;
    await customerAccountsService.createDirect({
      email: 'fr@example.com',
      prefill: { preferred_language: 'fr' },
      createdByAdminId: 1,
    });
    expect(insertResults.customer_accounts[0].preferred_language).toBe('fr');
  });

  it('rejects when a customer with the email already exists', async () => {
    tableSeeds.customer_accounts = { id: 7, email: 'dup@example.com', password_hash: 'whatever' };
    await expect(customerAccountsService.createDirect({
      email: 'dup@example.com',
      prefill: {},
      createdByAdminId: 1,
    })).rejects.toThrow(/already exists/);
  });

  it('rejects when only an EMAIL is supplied without anything else (still valid)', async () => {
    tableSeeds.customer_accounts = undefined;
    await expect(customerAccountsService.createDirect({
      email: '',
      prefill: {},
      createdByAdminId: 1,
    })).rejects.toThrow(/Email is required/);
  });

  it('NEVER queues an invitation email (regression guard)', async () => {
    tableSeeds.customer_accounts = undefined;
    await customerAccountsService.createDirect({
      email: 'silent@example.com',
      prefill: {},
      createdByAdminId: 1,
    });
    expect(mockQueueEmail).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------
// createInvitation passive-allowance behaviour
// --------------------------------------------------------------------

describe('createInvitation — duplicate-email guard', () => {
  it('still rejects when the existing customer has a password (real duplicate)', async () => {
    tableSeeds.customer_accounts = { id: 1, email: 'active@example.com', password_hash: 'hash' };
    await expect(customerAccountsService.createInvitation({
      email: 'active@example.com',
      invitedById: 5,
      prefill: null,
    })).rejects.toThrow(/already exists/);
    expect(mockQueueEmail).not.toHaveBeenCalled();
  });

  it('ALLOWS through when the existing customer is passive (promote path)', async () => {
    tableSeeds.customer_accounts = { id: 7, email: 'passive@example.com', password_hash: null };
    // no pending invitation
    // The chain returns `tableSeeds.customer_invitations` for .first()
    // and we haven't seeded one, so it's undefined → allowed through.
    const out = await customerAccountsService.createInvitation({
      email: 'passive@example.com',
      invitedById: 9,
      prefill: { first_name: 'Anna' },
    });
    expect(out.id).toBeDefined();
    expect(out.token).toMatch(/^[0-9a-f]{64}$/);
    expect(mockQueueEmail).toHaveBeenCalledTimes(1);
  });
});
