'use strict';
const V = require('../albumProducts/validation');
const G = require('../albumProducts/library');
const { defineProfile } = require('./manufacturingProfiles');
const { AppError, ConflictError } = require('../../utils/errors');
const { isTruthyFlag } = require('../../utils/lineItemTotals');
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const defaults = () => ({ profiles: [], countries: [], policy: '', shippingPresetId: null });
async function catalogue(tx) {
  const row = await tx('album_product_catalogue').where({ id: 1 }).first();
  return { products: parse(row?.products || '[]'), library: parse(row?.library || '[]'), types: parse(row?.types || '[]') };
}
async function settings(tx) {
  const row = await tx('print_sales_settings').where({ id: 1 }).first();
  return { revision: row?.revision || 0, ...(row ? parse(row.configuration) : defaults()) };
}
async function priceItem(tx, id, productId = null) {
  const query = tx('quote_line_item_presets').where({ id });
  if (tx.isTransaction) query.forUpdate();
  const p = await query.first();
  if (!p || !isTruthyFlag(p.is_active) || p.price_mode !== 'fixed' ||
      (productId ? p.product_id !== productId : p.product_id != null) ||
      !Number.isSafeInteger(Number(p.unit_price_minor)) || Number(p.unit_price_minor) < 0 || !p.vat_code)
    throw new AppError('Choose an active fixed-price CRM item with output VAT', 400);
  const vat = await tx('vat_codes').where({ code: p.vat_code, direction: 'output' }).first();
  if (!vat || !isTruthyFlag(vat.active)) throw new AppError('Choose an active output VAT code', 400);
  return { ...p, vatRate: Number(vat.rate) };
}
/** One revision for the complete configuration; commercial prices remain CRM-owned. */
async function save(db, input) {
  if (!input || !Array.isArray(input.profiles) || input.profiles.length > 100)
    throw new AppError('Choose profiles and delivery countries', 400);
  V.revision(input.revision);
  // Policies are plain text paragraphs, like supplier instructions, not a single-line label.
  if (typeof input.policy !== 'string' || input.policy.length > 5000) throw new AppError('Invalid text', 400);
  const policy = input.policy.replace(/\r\n?/g, '\n').split('\n').map(line => V.text(line, 5000)).join('\n').trim();
  if (!policy) throw new AppError('A buyer policy is required', 400);
  return db.transaction(async tx => {
    await tx('album_product_catalogue').where({ id: 1 }).forUpdate().first();
    // An older portable backup has no singleton row for this new feature.
    await tx('print_sales_settings').insert({ id: 1, revision: 0, configuration: JSON.stringify(defaults()),
      updated_at: new Date().toISOString() }).onConflict('id').ignore();
    const current = await tx('print_sales_settings').where({ id: 1 }).forUpdate().first();
    if (current.revision !== input.revision) throw new ConflictError('Print settings changed; reload before saving');
    const previous = parse(current.configuration), cat = await catalogue(tx), seen = new Set(), variants = new Set();
    const profiles = [];
    for (const entry of input.profiles) {
      if (!entry?.definition || !Number.isSafeInteger(entry.cataloguePresetId)) throw new AppError('Choose a CRM price item', 400);
      const prior = previous.profiles.find(p => p.definition.id === entry.definition.id);
      const definition = { ...entry.definition, revision: prior ? prior.definition.revision : 1 };
      if (prior && V.hash({ ...prior.definition, revision: 0 }) !== V.hash({ ...definition, revision: 0 })) definition.revision++;
      // A withdrawn stale profile can be retained without re-validating its old product.
      const withdrawn = prior && definition.enabled === false &&
        V.hash({ ...prior.definition, enabled: false, revision: 0 }) === V.hash({ ...definition, revision: 0 });
      const snapshot = withdrawn ? null : defineProfile(cat, definition);
      if (seen.has(definition.id)) throw new AppError('Duplicate manufacturing profile', 400);
      seen.add(definition.id);
      if (definition.enabled) {
        const key = V.hash({ product: snapshot.selection.product.id, values: G.valuesOf(snapshot.selection) });
        if (variants.has(key)) throw new AppError('Two profiles enable the same product choices', 400);
        variants.add(key);
        await priceItem(tx, entry.cataloguePresetId, definition.selection.productId);
      }
      profiles.push({ definition, cataloguePresetId: entry.cataloguePresetId });
    }
    const delivery = require('./delivery').configuration(input, previous);
    for (const id of new Set([delivery.shippingPresetId, ...delivery.shippingZones.map(z => z.cataloguePresetId)].filter(id => id !== null)))
      await priceItem(tx, id);
    const configuration = { profiles, policy, ...delivery };
    await tx('print_sales_settings').where({ id: 1, revision: input.revision }).update({
      revision: input.revision + 1, configuration: JSON.stringify(configuration), updated_at: new Date().toISOString(),
    });
    return { revision: input.revision + 1, ...configuration };
  });
}
module.exports = { catalogue, settings, priceItem, save, parse };
