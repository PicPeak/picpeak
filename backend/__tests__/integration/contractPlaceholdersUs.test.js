/**
 * Contract placeholders from a US business: {{issuer_address}} and
 * {{customer_address}} read "Denver, CO 80202" and the dates read month first.
 * A business elsewhere fills them in exactly as before.
 */

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

jest.setTimeout(120000);

let db;
let cleanup;
let customerId;
let buildPlaceholderContext;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ customerId } = await seedMinimal(db));
  ({ buildPlaceholderContext } = require('../../src/services/contract/renderContext'));
  await db('customer_accounts').where({ id: customerId }).update({
    first_name: 'Jordan', last_name: 'Rivera', address_line1: '1200 Lincoln St',
    postal_code: '80203', city: 'Denver', state: 'CO', country_code: 'US',
  });
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

const contract = { event_date: new Date(2026, 10, 27), issue_date: new Date(2026, 9, 28) };
const customer = () => db('customer_accounts').where({ id: customerId }).first();

describe('a US business', () => {
  beforeAll(async () => {
    await db('business_profile').where({ id: 1 }).update({
      company_name: 'Example Photo Co.', address_line1: '123 Main St',
      postal_code: '80202', city: 'Denver', state: 'CO', country_code: 'US',
    });
  });

  test('writes both addresses with city, state and ZIP', async () => {
    const values = await buildPlaceholderContext(contract, await customer());
    expect(values.issuer_address).toBe('123 Main St, Denver, CO 80202');
    expect(values.customer_address).toBe('1200 Lincoln St, Denver, CO 80203');
  });

  test('writes dates month first', async () => {
    const values = await buildPlaceholderContext(contract, await customer());
    expect(values.event_date).toBe('11/27/2026');
    expect(values.issue_date).toBe('10/28/2026');
  });
});

describe('a business elsewhere', () => {
  beforeAll(async () => {
    await db('business_profile').where({ id: 1 }).update({
      company_name: 'Studio Test', address_line1: 'Weg 1', postal_code: '9490', city: 'Vaduz', state: null, country_code: 'LI',
    });
  });

  test('keeps its address and date format', async () => {
    const values = await buildPlaceholderContext(contract, await customer());
    expect(values.issuer_address).toBe('Weg 1, 9490, Vaduz');
    expect(values.event_date).toBe('27.11.2026');
  });
});
