/**
 * Customer portal dashboard "Needs action" list — issue 1590.
 *
 * A contract in `awaiting_data` (collect-details-before-freeze, #1446 —
 * backend/src/services/contract/dataCollection.js) already offers
 * `canCompleteDetails: true` in GET /customer/contracts (customer.js:785),
 * but the dashboard's needsActionFor() only ever looked at
 * ['sent', 'signed_by_admin'], so a customer who only checks the dashboard
 * was never told their details were waited on.
 *
 * Pin: needsActionFor() surfaces an awaiting_data / signing_version 2
 * contract as a `contractDetails` item, and does NOT surface one whose
 * signing_version isn't 2 — the exact same guard as canCompleteDetails.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-portal-dash-needsaction-'));
process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'db.sqlite');
process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
fs.mkdirSync(process.env.STORAGE_PATH, { recursive: true });
process.env.JWT_SECRET = process.env.JWT_SECRET || 'crm-route-test-secret';

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

describe('customer portal dashboard needs-action (issue 1590)', () => {
  let db;
  let cleanup;
  let customerId;
  let customerPortalService;
  let customerAccountsService;

  const nowIso = () => new Date().toISOString();
  const insertId = async (table, row) => {
    const inserted = await db(table).insert(row).returning('id');
    return inserted[0]?.id ?? inserted[0];
  };
  const contract = (overrides) => insertId('contracts', {
    customer_account_id: customerId,
    language: 'de',
    issue_date: nowIso().slice(0, 10),
    created_at: nowIso(),
    ...overrides,
  });

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ customerId } = await seedMinimal(db));
    await db('customer_accounts').where({ id: customerId }).update({ feature_contracts: true });
    const flag = await db('feature_flags').where({ key: 'contracts' }).first();
    if (flag) await db('feature_flags').where({ key: 'contracts' }).update({ value: true });
    else await db('feature_flags').insert({ key: 'contracts', value: true });

    // Same db instance as the services below — required by bootCrmDb.
    customerPortalService = require('../../src/services/customerPortalService');
    customerAccountsService = require('../../src/services/customerAccountsService');
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('surfaces an awaiting_data, signing_version 2 contract as contractDetails', async () => {
    const waiting = await contract({
      contract_number: 'K-NA-1', title: 'Waiting Contract', status: 'awaiting_data', signing_version: 2,
    });

    const features = await customerAccountsService.getEffectiveFeaturesForCustomer(customerId);
    const needsAction = await customerPortalService._internal.needsActionFor(customerId, features);

    expect(needsAction.contractDetails).toHaveLength(1);
    expect(needsAction.contractDetails[0]).toMatchObject({
      id: waiting, contractNumber: 'K-NA-1', title: 'Waiting Contract',
    });
    // Not double-listed under the signature-needed bucket.
    expect(needsAction.contracts.find((c) => c.id === waiting)).toBeUndefined();

    // Same item, reached through the actual dashboard entry point.
    const dashboard = await customerPortalService.getDashboard(customerId);
    expect(dashboard.needsAction.contractDetails.map((c) => c.id)).toEqual([waiting]);
  });

  it('does not surface an awaiting_data contract whose signing_version is not 2', async () => {
    await contract({
      contract_number: 'K-NA-2', title: 'Legacy Waiting Contract', status: 'awaiting_data', signing_version: 1,
    });
    await contract({
      contract_number: 'K-NA-3', title: 'No Version Contract', status: 'awaiting_data', signing_version: null,
    });

    const features = await customerAccountsService.getEffectiveFeaturesForCustomer(customerId);
    const needsAction = await customerPortalService._internal.needsActionFor(customerId, features);

    const numbers = needsAction.contractDetails.map((c) => c.contractNumber);
    expect(numbers).not.toContain('K-NA-2');
    expect(numbers).not.toContain('K-NA-3');
  });
});
