'use strict';

/**
 * Quote catalogue: packages, discount promotions and text blocks (#1451),
 * plus the step that turns an editor payload into authoritative line items
 * before the quote service computes totals.
 *
 * The service items themselves are the existing quote_line_item_presets
 * (extended in migration 215) and keep their CRUD in quoteService.
 *
 * Nothing here is ever hard-deleted: "delete" archives (is_active = false),
 * because quotes, templates and packages copy from these rows and a removed
 * row would leave a published template unable to explain itself.
 */

const { db } = require('../database/db');
const { AppError } = require('../utils/errors');
const { ensureInt, ensureNumber } = require('../utils/numericHelpers');
const { formatBoolean } = require('../utils/dbCompat');
const { isTruthyFlag, BOUND_TO } = require('../utils/lineItemTotals');
const { unknownPlaceholders } = require('../utils/placeholders');
const rateResolver = require('./rateResolver');

const TEXT_BLOCK_KINDS = ['intro', 'scope', 'note', 'closing', 'terms'];
const PROMOTION_TYPES = ['percent', 'fixed'];

function insertedId(inserted) {
  return typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];
}

/** YYYY-MM-DD of a Date in server-local time. */
function localIsoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function todayIso() {
  return localIsoDate(new Date());
}

/**
 * Postgres returns DATE columns as Date objects at local midnight, SQLite as
 * strings. toISOString() would give the previous day on a server east of UTC.
 */
function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return localIsoDate(value);
  return String(value).slice(0, 10);
}

function pickDefined(payload, keys) {
  const out = {};
  for (const key of keys) if (payload[key] !== undefined) out[key] = payload[key];
  return out;
}

// ---------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------

async function loadPackageItems(packageIds) {
  if (packageIds.length === 0) return new Map();
  const rows = await db('quote_package_items as pi')
    .join('quote_line_item_presets as p', 'p.id', 'pi.preset_id')
    .whereIn('pi.package_id', packageIds)
    .orderBy('pi.position', 'asc')
    .orderBy('pi.id', 'asc')
    .select(
      'pi.id', 'pi.package_id', 'pi.preset_id', 'pi.quantity', 'pi.bound_to', 'pi.position',
      'p.name as preset_name', 'p.details_text', 'p.unit_price_minor', 'p.unit', 'p.price_mode',
      'p.pinned_rate_minor', 'p.quantity_default', 'p.is_active as preset_is_active',
    );
  const byPackage = new Map();
  for (const row of rows) {
    if (!byPackage.has(row.package_id)) byPackage.set(row.package_id, []);
    byPackage.get(row.package_id).push(row);
  }
  return byPackage;
}

async function listPackages({ activeOnly = false, ids = null } = {}) {
  const query = db('quote_packages');
  if (activeOnly) query.where({ is_active: formatBoolean(true) });
  if (Array.isArray(ids)) query.whereIn('id', ids);
  const packages = await query.orderBy('display_order', 'asc').orderBy('id', 'asc');
  const items = await loadPackageItems(packages.map((p) => p.id));
  return packages.map((p) => ({ ...p, items: items.get(p.id) || [] }));
}

async function getPackage(id) {
  const [pkg] = await listPackages({ ids: [id] });
  return pkg || null;
}

/**
 * Create (id = null) or update a package. When `items` is given it replaces
 * the package's item list in order; each item points at a catalogue item.
 */
