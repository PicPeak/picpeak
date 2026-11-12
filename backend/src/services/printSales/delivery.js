'use strict';
const V = require('../albumProducts/validation');
const { ValidationError } = require('../../utils/errors');
const fail = message => { throw new ValidationError(message); };
function countries(value) {
  if (!Array.isArray(value) || !value.length || value.length > 250 ||
      value.some(c => typeof c !== 'string' || !/^[A-Z]{2}$/.test(c))) fail('Choose delivery countries using two-letter country codes');
  return [...new Set(value)].sort();
}
function preset(value) {
  if (value !== null && (!Number.isSafeInteger(value) || value < 1)) fail('Choose a delivery catalogue item or included delivery');
  return value;
}
/** Zones are studio configuration; native CRM items remain the only delivery prices. */
function configuration(input, previous) {
  const zones = input.shippingZones === undefined ? previous.shippingZones ?? [] : input.shippingZones;
  if (!Array.isArray(zones) || zones.length > 30) fail('Use at most 30 delivery zones');
  const seenIds = new Set(), seenCountries = new Set();
  const shippingZones = zones.map(z => {
    if (!z || typeof z !== 'object' || Array.isArray(z) || Object.keys(z).some(k => !['id', 'name', 'countries', 'cataloguePresetId'].includes(k)))
      fail('Invalid delivery zone');
    V.uuid(z.id);
    if (seenIds.has(z.id)) fail('Delivery zone identifiers must be unique');
    seenIds.add(z.id);
    const destinationCountries = countries(z.countries);
    for (const c of destinationCountries) {
      if (seenCountries.has(c)) fail('A country can belong to only one delivery zone');
      seenCountries.add(c);
    }
    return { id: z.id, name: V.text(z.name, 100, true), countries: destinationCountries,
      cataloguePresetId: preset(z.cataloguePresetId ?? null) };
  });
  const shippingPresetId = preset(input.shippingPresetId ?? null);
  if (shippingZones.length && shippingPresetId !== null) fail('Choose either delivery zones or a single delivery item');
  if (seenCountries.size > 250) fail('Use at most 250 delivery countries');
  return { shippingZones, shippingPresetId, countries: shippingZones.length ? [...seenCountries].sort() : countries(input.countries) };
}
function selection(config, country) {
  if (!config.countries.includes(country)) fail('Choose a supported delivery country');
  if (!config.shippingZones?.length) return { country, zoneId: null, zoneName: null, cataloguePresetId: config.shippingPresetId };
  const matches = config.shippingZones.filter(z => z.countries.includes(country));
  if (matches.length !== 1) fail('No unambiguous delivery zone is configured for this country');
  const zone = matches[0];
  return { country, zoneId: zone.id, zoneName: zone.name, cataloguePresetId: zone.cataloguePresetId };
}
module.exports = { configuration, selection };
