'use strict';

/**
 * Pricing factors on catalogue items (#2440, part 1).
 *
 * A catalogue item keeps its base price; the factors attached to it change
 * the price by an amount per unit, a step, a fixed amount or a percent of the
 * base. `priceWithFactors` is the one place that turns an item plus the
 * chosen values into a priced breakdown. The quote editor uses it now; the
 * public booking request (part 2) uses the same function for its estimate.
 *
 * The breakdown becomes ordinary quote lines: a parent line for the item
 * (holding the `pricing_factors` snapshot) and one priced sub-line for the
 * base and for every factor that changes the price. Totals, PDFs and the
 * invoice conversion therefore need no change.
 *
 * Nothing is hard-deleted: archiving keeps old snapshots explainable, and
 * a factor attached to an item can't be removed from the library.
 */

const { db } = require('../database/db');
const { AppError } = require('../utils/errors');
const { ensureInt, ensureNumber } = require('../utils/numericHelpers');
const { formatBoolean } = require('../utils/dbCompat');
const { isTruthyFlag } = require('../utils/lineItemTotals');
const rateResolver = require('./rateResolver');
const pdfI18n = require('./pdf-i18n');

const INPUT_TYPES = ['number', 'toggle', 'choice', 'zone'];
const NUMBER_EFFECTS = ['per_unit', 'step'];
const TOGGLE_EFFECTS = ['fixed', 'percent'];
const OPTION_EFFECTS = ['fixed', 'percent'];
const MAX_OPTIONS = 100;
const SNAPSHOT_VERSION = 1;
// Stored numbers are decimal(10,2): the largest the column holds, and the
// smallest step that survives rounding to two places.
const MAX_STORED_NUMBER = 99999999;
const MIN_STEP = 0.01;
// A value a client or admin submits for a number factor; above this a price
// stops being meaningful long before the arithmetic overflows.
const MAX_SUBMITTED_VALUE = 1e6;

const nowIso = () => new Date().toISOString();

function insertedId(inserted) {
  return typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];
}

const num = (v) => (v == null || v === '' ? null : Number(v));
const minor = (v) => (v == null || v === '' ? null : Math.round(Number(v)));

// ---------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------

async function loadOptions(factorIds, conn = db) {
  if (factorIds.length === 0) return new Map();
  const rows = await conn('pricing_factor_options')
    .whereIn('factor_id', factorIds)
    .orderBy('position', 'asc')
    .orderBy('id', 'asc');
  const byFactor = new Map();
  for (const row of rows) {
    if (!byFactor.has(row.factor_id)) byFactor.set(row.factor_id, []);
    byFactor.get(row.factor_id).push(row);
  }
  return byFactor;
}

async function listFactors({ activeOnly = false, ids = null } = {}, conn = db) {
  const query = conn('pricing_factors');
  if (activeOnly) query.where({ is_active: formatBoolean(true) });
  if (Array.isArray(ids)) query.whereIn('id', ids);
  const factors = await query.orderBy('display_order', 'asc').orderBy('id', 'asc');
  const options = await loadOptions(factors.map((f) => f.id), conn);
  return factors.map((f) => ({ ...f, options: options.get(f.id) || [] }));
}

async function getFactor(id, conn = db) {
  const [factor] = await listFactors({ ids: [id] }, conn);
  return factor || null;
}