async function savePackage(id, payload) {
  const items = Array.isArray(payload.items) ? payload.items : null;
  if (items) {
    const presetIds = [...new Set(items.map((it) => ensureInt(it.preset_id)))];
    const found = presetIds.length
      ? await db('quote_line_item_presets').whereIn('id', presetIds).pluck('id')
      : [];
    if (found.length !== presetIds.length) {
      throw new AppError('A package item points at an unknown catalogue item', 400, 'PACKAGE_ITEM_NOT_FOUND');
    }
  }

  const packageId = await db.transaction(async (trx) => {
    const fields = pickDefined(payload, ['name', 'description', 'display_order']);
    if (payload.currency !== undefined) fields.currency = String(payload.currency || 'CHF').toUpperCase();
    if (payload.is_active !== undefined) fields.is_active = formatBoolean(Boolean(payload.is_active));

    let targetId = id;
    if (id) {
      const updated = await trx('quote_packages').where({ id }).update({ ...fields, updated_at: new Date() });
      if (!updated) throw new AppError('Package not found', 404);
    } else {
      targetId = insertedId(await trx('quote_packages').insert({
        name: fields.name,
        description: fields.description || null,
        currency: fields.currency || 'CHF',
        display_order: ensureInt(fields.display_order),
        is_active: formatBoolean(true),
        created_at: new Date(),
        updated_at: new Date(),
      }).returning('id'));
    }

    if (items) {
      await trx('quote_package_items').where({ package_id: targetId }).del();
      const rows = items.map((it, index) => ({
        package_id: targetId,
        preset_id: ensureInt(it.preset_id),
        quantity: it.quantity == null || it.quantity === '' ? null : ensureNumber(it.quantity),
        bound_to: BOUND_TO.includes(it.bound_to) ? it.bound_to : null,
        position: index + 1,
        created_at: new Date(),
        updated_at: new Date(),
      }));
      if (rows.length) await trx('quote_package_items').insert(rows);
    }
    return targetId;
  });
  return getPackage(packageId);
}

async function archivePackage(id) {
  const updated = await db('quote_packages').where({ id })
    .update({ is_active: formatBoolean(false), updated_at: new Date() });
  if (!updated) throw new AppError('Package not found', 404);
}

// ---------------------------------------------------------------------
// Promotions
// ---------------------------------------------------------------------

async function listPromotions({ activeOnly = false } = {}) {
  const query = db('quote_promotions');
  if (activeOnly) query.where({ is_active: formatBoolean(true) });
  return query.orderBy('display_order', 'asc').orderBy('id', 'asc');
}

/** Merge a payload onto an existing promotion and check the result is coherent. */
function promotionFields(payload, existing = {}) {
  const merged = { ...existing, ...pickDefined(payload, ['name', 'description', 'type', 'value_minor', 'currency', 'percent', 'valid_from', 'valid_until', 'display_order']) };
  if (!PROMOTION_TYPES.includes(merged.type)) {
    throw new AppError('A promotion is either a percentage or a fixed amount', 400, 'PROMOTION_TYPE_INVALID');
  }
  const fields = {
    name: merged.name,
    description: merged.description || null,
    type: merged.type,
    valid_from: dateOnly(merged.valid_from),
    valid_until: dateOnly(merged.valid_until),
    display_order: ensureInt(merged.display_order),
  };
  if (fields.valid_from && fields.valid_until && fields.valid_from > fields.valid_until) {
    throw new AppError('"Valid from" must be before "valid until"', 400, 'PROMOTION_DATES_INVALID');
  }
  if (merged.type === 'percent') {
    const percent = ensureNumber(merged.percent, NaN);
    if (!(percent > 0 && percent <= 100)) {
      throw new AppError('A percentage promotion needs a value between 0 and 100', 400, 'PROMOTION_VALUE_INVALID');
    }
    Object.assign(fields, { percent, value_minor: null, currency: null });
  } else {
    const valueMinor = ensureInt(merged.value_minor, -1);
    const currency = merged.currency ? String(merged.currency).toUpperCase() : '';
    if (valueMinor <= 0 || currency.length !== 3) {
      throw new AppError('A fixed promotion needs an amount and a currency', 400, 'PROMOTION_VALUE_INVALID');
    }
    Object.assign(fields, { value_minor: valueMinor, currency, percent: null });
  }
  return fields;
}

async function createPromotion(payload) {
  const id = insertedId(await db('quote_promotions').insert({
    ...promotionFields(payload),
    is_active: formatBoolean(true),
    created_at: new Date(),
    updated_at: new Date(),
  }).returning('id'));
  return db('quote_promotions').where({ id }).first();
}

