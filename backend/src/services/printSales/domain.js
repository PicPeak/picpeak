'use strict';
const V = require('../albumProducts/validation');
const G = require('../albumProducts/library');
const CRM = require('../albumProducts/crm');
const P = require('./profiles');
const { resolveProfile } = require('./manufacturingProfiles');
const { AppError } = require('../../utils/errors');
const fail = message => { throw new AppError(message, 400); };
function integer(n, min, max) {
  if (!Number.isSafeInteger(n) || n < min || n > max) fail('Invalid print quantity or identifier');
  return n;
}
function crop(value) {
  if (!value || ['x', 'y', 'width', 'height'].some(k => !Number.isFinite(value[k]) || value[k] < 0 || value[k] > 1) ||
      value.width < .01 || value.height < .01 || value.x + value.width > 1.0000001 || value.y + value.height > 1.0000001)
    fail('Choose a crop inside the photograph');
  return Object.fromEntries(['x', 'y', 'width', 'height'].map(k => [k, value[k]]));
}
function delivery(input, countries) {
  if (!input || !countries.includes(input.country)) fail('Choose a supported delivery country');
  return { country: input.country, ...Object.fromEntries([
    ['name', 120, true], ['line1', 200, true], ['line2', 200, false],
    ['city', 100, true], ['region', 100, false], ['postalCode', 30, true],
  ].map(([k, max, required]) => [k, V.text(input[k] ?? '', max, required)])) };
}
/** Native configured pricing and native total arithmetic; no client amount is trusted. */
async function plan(tx, cart) {
  if (!Array.isArray(cart) || !cart.length || cart.length > 20) fail('Choose between 1 and 20 photo items');
  const config = await P.settings(tx), catalogue = await P.catalogue(tx), items = [], lines = [];
  let currency, vatCode, vatRate;
  const check = p => {
    if (currency && (p.currency !== currency || p.vat_code !== vatCode || p.vatRate !== vatRate))
      fail('One order must use the same currency and output VAT code');
    currency = p.currency; vatCode = p.vat_code; vatRate = p.vatRate;
  };
  for (const item of cart) {
    V.uuid(item.profileId); integer(item.photoId, 1, 2147483647); integer(item.quantity, 1, 100);
    const entry = config.profiles.find(p => p.definition.id === item.profileId && p.definition.enabled);
    if (!entry) fail('This print variant is unavailable');
    const profile = resolveProfile(catalogue, config.profiles.map(p => p.definition), entry.definition.selection);
    const preset = await P.priceItem(tx, entry.cataloguePresetId, profile.selection.product.id);
    check(preset);
    const base = await CRM.prepareLine(tx, { position: lines.length + 1, quantity: item.quantity,
      description: preset.name, catalogue_preset_id: preset.id });
    const definition = P.parse(base.configuration_definition);
    const line = CRM.configureLines([base], [{ position: base.position,
      definitionVersion: definition.version, values: G.valuesOf(profile.selection) }])[0];
    if (Number(line.unit_price_minor) <= 0) fail('Print variants need a positive price');
    if (!profile.manufacturing.fitModes.includes(item.fit)) fail('This crop/fit mode is unavailable');
    items.push({ profile, photoId: item.photoId, quantity: item.quantity, crop: crop(item.crop), fit: item.fit,
      unitPriceMinor: line.unit_price_minor, linePosition: line.position });
    lines.push(line);
  }
  if (config.shippingPresetId !== null) {
    const p = await P.priceItem(tx, config.shippingPresetId); check(p);
    lines.push({ position: lines.length + 1, quantity: 1, description: p.name,
      unit_price_minor: Number(p.unit_price_minor), discount_percent: 0, line_kind: 'item' });
  }
  const totals = require('../quoteService')._internal.computeTotals(lines, vatRate, 0);
  if (!Number.isSafeInteger(totals.totalAmountMinor) || totals.totalAmountMinor <= 0 || totals.totalAmountMinor > 1e8)
    fail('Order amount is outside the supported range');
  const result = { settingsRevision: config.revision, items, lines: totals.lineItems,
    currency, vatCode, vatRate, netMinor: totals.netAmountMinor, vatMinor: totals.vatAmountMinor,
    totalMinor: totals.totalAmountMinor, policy: config.policy };
  return { ...result, signature: V.hash(result), countries: config.countries };
}
/** Crop is interpreted in EXIF-oriented pixels; never stretch a mismatched crop. */
function geometry(source, item) {
  const swapped = [5, 6, 7, 8].includes(source.orientation),
    width = swapped ? source.height : source.width, height = swapped ? source.width : source.height;
  const c = crop(item.crop), left = Math.round(c.x * width), top = Math.round(c.y * height),
    w = Math.min(Math.round(c.width * width), width - left), h = Math.min(Math.round(c.height * height), height - top),
    out = item.profile.artwork;
  if (w < 1 || h < 1) fail('The crop has no image pixels');
  if (item.fit === 'contain' && (c.x !== 0 || c.y !== 0 || c.width !== 1 || c.height !== 1))
    fail('Fit mode uses the whole photograph');
  if (item.fit === 'cover' && Math.abs(w - h * out.widthMm / out.heightMm) > 2)
    fail('The crop must match the production artwork ratio');
  const dpi = item.fit === 'contain'
    ? Math.max(width / out.widthMm, height / out.heightMm) * 25.4
    : Math.min(w / out.widthMm, h / out.heightMm) * 25.4;
  if (dpi + .01 < item.profile.manufacturing.resolution.minimumDpi) fail('This photograph/crop has insufficient print resolution');
  return { left, top, width: w, height: h, effectiveDpi: dpi };
}
module.exports = { integer, crop, delivery, plan, geometry };