/** Payload (snake_case) → validated column set. Throws 400 on bad shapes. */
function factorColumns(payload, existing = {}) {
  const inputType = payload.input_type ?? existing.input_type;
  if (!INPUT_TYPES.includes(inputType)) {
    throw new AppError('Unknown factor type', 400, 'FACTOR_INVALID');
  }
  let effect = payload.effect !== undefined ? payload.effect : existing.effect;
  if (inputType === 'number' && !NUMBER_EFFECTS.includes(effect)) effect = 'per_unit';
  if (inputType === 'toggle' && !TOGGLE_EFFECTS.includes(effect)) effect = 'fixed';
  if (inputType === 'choice' || inputType === 'zone') effect = null;

  const out = { input_type: inputType, effect };
  const copy = (key, fn) => { if (payload[key] !== undefined) out[key] = fn(payload[key]); };
  copy('name', (v) => String(v || '').trim().slice(0, 128));
  copy('description', (v) => (v ? String(v) : null));
  copy('unit_label', (v) => (v ? String(v).trim().slice(0, 32) : null));
  copy('currency', (v) => String(v || 'CHF').toUpperCase().slice(0, 3));
  copy('amount_minor', minor);
  copy('percent', num);
  copy('included_units', num);
  copy('step_size', num);
  copy('min_value', num);
  copy('max_value', num);
  copy('default_value', (v) => (v == null || v === '' ? null : String(v).slice(0, 64)));
  copy('client_visible', (v) => formatBoolean(Boolean(v)));
  copy('display_order', ensureInt);
  copy('is_active', (v) => formatBoolean(Boolean(v)));

  const merged = { ...existing, ...out };
  if (out.name !== undefined && !out.name) throw new AppError('A factor needs a name', 400, 'FACTOR_INVALID');
  for (const key of ['included_units', 'step_size', 'min_value', 'max_value']) {
    const v = merged[key];
    if (v != null && (Number(v) < 0 || Number(v) > MAX_STORED_NUMBER)) {
      throw new AppError(`${key} must be between 0 and ${MAX_STORED_NUMBER}`, 400, 'FACTOR_INVALID');
    }
  }
  if (inputType === 'number' && effect === 'step' && !(Number(merged.step_size) >= MIN_STEP)) {
    throw new AppError(`A stepped factor needs a step size of at least ${MIN_STEP}`, 400, 'FACTOR_INVALID');
  }
  if (merged.min_value != null && merged.max_value != null && Number(merged.min_value) > Number(merged.max_value)) {
    throw new AppError('The minimum is above the maximum', 400, 'FACTOR_INVALID');
  }
  return out;
}

/**
 * Check a factor's default against its type, bounds and options (the final
 * option ids, after the write). Returns the default to store: a choice or
 * zone default whose option was removed by this save is cleared, unless the
 * save itself named it; then it is refused.
 */
function checkedDefault(factor, optionIds, { explicit }) {
  const d = factor.default_value;
  if (d == null || d === '') return null;
  switch (factor.input_type) {
    case 'number': {
      const n = Number(d);
      const ok = Number.isFinite(n) && n >= 0 && n <= MAX_SUBMITTED_VALUE
        && (factor.min_value == null || n >= Number(factor.min_value))
        && (factor.max_value == null || n <= Number(factor.max_value));
      if (!ok) throw new AppError('The default is not a valid value for this factor', 400, 'FACTOR_INVALID');
      return String(n);
    }
    case 'toggle':
      if (d !== 'true' && d !== 'false') throw new AppError('The default of a yes/no factor is true or false', 400, 'FACTOR_INVALID');
      return d;
    default:
      if (optionIds.includes(ensureInt(d))) return String(ensureInt(d));
      if (explicit) throw new AppError('The default must be one of the options', 400, 'FACTOR_INVALID');
      return null;
  }
}

function optionRows(options, inputType) {
  if (!Array.isArray(options)) return null;
  if (inputType !== 'choice' && inputType !== 'zone') return [];
  if (options.length > MAX_OPTIONS) throw new AppError('Too many options', 400, 'FACTOR_INVALID');
  return options.map((o, index) => {
    const label = String(o.label || '').trim().slice(0, 128);
    if (!label) throw new AppError('Every option needs a label', 400, 'FACTOR_INVALID');
    const effect = OPTION_EFFECTS.includes(o.effect) ? o.effect : 'fixed';
    return {
      id: o.id ? ensureInt(o.id) : null,
      label,
      effect,
      amount_minor: effect === 'fixed' ? minor(o.amount_minor) ?? 0 : null,
      percent: effect === 'percent' ? num(o.percent) ?? 0 : null,
      postcodes: inputType === 'zone' ? normalisePostcodeList(o.postcodes) : null,
      position: index + 1,
    };
  });
}

