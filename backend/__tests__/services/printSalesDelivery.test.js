'use strict';
const { configuration, selection } = require('../../src/services/printSales/delivery');
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const input = () => ({ shippingZones: [
  { id: uuid(1), name: 'Studio home zone', countries: ['IE'], cataloguePresetId: 10 },
  { id: uuid(2), name: 'Studio second zone', countries: ['DE', 'FR'], cataloguePresetId: 20 },
], shippingPresetId: null, countries: [] });
test('zones choose exact countries and retain ordinary CRM item references', () => {
  const c = configuration(input(), {});
  expect(c.countries).toEqual(['DE', 'FR', 'IE']);
  expect(selection(c, 'IE')).toMatchObject({ cataloguePresetId: 10, zoneId: uuid(1) });
  expect(selection(c, 'FR')).toMatchObject({ cataloguePresetId: 20, zoneId: uuid(2) });
  expect(() => selection(c, 'US')).toThrow('supported delivery country');
});
test('legacy flat delivery and deliberately included delivery remain supported', () => {
  expect(selection(configuration({ countries: ['IE'], shippingPresetId: 10 }, {}), 'IE').cataloguePresetId).toBe(10);
  expect(selection(configuration({ countries: ['IE'], shippingPresetId: null }, {}), 'IE').cataloguePresetId).toBeNull();
});
test('an older settings client preserves existing zones instead of clearing them silently', () => {
  const previous = configuration(input(), {});
  expect(configuration({ countries: previous.countries, shippingPresetId: null }, previous).shippingZones).toEqual(previous.shippingZones);
});
test.each(['overlap', 'duplicate identifier', 'missing country', 'invalid country', 'invalid item', 'flat and zones'])('rejects %s zone configuration', kind => {
  const c = input();
  if (kind === 'overlap') c.shippingZones[1].countries.push('IE');
  if (kind === 'duplicate identifier') c.shippingZones[1].id = uuid(1);
  if (kind === 'missing country') c.shippingZones[0].countries = [];
  if (kind === 'invalid country') c.shippingZones[0].countries = ['Ireland'];
  if (kind === 'invalid item') c.shippingZones[0].cataloguePresetId = -1;
  if (kind === 'flat and zones') c.shippingPresetId = 10;
  expect(() => configuration(c, {})).toThrow();
});
