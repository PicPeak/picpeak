'use strict';
const V = require('./validation');
const G = require('./library');
const { AppError } = require('../../utils/errors');
const {
  isTruthyFlag,
  isUnselectedOptional,
} = require('../../utils/lineItemTotals');
const parse = (value) => (value == null ? null : V.parse(value));
function surcharges(value, product) {
  if (!Array.isArray(value) || value.length > 1000)
    throw new AppError('Invalid product surcharges', 400);
  const seen = new Set();
  return value.map((row) => {
    const a = product.attributes?.find((a) => a.id === row.attributeId);
    const key = `${row.attributeId}:${row.optionId}`;
    if (
      !a?.options.some((o) => o.id === row.optionId) ||
      seen.has(key) ||
      !Number.isSafeInteger(row.amountMinor) ||
      row.amountMinor < 0 ||
      row.amountMinor > 1e9
    )
      throw new AppError('Invalid option surcharge', 400);
    seen.add(key);
    return {
      attributeId: a.id,
      optionId: row.optionId,
      amountMinor: row.amountMinor,
    };
  });
}
async function catalogueProduct(db, id) {
  const flag = await db('feature_flags')
    .where({ key: 'albumProducts' })
    .first();
  if (!isTruthyFlag(flag?.value))
    throw new AppError('Product configuration is disabled', 403);
  const catalog = await db('album_product_catalogue').where({ id: 1 }).first();
  const product = G.resolve(
    parse(catalog?.products || '[]').find((p) => p.id === id),
    {
      library: parse(catalog?.library || '[]'),
      types: parse(catalog?.types || '[]'),
    },
  );
  if (!product?.active || !product.attributes)
    throw new AppError('Choose an active configurable product', 400);
  return product;
}
async function presetColumns(db, payload, existing = {}) {
  if (
    payload.product_id === undefined &&
    payload.product_surcharges === undefined
  )
    return {};
  const id =
    payload.product_id === undefined ? existing.product_id : payload.product_id;
  if (!id) return { product_id: null, product_surcharges: null };
  V.uuid(id);
  if ((payload.price_mode ?? existing.price_mode ?? 'fixed') !== 'fixed')
    throw new AppError('Configurable products need a fixed base price', 400);
  const product = await catalogueProduct(db, id);
  return {
    product_id: id,
    product_surcharges: JSON.stringify(
      surcharges(
        parse(payload.product_surcharges ?? existing.product_surcharges) || [],
        product,
      ),
    ),
  };
}
async function prepareLine(db, line, { quoteId, currency } = {}) {
  const finish = (prepared) => {
    const {
      configuration_values: values,
      configuration_source_line_id: source,
      ...out
    } = prepared;
    if (!out.configuration_definition) return out;
    if (
      line.configuration_locked !== undefined &&
      typeof line.configuration_locked !== 'boolean' &&
      ![0, 1].includes(line.configuration_locked)
    )
      throw new AppError('Invalid configuration lock', 400);
    out.configuration_locked =
      line.configuration_locked === undefined
        ? isTruthyFlag(out.configuration_locked)
        : isTruthyFlag(line.configuration_locked);
    const definition = parse(out.configuration_definition);
    return configureLines(
      [out],
      values === undefined
        ? []
        : [
            {
              position: Number(out.position),
              definitionVersion: definition.version,
              values,
            },
          ],
      { complete: out.configuration_locked, authoring: true },
    )[0];
  };
  // Definitions already produced inside the service (reissue/template paths).
  if (line.configuration_definition) return finish(line);
  const out = { ...line };
  delete out.configuration_source_line_id;
  if (line.configuration_source_line_id && quoteId) {
    const source = await db('quote_line_items')
      .where({ quote_id: quoteId, id: line.configuration_source_line_id })
      .first();
    if (!source)
      throw new AppError('The source quote line changed; reload it', 409);
    if (source.configuration_definition)
      return finish({
        ...out,
        catalogue_preset_id: source.catalogue_preset_id,
        configuration_definition: source.configuration_definition,
        configuration_snapshot: source.configuration_snapshot,
        configuration_base_details:
          line.details_text === undefined ||
          line.details_text === source.details_text
            ? source.configuration_base_details
            : line.details_text || null,
        configuration_locked: source.configuration_locked,
      });
  }
  if (!line.catalogue_preset_id) return finish(out);
  if (line.line_kind && line.line_kind !== 'item')
    throw new AppError(
      'A configured product must be a regular quote item',
      400,
    );
  const preset = await db('quote_line_item_presets')
    .where({ id: line.catalogue_preset_id })
    .first();
  if (!preset || !isTruthyFlag(preset.is_active))
    throw new AppError('The catalogue item is unavailable', 400);
  if (!preset.product_id) return finish(out);
  if (currency && preset.currency !== currency)
    throw new AppError('Product and quote currencies must match', 400);
  const product = await catalogueProduct(db, preset.product_id);
  const definition = {
    schemaVersion: 1,
    product,
    baseUnitPriceMinor: Number(preset.unit_price_minor),
    surcharges: surcharges(parse(preset.product_surcharges) || [], product),
  };
  definition.version = V.hash(definition);
  return finish({
    ...out,
    unit_price_minor: definition.baseUnitPriceMinor,
    configuration_definition: JSON.stringify(definition),
    configuration_snapshot: null,
    configuration_base_details: out.details_text || null,
  });
}
function configureLines(
  lines,
  configurations = [],
  { complete = true, authoring = false } = {},
) {
  if (!Array.isArray(configurations) || configurations.length > 200)
    throw new AppError('Invalid configurations', 400);
  const entries = new Map();
  for (const c of configurations) {
    if (!Number.isSafeInteger(c.position) || entries.has(c.position))
      throw new AppError('Invalid configuration position', 400);
    const line = lines.find(
      (li) => Number(li.position) === c.position && li.configuration_definition,
    );
    if (!line) throw new AppError('Unknown configurable quote line', 400);
    entries.set(c.position, c);
  }
  const topById = new Map(lines.map((li) => [li.id, li]));
  return lines.map((line) => {
    const definition = parse(line.configuration_definition);
    if (!definition) return line;
    const parent = line.parent_line_item_id
      ? topById.get(line.parent_line_item_id)
      : lines.find(
          (li) => Number(li.position) === Number(line.parent_position),
        );
    if (
      !authoring &&
      (isUnselectedOptional(line) || (parent && isUnselectedOptional(parent)))
    )
      return {
        ...line,
        unit_price_minor: definition.baseUnitPriceMinor,
        configuration_snapshot: null,
        details_text: line.configuration_base_details || null,
      };
    const request = entries.get(Number(line.position));
    const previous = parse(line.configuration_snapshot);
    if (!request && !previous && !complete)
      return { ...line, unit_price_minor: definition.baseUnitPriceMinor };
    if (request && request.definitionVersion !== definition.version)
      throw new AppError(
        'The product offer changed; reload the quote',
        409,
        'CONFIGURATION_CHANGED',
      );
    const values = request ? request.values : G.valuesOf(previous);
    const snapshot = G.selection(
      definition.product,
      {
        productVersion: definition.product.version,
        values,
      },
      { complete },
    );
    if (
      !authoring &&
      isTruthyFlag(line.configuration_locked) &&
      V.hash(snapshot.attributes) !== V.hash(previous?.attributes)
    )
      throw new AppError(
        'This product specification is locked by the studio',
        409,
        'CONFIGURATION_LOCKED',
      );
    const breakdown = definition.surcharges.filter((s) =>
      snapshot.attributes.some(
        (a) =>
          a.id === s.attributeId && a.options.some((o) => o.id === s.optionId),
      ),
    );
    const surchargeMinor = breakdown.reduce((n, s) => n + s.amountMinor, 0);
    const unit = definition.baseUnitPriceMinor + surchargeMinor;
    if (!Number.isSafeInteger(unit) || unit > 1e10)
      throw new AppError('Product amount is too large', 400);
    const priced = {
      ...snapshot,
      pricing: {
        baseUnitPriceMinor: definition.baseUnitPriceMinor,
        surchargeMinor,
        unitPriceMinor: unit,
        breakdown,
      },
    };
    return {
      ...line,
      unit_price_minor: unit,
      configuration_snapshot: JSON.stringify(priced),
      details_text: [line.configuration_base_details, G.summary(snapshot)]
        .filter(Boolean)
        .join('\n'),
    };
  });
}
async function writeSnapshots(tx, quoteId, configuredLines, history) {
  const { auditedUpdate } = require('../accountingHistory');
  const stored = await tx('quote_line_items')
    .where({ quote_id: quoteId })
    .orderBy('position');
  for (const line of configuredLines) {
    if (!line.configuration_definition) continue;
    const current = stored.find((li) => li.id === line.id);
    if (
      !current ||
      current.configuration_definition !== line.configuration_definition
    )
      throw new AppError(
        'The quote configuration changed; reload it',
        409,
        'CONFIGURATION_CHANGED',
      );
    await auditedUpdate(
      tx,
      'quote_line_items',
      { quote_id: quoteId, id: line.id },
      {
        configuration_snapshot: line.configuration_snapshot || null,
        details_text: line.details_text || null,
        unit_price_minor: line.unit_price_minor,
        line_total_minor: line.line_total_minor,
      },
      history,
    );
  }
  await require('./retention').retain(tx, 'quote', quoteId, configuredLines);
}
async function quoteImage(db, quoteId, imageId) {
  V.uuid(imageId);
  const rows = await db('quote_line_items').where({ quote_id: quoteId });
  const allowed = rows.some((line) => {
    const def = parse(line.configuration_definition),
      snap = parse(line.configuration_snapshot);
    return [
      ...(def?.product?.attributes?.flatMap((a) => a.options) || []),
      ...(snap?.attributes?.flatMap((a) => a.options) || []),
    ].some((o) => o.imageId === imageId);
  });
  if (!allowed) throw new AppError('Image not found', 404);
  const image = await db('album_product_images').where({ id: imageId }).first();
  if (!image) throw new AppError('Image not found', 404);
  return image;
}
module.exports = {
  quoteImage,
  surcharges,
  catalogueProduct,
  presetColumns,
  prepareLine,
  configureLines,
  writeSnapshots,
};