/**
 * Create (id = null) or update a factor. `options` (when given) replaces the
 * option list; options keep their id when the payload sends it, so a choice
 * factor's default (an option id) survives an edit.
 */
async function saveFactor(id, payload) {
  const existing = id ? await db('pricing_factors').where({ id }).first() : null;
  if (id && !existing) throw new AppError('Pricing factor not found', 404);
  if (!id && !payload.name) throw new AppError('A factor needs a name', 400, 'FACTOR_INVALID');
  const columns = factorColumns(payload, existing || {});
  const attached = existing ? await db('quote_preset_factors').where({ factor_id: id }).first() : null;
  if (attached && columns.currency && columns.currency !== existing.currency) {
    throw new AppError('The factor is attached to catalogue items in its currency; detach it first', 409, 'FACTOR_IN_USE');
  }
  // Another type would drop or reinterpret what services and saved quotes
  // were priced with (choice options go, a number reads differently).
  if (attached && columns.input_type !== existing.input_type) {
    throw new AppError('The type of a factor in use cannot change; create a new factor instead', 409, 'FACTOR_IN_USE');
  }
  const options = optionRows(payload.options, columns.input_type);

  const factorId = await db.transaction(async (trx) => {
    let targetId = id;
    if (id) {
      await trx('pricing_factors').where({ id }).update({ ...columns, updated_at: nowIso() });
    } else {
      targetId = insertedId(await trx('pricing_factors').insert({
        currency: 'CHF',
        client_visible: formatBoolean(true),
        is_active: formatBoolean(true),
        display_order: 0,
        ...columns,
        created_at: nowIso(),
        updated_at: nowIso(),
      }).returning('id'));
    }
    if (options) {
      const keep = options.filter((o) => o.id).map((o) => o.id);
      const removeQuery = trx('pricing_factor_options').where({ factor_id: targetId });
      if (keep.length) removeQuery.whereNotIn('id', keep);
      await removeQuery.del();
      for (const { id: optionId, ...row } of options) {
        const updated = optionId
          ? await trx('pricing_factor_options').where({ id: optionId, factor_id: targetId })
            .update({ ...row, updated_at: nowIso() })
          : 0;
        if (!updated) {
          await trx('pricing_factor_options').insert({
            ...row, factor_id: targetId, created_at: nowIso(), updated_at: nowIso(),
          });
        }
      }
    }
    // The default after the write: a removed option clears it in the same
    // transaction, so no price call ever falls back to an option that is gone.
    const row = await trx('pricing_factors').where({ id: targetId }).first();
    const optionIds = (await trx('pricing_factor_options').where({ factor_id: targetId }).pluck('id')).map(Number);
    const fixedDefault = checkedDefault(row, optionIds, { explicit: payload.default_value !== undefined });
    if ((fixedDefault ?? null) !== (row.default_value ?? null)) {
      await trx('pricing_factors').where({ id: targetId }).update({ default_value: fixedDefault });
    }
    return targetId;
  });
  return getFactor(factorId);
}

async function archiveFactor(id) {
  const updated = await db('pricing_factors').where({ id })
    .update({ is_active: formatBoolean(false), updated_at: nowIso() });
  if (!updated) throw new AppError('Pricing factor not found', 404);
}

// ---------------------------------------------------------------------
// Factors on catalogue items
// ---------------------------------------------------------------------

/** factor ids per preset id, in order. */
async function presetFactorIds(presetIds, conn = db) {
  const map = new Map();
  if (!presetIds.length) return map;
  const rows = await conn('quote_preset_factors').whereIn('preset_id', presetIds)
    .orderBy('position', 'asc').orderBy('id', 'asc');
  for (const row of rows) {
    if (!map.has(row.preset_id)) map.set(row.preset_id, []);
    map.get(row.preset_id).push(row.factor_id);
  }
  return map;
}