async function updatePromotion(id, payload) {
  const existing = await db('quote_promotions').where({ id }).first();
  if (!existing) throw new AppError('Promotion not found', 404);
  const updates = { ...promotionFields(payload, existing), updated_at: new Date() };
  if (payload.is_active !== undefined) updates.is_active = formatBoolean(Boolean(payload.is_active));
  await db('quote_promotions').where({ id }).update(updates);
  return db('quote_promotions').where({ id }).first();
}

async function archivePromotion(id) {
  const updated = await db('quote_promotions').where({ id })
    .update({ is_active: formatBoolean(false), updated_at: new Date() });
  if (!updated) throw new AppError('Promotion not found', 404);
}

// ---------------------------------------------------------------------
// Text blocks
// ---------------------------------------------------------------------

async function listTextBlocks({ activeOnly = false, kind = null, language = null } = {}) {
  const query = db('quote_text_blocks');
  if (activeOnly) query.where({ is_active: formatBoolean(true) });
  if (kind) query.where({ kind });
  if (language) query.where({ language });
  return query.orderBy('kind', 'asc').orderBy('display_order', 'asc').orderBy('id', 'asc');
}

/** Refuse placeholders a quote can't fill, so a typo never reaches a customer. */
function assertKnownPlaceholders(body) {
  const unknown = unknownPlaceholders(body);
  if (unknown.length) {
    throw new AppError(
      `Unknown placeholder${unknown.length > 1 ? 's' : ''}: ${unknown.map((k) => `{{${k}}}`).join(', ')}`,
      400,
      'TEXT_BLOCK_UNKNOWN_PLACEHOLDERS',
    );
  }
}

function textBlockFields(payload) {
  const fields = pickDefined(payload, ['kind', 'language', 'name', 'body', 'display_order']);
  if (fields.kind !== undefined && !TEXT_BLOCK_KINDS.includes(fields.kind)) {
    throw new AppError('Unknown text block kind', 400, 'TEXT_BLOCK_KIND_INVALID');
  }
  if (fields.body !== undefined) assertKnownPlaceholders(fields.body);
  return fields;
}

async function createTextBlock(payload) {
  const fields = textBlockFields(payload);
  const id = insertedId(await db('quote_text_blocks').insert({
    kind: fields.kind,
    language: fields.language || 'de',
    name: fields.name,
    body: fields.body,
    display_order: ensureInt(fields.display_order),
    is_active: formatBoolean(true),
    created_at: new Date(),
    updated_at: new Date(),
  }).returning('id'));
  return db('quote_text_blocks').where({ id }).first();
}

async function updateTextBlock(id, payload) {
  const updates = { ...textBlockFields(payload), updated_at: new Date() };
  if (payload.is_active !== undefined) updates.is_active = formatBoolean(Boolean(payload.is_active));
  const updated = await db('quote_text_blocks').where({ id }).update(updates);
  if (!updated) throw new AppError('Text block not found', 404);
  return db('quote_text_blocks').where({ id }).first();
}

async function archiveTextBlock(id) {
  const updated = await db('quote_text_blocks').where({ id })
    .update({ is_active: formatBoolean(false), updated_at: new Date() });
  if (!updated) throw new AppError('Text block not found', 404);
}

// ---------------------------------------------------------------------
// Line preparation (used by quoteService.createQuote / updateQuote)
// ---------------------------------------------------------------------

/**
 * Throw unless the promotion can be applied to a quote in `currency` today.
 */
function assertPromotionApplicable(promotion, currency) {
  if (!isTruthyFlag(promotion.is_active)) {
    throw new AppError(`Promotion "${promotion.name}" is inactive`, 400, 'PROMOTION_INACTIVE');
  }
  const today = todayIso();
  const from = dateOnly(promotion.valid_from);
  const until = dateOnly(promotion.valid_until);
  if ((from && today < from) || (until && today > until)) {
    throw new AppError(`Promotion "${promotion.name}" is not valid today`, 400, 'PROMOTION_NOT_VALID_TODAY');
  }
  if (promotion.type === 'fixed' && promotion.currency && currency
    && String(promotion.currency).toUpperCase() !== String(currency).toUpperCase()) {
    throw new AppError(
      `Promotion "${promotion.name}" is in ${promotion.currency}, the quote is in ${currency}`,
      400,
      'PROMOTION_CURRENCY_MISMATCH',
    );
  }
}

