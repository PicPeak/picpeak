/**
 * The date under each signature stamped onto a contract (issue 2445). It
 * follows Settings → General's date format; with none stored, a UK business
 * gets day/month/year and every other business day.month.year, as before.
 */

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

jest.setTimeout(120000);

let db;
let cleanup;
let readDateFormat;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  await seedMinimal(db);
  ({ readDateFormat } = require('../../src/services/contract/signingV2')._internal);
  await db('app_settings').where({ setting_key: 'general_date_format' }).del();
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

const setCountry = (countryCode) => db('business_profile').where({ id: 1 }).update({ country_code: countryCode });

test('a UK business with no date format set stamps day/month/year', async () => {
  await setCountry('GB');
  expect(await readDateFormat()).toEqual({ format: 'DD/MM/YYYY' });
});

test('a business elsewhere keeps day.month.year', async () => {
  await setCountry('LI');
  expect(await readDateFormat()).toEqual({ format: 'DD.MM.YYYY' });
});

test('a date format chosen in Settings wins in the UK too', async () => {
  await setCountry('GB');
  await db('app_settings').insert({
    setting_key: 'general_date_format', setting_value: JSON.stringify({ format: 'YYYY-MM-DD' }), setting_type: 'general',
  });
  expect(await readDateFormat()).toMatchObject({ format: 'YYYY-MM-DD' });
});