/**
 * Check a factor list for a catalogue item before anything is written.
 * Factors must exist, be active (or already attached) and share the item's
 * currency. An item linked to a configurable product (#1924) can't also
 * carry factors: one line, one pricing system.
 *
 * @param {{id?: number, currency: string, product_id?: string|null}} preset
 *   the item as it will be after the write
 * @returns {Promise<number[]>} the de-duplicated ids, in order
 */
async function validatePresetFactors(preset, factorIds, conn = db) {
  const ids = [...new Set((factorIds || []).map(ensureInt).filter((n) => n > 0))];
  if (!ids.length) return ids;
  if (preset.product_id) {
    throw new AppError('A catalogue item linked to a configurable product cannot use pricing factors', 400, 'FACTORS_WITH_PRODUCT');
  }
  const found = await conn('pricing_factors').whereIn('id', ids);
  if (found.length !== ids.length) throw new AppError('Unknown pricing factor', 400, 'FACTOR_NOT_FOUND');
  const currentIds = new Set(preset.id
    ? await conn('quote_preset_factors').where({ preset_id: preset.id }).pluck('factor_id')
    : []);
  for (const f of found) {
    if (!isTruthyFlag(f.is_active) && !currentIds.has(f.id)) {
      throw new AppError('An archived pricing factor cannot be attached', 400, 'FACTOR_NOT_FOUND');
    }
    if (f.currency !== String(preset.currency || 'CHF').toUpperCase()) {
      throw new AppError('Pricing factors must use the catalogue item\'s currency', 400, 'FACTOR_CURRENCY');
    }
  }
  return ids;
}

/**
 * The factor that sets a bookable service's slot length (#2440, part 2) must
 * be one of the service's own factors, and a number.
 */
async function assertDurationFactor(factorIds, durationFactorId, conn = db) {
  if (!durationFactorId) return;
  const id = ensureInt(durationFactorId);
  const factor = factorIds.includes(id) ? await conn('pricing_factors').where({ id }).first('input_type') : null;
  if (!factor || factor.input_type !== 'number') {
    throw new AppError('The slot length must come from one of the service\'s number factors', 400, 'BOOKING_DURATION_FACTOR');
  }
}

/** Replace the factors attached to a catalogue item (ids already validated). */
async function writePresetFactors(trx, presetId, ids) {
  await trx('quote_preset_factors').where({ preset_id: presetId }).del();
  if (ids.length) {
    await trx('quote_preset_factors').insert(ids.map((factorId, index) => ({
      preset_id: presetId, factor_id: factorId, position: index + 1,
    })));
  }
}

// ---------------------------------------------------------------------
// Postcode zones
// ---------------------------------------------------------------------

const normalisePostcode = (v) => String(v || '').toUpperCase().replace(/[\s-]+/g, '');

/** One entry per line; commas and semicolons also separate. Keeps "*" and ranges. */
function normalisePostcodeList(value) {
  if (value == null) return null;
  const list = Array.isArray(value) ? value : String(value).split(/[\n,;]+/);
  const entries = list.map((e) => String(e).trim().toUpperCase()).filter(Boolean).slice(0, 2000);
  for (const entry of entries) {
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(entry);
    // A range compares postcodes of one length; "800-1200" would never match.
    if (range && (range[1].length !== range[2].length || Number(range[1]) > Number(range[2]))) {
      throw new AppError(`"${entry}": both ends of a range need the same number of digits, low to high`, 400, 'FACTOR_INVALID');
    }
  }
  return entries.length ? entries.join('\n') : null;
}

/**
 * Does a postcode fall under one zone entry?
 *   "8001"       exact (spaces and dashes ignored)
 *   "80*"        prefix
 *   "8000-8099"  numeric range (both ends numeric, same length)
 */
