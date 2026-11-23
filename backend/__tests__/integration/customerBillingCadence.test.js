/**
 * Saving a customer's billing cadence through customerAccountsService.
 *
 * Real service → SQLite with the full core-migration run (helpers/crmDb).
 * The route validator and the customer form offer 'manual'; the service's
 * whitelist used to coerce it to 'per_event', so it could not be saved.
 */

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

jest.setTimeout(120000);

let db;
let cleanup;
let tmpDir;
let adminId;
let customerId;
let customerAccountsService;

const prevCwd = process.cwd();

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  ({ adminId, customerId } = await seedMinimal(db));
  customerAccountsService = require('../../src/services/customerAccountsService');
}, 120000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

async function cadence() {
  const row = await db('customer_accounts').where({ id: customerId }).first('billing_cadence');
  return row.billing_cadence;
}

describe('updateCustomer billing_cadence', () => {
  it.each(['manual', 'monthly', 'quarterly', 'per_event'])('saves %s', async (value) => {
    await customerAccountsService.updateCustomer(customerId, { billing_cadence: value }, adminId);
    expect(await cadence()).toBe(value);
  });

  it('still coerces an unknown cadence to per_event', async () => {
    await customerAccountsService.updateCustomer(customerId, { billing_cadence: 'manual' }, adminId);
    await customerAccountsService.updateCustomer(customerId, { billing_cadence: 'weekly' }, adminId);
    expect(await cadence()).toBe('per_event');
  });
});