function promotionSnapshot(promotion) {
  const snapshot = { promotionId: promotion.id, name: promotion.name, type: promotion.type };
  if (promotion.type === 'percent') {
    snapshot.percent = ensureNumber(promotion.percent, 0);
  } else {
    snapshot.valueMinor = ensureInt(promotion.value_minor);
    snapshot.currency = promotion.currency || null;
  }
  return snapshot;
}

/**
 * Resolve the server-side parts of a quote's line items before totals:
 *   - lines bound to the quote-wide hours / days take that quantity;
 *   - lines the editor marked `rate_source = 'auto'` get the customer's or
 *     the business default hour/day rate copied into unit_price_minor
 *     (the rate is a snapshot — a later rate change doesn't touch the line);
 *   - discount lines picked by `promotion_id` get a promotion snapshot.
 * Lines that already carry a snapshot or a stored rate are left as they are.
 *
 * @returns {Promise<Array<object>>} new line items; the wire-only
 *   `promotion_id` is removed
 */
async function prepareQuoteLineItems(items, { customerId, currency, hours, days } = {}) {
  if (!Array.isArray(items) || items.length === 0) return [];

  const needsRates = items.some((li) => li.rate_source === 'auto');
  const rates = needsRates ? await rateResolver.loadRates(customerId) : null;

  const promotionIds = [...new Set(items
    .filter((li) => li.line_kind === 'discount' && li.promotion_id && !li.promotion_snapshot)
    .map((li) => ensureInt(li.promotion_id)))];
  const promotions = promotionIds.length
    ? await db('quote_promotions').whereIn('id', promotionIds)
    : [];
  const promotionsById = new Map(promotions.map((p) => [ensureInt(p.id), p]));

  return items.map((li) => {
    const { promotion_id: promotionId, ...out } = li;

    if (out.bound_to === 'hours' && hours != null && hours !== '') out.quantity = ensureNumber(hours, out.quantity);
    if (out.bound_to === 'days' && days != null && days !== '') out.quantity = ensureNumber(days, out.quantity);

    if (out.rate_source === 'auto') {
      if (out.price_mode !== 'hour' && out.price_mode !== 'day') {
        out.rate_source = null;
      } else {
        const rate = rateResolver.pickRate(rates, out.price_mode);
        if (!rate) {
          throw new AppError(
            out.price_mode === 'hour'
              ? 'No hourly rate is set for this customer or in the business profile'
              : 'No day rate is set for this customer or in the business profile',
            400,
            'RATE_REQUIRED',
          );
        }
        out.unit_price_minor = rate.rateMinor;
        out.rate_source = rate.source;
      }
    }

    if (out.line_kind === 'discount' && promotionId && !out.promotion_snapshot) {
      const promotion = promotionsById.get(ensureInt(promotionId));
      if (!promotion) throw new AppError('Promotion not found', 400, 'PROMOTION_NOT_FOUND');
      assertPromotionApplicable(promotion, currency);
      out.promotion_snapshot = promotionSnapshot(promotion);
      if (!out.description) out.description = promotion.name;
    }
    return out;
  });
}

module.exports = {
  TEXT_BLOCK_KINDS,
  PROMOTION_TYPES,
  dateOnly,
  listPackages,
  getPackage,
  savePackage,
  archivePackage,
  listPromotions,
  createPromotion,
  updatePromotion,
  archivePromotion,
  listTextBlocks,
  createTextBlock,
  updateTextBlock,
  archiveTextBlock,
  assertKnownPlaceholders,
  prepareQuoteLineItems,
  assertPromotionApplicable,
  promotionSnapshot,
};