function postcodeMatches(entry, postcode) {
  const pc = normalisePostcode(postcode);
  if (!pc) return false;
  const range = /^(\d+)\s*-\s*(\d+)$/.exec(entry.trim());
  if (range && /^\d+$/.test(pc) && range[1].length === range[2].length && pc.length === range[1].length) {
    const n = Number(pc);
    return n >= Number(range[1]) && n <= Number(range[2]);
  }
  const clean = normalisePostcode(entry);
  if (clean.endsWith('*')) return pc.startsWith(clean.slice(0, -1));
  return clean === pc;
}

/** First zone option (in order) whose list holds the postcode, or null. */
function zoneForPostcode(options, postcode) {
  for (const option of options) {
    const entries = String(option.postcodes || '').split('\n').filter(Boolean);
    if (entries.some((entry) => postcodeMatches(entry, postcode))) return option;
  }
  return null;
}

// ---------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------

function formatValue(value, locale) {
  try {
    return new Intl.NumberFormat(locale === 'de' ? 'de-CH' : locale || 'en', { maximumFractionDigits: 2 }).format(value);
  } catch {
    return String(value);
  }
}

function withUnit(value, factor, locale) {
  const text = formatValue(value, locale);
  return factor.unit_label ? `${text} ${factor.unit_label}` : text;
}

/**
 * Resolve the value a factor takes from the submitted values, its default
 * and its bounds. Returns the normalised value (what the snapshot keeps).
 */
function resolveValue(factor, raw, { useDefault }) {
  const fallback = useDefault || raw === undefined ? factor.default_value : undefined;
  const value = raw === undefined || useDefault ? fallback : raw;
  switch (factor.input_type) {
    case 'number': {
      if (value == null || value === '') {
        return num(factor.min_value) ?? num(factor.included_units) ?? 0;
      }
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0 || n > MAX_SUBMITTED_VALUE) {
        throw new AppError(`"${factor.name}" needs a number between 0 and ${MAX_SUBMITTED_VALUE}`, 400, 'FACTOR_VALUE_INVALID');
      }
      if (factor.min_value != null && n < Number(factor.min_value)) {
        throw new AppError(`"${factor.name}" is below the minimum`, 400, 'FACTOR_VALUE_INVALID');
      }
      if (factor.max_value != null && n > Number(factor.max_value)) {
        throw new AppError(`"${factor.name}" is above the maximum`, 400, 'FACTOR_VALUE_INVALID');
      }
      return n;
    }
    case 'toggle':
      return value === true || value === 'true' || value === 1 || value === '1';
    case 'choice': {
      if (value == null || value === '') return null;
      const option = factor.options.find((o) => o.id === ensureInt(value));
      if (!option) throw new AppError(`Choose an option for "${factor.name}"`, 400, 'FACTOR_VALUE_INVALID');
      return option.id;
    }
    case 'zone': {
      // { optionId } when the admin picks the zone, { postcode } when the
      // client types an address. A default is stored as the option id.
      if (value == null || value === '') return null;
      const asObject = typeof value === 'object' ? value : { optionId: value };
      if (asObject.optionId != null && asObject.optionId !== '') {
        const option = factor.options.find((o) => o.id === ensureInt(asObject.optionId));
        if (!option) throw new AppError(`Choose a zone for "${factor.name}"`, 400, 'FACTOR_VALUE_INVALID');
        return { optionId: option.id };
      }
      const postcode = String(asObject.postcode || '').trim().slice(0, 16);
      return postcode ? { postcode } : null;
    }
    default:
      return null;
  }
}

/**
 * A factor as it was priced. Only the option that was chosen is kept (not
 * every zone with its postcode list), so the snapshot stays small.
 */
