jest.mock('../../src/database/db', () => ({ db: jest.fn() }));
jest.mock('../../src/utils/appSettings', () => ({ getAppSetting: jest.fn(async () => null) }));
jest.mock('../../src/modules/photoSales/paymentSettings', () => ({
  ...jest.requireActual('../../src/modules/photoSales/paymentSettings'),
  credentials: jest.fn(), configurationOf: () => ({ checkout_configured: true, webhook_configured: true }),
}));
jest.mock('../../src/modules/photoSales/snipcartSettings', () => ({
  credentials: jest.fn(), configurationOf: () => ({ checkout_configured: true }),
}));

const stripe = require('../../src/modules/photoSales/paymentSettings');
const snipcart = require('../../src/modules/photoSales/snipcartSettings');
const providers = require('../../src/modules/photoSales/providers');

beforeEach(() => {
  providers.invalidateConfiguration();
  jest.clearAllMocks();
  stripe.credentials.mockResolvedValue({});
  snipcart.credentials.mockResolvedValue({ publicKey: 'public-store-key' });
});
afterEach(() => jest.restoreAllMocks());

it('coalesces concurrent public capability reads without caching credentials in the projection', async () => {
  const values = await Promise.all([providers.configuration(), providers.configuration(), providers.configuration()]);
  expect(stripe.credentials).toHaveBeenCalledTimes(1);
  expect(snipcart.credentials).toHaveBeenCalledTimes(1);
  expect(values[0]).toEqual({ available: ['stripe', 'snipcart'], preferred: 'stripe', snipcart_public_key: 'public-store-key' });
});

it('reads fresh capabilities inside reservation transactions', async () => {
  await providers.configuration();
  const transaction = jest.fn();
  await providers.configuration(transaction);
  await providers.configuration(transaction);
  expect(stripe.credentials).toHaveBeenCalledTimes(3);
  expect(stripe.credentials).toHaveBeenLastCalledWith(transaction);
});

it('expires the public cache and explicitly invalidates it after settings changes', async () => {
  let now = Date.now();
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  await providers.configuration();
  now += 5001;
  await providers.configuration();
  providers.invalidateConfiguration();
  await providers.configuration();
  expect(stripe.credentials).toHaveBeenCalledTimes(3);
});

it('does not retain a failed capability lookup', async () => {
  stripe.credentials.mockRejectedValueOnce(new Error('Temporary read failure'));
  await expect(providers.configuration()).rejects.toThrow('Temporary read failure');
  await expect(providers.configuration()).resolves.toMatchObject({ available: ['stripe', 'snipcart'] });
});