function factorSnapshot(f, value) {
  const chosen = f.input_type === 'choice' ? value
    : f.input_type === 'zone' && value ? value.optionId : undefined;
  return {
    id: f.id,
    name: f.name,
    inputType: f.input_type,
    effect: f.effect || null,
    unitLabel: f.unit_label || null,
    amountMinor: minor(f.amount_minor),
    percent: num(f.percent),
    includedUnits: num(f.included_units),
    stepSize: num(f.step_size),
    options: (f.options || []).filter((o) => o.id === chosen).map((o) => ({
      id: o.id, label: o.label, effect: o.effect, amountMinor: minor(o.amount_minor), percent: num(o.percent),
    })),
  };
}

/**
 * Price a catalogue item with its factors.
 *
 * @param {number} presetId
 * @param {object} opts
 * @param {object} [opts.values]       { [factorId]: value }
 * @param {number} [opts.customerId]   for the hour/day rate chain
 * @param {number} [opts.quantity]     base quantity; defaults to the item's
 * @param {string} [opts.language]     document language for line texts
 * @param {boolean} [opts.clientOnly]  public estimate: factors the client
 *                                     may not see take their default
 * @returns {Promise<{preset, currency, baseMinor, totalMinor, lines, unmatched, snapshot}>}
 *   lines: [{ kind: 'base'|'factor', factorId, description, quantity,
 *             unitPriceMinor, totalMinor, priceMode, rateSource }]
 *   unmatched: factor ids of zone factors whose postcode is in no zone
 */
async function priceWithFactors(presetId, opts = {}) {
  const { values = {}, customerId = null, language = 'en', clientOnly = false } = opts;
  const preset = await db('quote_line_item_presets').where({ id: presetId }).first();
  if (!preset || !isTruthyFlag(preset.is_active)) {
    throw new AppError('The catalogue item is unavailable', 400, 'PRESET_UNAVAILABLE');
  }
  const factorIds = (await presetFactorIds([preset.id])).get(preset.id) || [];
  const byId = new Map((await listFactors({ ids: factorIds })).map((f) => [f.id, f]));
  const factors = factorIds.map((id) => byId.get(id)).filter(Boolean);

  // Base: a fixed price, or a rate from the item / customer / business.
  const priceMode = preset.price_mode || 'fixed';
  const quantity = opts.quantity != null && opts.quantity !== '' ? ensureNumber(opts.quantity, 1) : ensureNumber(preset.quantity_default, 1);
  let unitPriceMinor = minor(preset.unit_price_minor) || 0;
  let rateSource = null;
  if (priceMode === 'hour' || priceMode === 'day') {
    if (preset.pinned_rate_minor != null) {
      unitPriceMinor = minor(preset.pinned_rate_minor);
      rateSource = 'item';
    } else {
      const rate = rateResolver.pickRate(await rateResolver.loadRates(customerId), priceMode);
      if (!rate) {
        throw new AppError(
          priceMode === 'hour'
            ? 'No hourly rate for this customer and no default hourly rate. Set one under Settings → Accounting, or on the customer.'
            : 'No day rate for this customer and no default day rate. Set one under Settings → Accounting, or on the customer.',
          400,
          'RATE_REQUIRED',
        );
      }
      unitPriceMinor = rate.rateMinor;
      rateSource = rate.source;
    }
  }
  const baseMinor = Math.round(unitPriceMinor * quantity);
  const lines = [{
    kind: 'base',
    factorId: null,
    description: pdfI18n.t(language, 'factor_base_price'),
    quantity,
    unit: preset.unit || null,
    unitPriceMinor,
    totalMinor: baseMinor,
    priceMode: priceMode === 'fixed' ? null : priceMode,
    rateSource,
  }];

  const percentOf = (pct) => Math.round(baseMinor * Number(pct || 0) / 100);
  const resolved = {};
  const unmatched = [];
  for (const factor of factors) {
    const useDefault = clientOnly && !isTruthyFlag(factor.client_visible);
    const value = resolveValue(factor, values[factor.id] ?? values[String(factor.id)], { useDefault });
    resolved[factor.id] = value;
    let line = null;

    if (factor.input_type === 'number') {
      const included = num(factor.included_units) || 0;
      const above = Math.max(0, value - included);
      const amount = minor(factor.amount_minor) || 0;
      const notes = [];
      if (included > 0) notes.push(pdfI18n.t(language, 'factor_included', { n: withUnit(included, factor, language) }));
      if (factor.effect === 'step') {
        const steps = Math.ceil(above / Number(factor.step_size) - 1e-9);
        notes.push(pdfI18n.t(language, 'factor_per_step', { n: withUnit(Number(factor.step_size), factor, language) }));
        if (steps > 0) line = { quantity: steps, unitPriceMinor: amount };
      } else if (above > 0) {
        line = { quantity: above, unitPriceMinor: amount };
      }
      if (line) {
        const suffix = notes.length ? ` (${notes.join(', ')})` : '';
        line.description = `${factor.name}: ${withUnit(value, factor, language)}${suffix}`;
      }
    } else if (factor.input_type === 'toggle') {
      if (value) {
        line = factor.effect === 'percent'
          ? { quantity: 1, unitPriceMinor: percentOf(factor.percent), description: `${factor.name} (${formatValue(Number(factor.percent || 0), language)} %)` }
          : { quantity: 1, unitPriceMinor: minor(factor.amount_minor) || 0, description: factor.name };
      }
    } else {
      let option = null;
      if (factor.input_type === 'choice' && value != null) option = factor.options.find((o) => o.id === value);
      if (factor.input_type === 'zone' && value) {
        option = value.optionId != null
          ? factor.options.find((o) => o.id === value.optionId)
          : zoneForPostcode(factor.options, value.postcode);
        if (!option && value.postcode) unmatched.push(factor.id);
        if (option && value.postcode) resolved[factor.id] = { postcode: value.postcode, optionId: option.id };
      }
      if (option) {
        const percent = option.effect === 'percent';
        line = {
          quantity: 1,
          unitPriceMinor: percent ? percentOf(option.percent) : minor(option.amount_minor) || 0,
          description: percent
            ? `${factor.name}: ${option.label} (${formatValue(Number(option.percent || 0), language)} %)`
            : `${factor.name}: ${option.label}`,
        };
      }
    }

    if (line && line.unitPriceMinor !== 0) {
      lines.push({
        kind: 'factor',
        factorId: factor.id,
        description: line.description,
        quantity: line.quantity,
        unit: null,
        unitPriceMinor: line.unitPriceMinor,
        totalMinor: Math.round(line.quantity * line.unitPriceMinor),
        priceMode: null,
        rateSource: null,
      });
    }
  }

  const totalMinor = lines.reduce((sum, l) => sum + l.totalMinor, 0);
  if (totalMinor < 0) throw new AppError('The factors bring the price below zero', 400, 'FACTOR_TOTAL_NEGATIVE');

  return {
    preset,
    currency: preset.currency,
    baseMinor,
    totalMinor,
    lines,
    unmatched,
    snapshot: {
      version: SNAPSHOT_VERSION,
      presetId: preset.id,
      presetName: preset.name,
      currency: preset.currency,
      quantity,
      values: resolved,
      factors: factors.map((f) => factorSnapshot(f, resolved[f.id])),
      unmatched,
      // The lines this pricing made: re-pricing in the editor removes the
      // sub-lines that still match one of these and keeps the rest (lines
      // the admin added or changed).
      lines: lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor })),
    },
  };
}

/** Parse a stored line snapshot; null when absent or unreadable. */
function parseSnapshot(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

module.exports = {
  INPUT_TYPES,
  NUMBER_EFFECTS,
  TOGGLE_EFFECTS,
  OPTION_EFFECTS,
  listFactors,
  getFactor,
  saveFactor,
  archiveFactor,
  presetFactorIds,
  validatePresetFactors,
  assertDurationFactor,
  writePresetFactors,
  priceWithFactors,
  parseSnapshot,
  postcodeMatches,
  zoneForPostcode,
  normalisePostcodeList,
};
