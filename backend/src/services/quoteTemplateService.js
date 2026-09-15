'use strict';

/**
 * Quote templates (#1451).
 *
 * A template has an editable working copy (`draft_snapshot`) and immutable
 * published versions (`quote_template_versions`). Publishing resolves the
 * working copy — catalogue items, packages, text blocks — into a fully
 * self-contained snapshot, so later catalogue edits never change what an
 * already published version creates. A quote created from a template is an
 * ordinary, fully editable quote: the template only fills it in.
 *
 * Working copy (camelCase, as the editor sends it):
 *   sections: [
 *     { type: 'item',    presetId, quantity?, boundTo?, isOptional? },
 *     { type: 'package', packageId, isOptional? },
 *     { type: 'line',    line: {...}, children: [{...}], isOptional? },
 *   ]
 *   introTextBlockId? | introText?, outroTextBlockId? | outroText?,
 *   promotionIds[], hours?, days?, validityDays?, paymentNetDaysTemplateId?,
 *   paymentTimingTemplateId?, bookingWorkflowId?, vatRate?, vatCode?
 *
 * Packages follow the pricing rule agreed for #1451: a package with one item
 * carries the price on the package line (the item is listed below it without
 * a price); a package with several items lists each item with its price and
 * the package line shows their sum (the existing auto-sum of priced
 * sub-items).
 */

const { db, logActivity } = require('../database/db');
const { AppError } = require('../utils/errors');
const { isUniqueViolation } = require('../utils/dbErrors');
const { ensureInt, ensureNumber } = require('../utils/numericHelpers');
const {
  isTruthyFlag, parsePromotionSnapshot, UNITS, PRICE_MODES, BOUND_TO,
} = require('../utils/lineItemTotals');
const { unknownPlaceholders, renderPlaceholders } = require('../utils/placeholders');
const { formatShortDate } = require('../utils/dateFormatter');
const { buildIssuerBlock } = require('./_renderContext');
const businessProfileService = require('./businessProfileService');
const quoteCatalogService = require('./quoteCatalogService');
const rateResolver = require('./rateResolver');

const MAX_SECTIONS = 200;
const MAX_CHILDREN = 100;
const MAX_PROMOTIONS = 20;

// quoteService requires quoteCatalogService, which this module requires too;
// resolve quoteService lazily so neither load order matters.
const quoteService = () => require('./quoteService');

function insertedId(inserted) {
  return typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];
}

function parseSnapshot(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

function emptyDraft() {
  return {
    sections: [],
    introTextBlockId: null,
    introText: null,
    outroTextBlockId: null,
    outroText: null,
    promotionIds: [],
    hours: null,
    days: null,
    validityDays: null,
    paymentNetDaysTemplateId: null,
    paymentTimingTemplateId: null,
    bookingWorkflowId: null,
    vatRate: null,
    vatCode: null,
  };
}

// ---------------------------------------------------------------------
// Working-copy validation
// ---------------------------------------------------------------------

function invalid(message) {
  return new AppError(message, 400, 'TEMPLATE_INVALID');
}

const oneOf = (value, allowed) => (allowed.includes(value) ? value : null);
const optionalInt = (value) => (value == null || value === '' ? null : ensureInt(value) || null);
const optionalText = (value, max) => (value == null || value === '' ? null : String(value).slice(0, max));

function optionalNumber(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value == null || value === '') return null;
  const n = ensureNumber(value, NaN);
  if (!Number.isFinite(n) || n < min || n > max) throw invalid('A number in this template is out of range');
  return n;
}

function sanitizeLine(raw) {
  const line = raw && typeof raw === 'object' ? raw : {};
  const description = String(line.description || '').trim();
  if (!description) throw invalid('Every template line needs a description');
  const priceMode = oneOf(line.priceMode, PRICE_MODES);
  const rateBased = priceMode === 'hour' || priceMode === 'day';
  return {
    description: description.slice(0, 1000),
    quantity: optionalNumber(line.quantity) ?? 1,
    unitPriceMinor: line.unitPriceMinor == null || line.unitPriceMinor === '' ? 0 : ensureInt(line.unitPriceMinor),
    discountPercent: optionalNumber(line.discountPercent, { max: 100 }) ?? 0,
    unit: oneOf(line.unit, UNITS),
    priceMode: rateBased ? priceMode : null,
    boundTo: oneOf(line.boundTo, BOUND_TO),
    // 'auto' = take the customer's / default rate when the quote is created.
    rateSource: rateBased ? oneOf(line.rateSource, ['auto', 'item', 'manual']) : null,
    detailsText: optionalText(line.detailsText, 2000),
  };
}

/** Validate and normalise an editor-supplied working copy. */
function sanitizeDraft(raw) {
  const draft = raw && typeof raw === 'object' ? raw : {};
  const sections = Array.isArray(draft.sections) ? draft.sections : [];
  if (sections.length > MAX_SECTIONS) throw invalid(`A template can hold at most ${MAX_SECTIONS} sections`);
  const promotionIds = Array.isArray(draft.promotionIds) ? draft.promotionIds : [];

  return {
    sections: sections.map((rawSection) => {
      const section = rawSection && typeof rawSection === 'object' ? rawSection : {};
      const isOptional = isTruthyFlag(section.isOptional);
      if (section.type === 'item') {
        const presetId = optionalInt(section.presetId);
        if (!presetId) throw invalid('A catalogue section needs an item');
        return {
          type: 'item', presetId, quantity: optionalNumber(section.quantity), boundTo: oneOf(section.boundTo, BOUND_TO), isOptional,
        };
      }
      if (section.type === 'package') {
        const packageId = optionalInt(section.packageId);
        if (!packageId) throw invalid('A package section needs a package');
        return { type: 'package', packageId, isOptional };
      }
      if (section.type === 'line') {
        const children = Array.isArray(section.children) ? section.children : [];
        if (children.length > MAX_CHILDREN) throw invalid(`A line can hold at most ${MAX_CHILDREN} sub-items`);
        return { type: 'line', line: sanitizeLine(section.line), children: children.map(sanitizeLine), isOptional };
      }
      throw invalid(`Unknown template section type: ${section.type}`);
    }),
    introTextBlockId: optionalInt(draft.introTextBlockId),
    introText: optionalText(draft.introText, 5000),
    outroTextBlockId: optionalInt(draft.outroTextBlockId),
    outroText: optionalText(draft.outroText, 5000),
    promotionIds: [...new Set(promotionIds.map(optionalInt).filter(Boolean))].slice(0, MAX_PROMOTIONS),
    hours: optionalNumber(draft.hours, { max: 9999 }),
    days: optionalNumber(draft.days, { max: 999 }),
    validityDays: draft.validityDays == null || draft.validityDays === ''
      ? null
      : Math.min(365, Math.max(1, ensureInt(draft.validityDays))),
    paymentNetDaysTemplateId: optionalInt(draft.paymentNetDaysTemplateId),
    paymentTimingTemplateId: optionalInt(draft.paymentTimingTemplateId),
    bookingWorkflowId: optionalInt(draft.bookingWorkflowId),
    vatRate: optionalNumber(draft.vatRate, { max: 100 }),
    vatCode: optionalText(draft.vatCode, 16),
  };
}

// ---------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------

async function listTemplates({ publishedOnly = false } = {}) {
  const query = db('quote_templates');
  if (publishedOnly) query.where({ status: 'published' });
  return query.orderBy('name', 'asc').orderBy('id', 'asc');
}

async function getTemplate(id) {
  const template = await db('quote_templates').where({ id }).first();
  if (!template) return null;
  const versions = await db('quote_template_versions').where({ template_id: id }).orderBy('version', 'desc');
  return { template, versions };
}

function templateColumns(payload) {
  const out = {};
  if (payload.name !== undefined) out.name = String(payload.name).trim().slice(0, 128);
  if (payload.description !== undefined) out.description = payload.description || null;
  if (payload.event_type !== undefined) out.event_type = payload.event_type || null;
  if (payload.language !== undefined) out.language = payload.language || null;
  if (payload.currency !== undefined) out.currency = payload.currency ? String(payload.currency).toUpperCase() : null;
  if (payload.draft !== undefined) out.draft_snapshot = JSON.stringify(sanitizeDraft(payload.draft));
  return out;
}

async function createTemplate(payload, adminId) {
  const id = insertedId(await db('quote_templates').insert({
    draft_snapshot: JSON.stringify(emptyDraft()),
    ...templateColumns(payload),
    status: 'draft',
    created_by_admin_id: adminId || null,
    created_at: new Date(),
    updated_at: new Date(),
  }).returning('id'));
  try {
    await logActivity('quote_template_created', { templateId: id }, null, `admin:${adminId}`);
  } catch (_) { /* non-fatal */ }
  return id;
}

async function loadEditableTemplate(id) {
  const template = await db('quote_templates').where({ id }).first();
  if (!template) throw new AppError('Template not found', 404);
  if (template.status === 'archived') {
    throw new AppError('This template is archived', 409, 'TEMPLATE_ARCHIVED');
  }
  return template;
}

/** Save metadata and/or the working copy. Published versions are untouched. */
async function updateTemplate(id, payload) {
  await loadEditableTemplate(id);
  await db('quote_templates').where({ id }).update({ ...templateColumns(payload), updated_at: new Date() });
}

async function archiveTemplate(id) {
  const updated = await db('quote_templates').where({ id })
    .update({ status: 'archived', updated_at: new Date() });
  if (!updated) throw new AppError('Template not found', 404);
}

// ---------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------

function blankLine() {
  return {
    description: '',
    quantity: 1,
    unitPriceMinor: 0,
    discountPercent: 0,
    unit: null,
    priceMode: null,
    boundTo: null,
    rateSource: null,
    detailsText: null,
  };
}

/**
 * A template line from a catalogue item. Fixed prices are copied; hour/day
 * items copy their pinned rate, or take the customer's / default rate when
 * the quote is created ('auto').
 */
function presetLine(preset, quantity, boundTo) {
  const priceMode = PRICE_MODES.includes(preset.price_mode) ? preset.price_mode : 'fixed';
  const rateBased = priceMode !== 'fixed';
  const line = {
    ...blankLine(),
    description: preset.name,
    quantity: quantity == null ? ensureNumber(preset.quantity_default, 1) : ensureNumber(quantity, 1),
    unit: preset.unit || (rateBased ? priceMode : null),
    priceMode: rateBased ? priceMode : null,
    boundTo: oneOf(boundTo, BOUND_TO),
    detailsText: preset.details_text || null,
  };
  if (!rateBased) {
    line.unitPriceMinor = ensureInt(preset.unit_price_minor);
  } else if (preset.pinned_rate_minor != null) {
    line.unitPriceMinor = ensureInt(preset.pinned_rate_minor);
    line.rateSource = 'item';
  } else {
    line.rateSource = 'auto';
  }
  return line;
}

function packageLine(pkg, isOptional) {
  if (!isTruthyFlag(pkg.is_active)) {
    throw new AppError(`Package "${pkg.name}" is archived — pick another one`, 400, 'TEMPLATE_PACKAGE_ARCHIVED');
  }
  if (pkg.items.length === 0) {
    throw new AppError(`Package "${pkg.name}" has no items`, 400, 'TEMPLATE_PACKAGE_EMPTY');
  }
  const archived = pkg.items.find((it) => !isTruthyFlag(it.preset_is_active));
  if (archived) {
    throw new AppError(`"${archived.preset_name}" in package "${pkg.name}" is archived`, 400, 'TEMPLATE_ITEM_ARCHIVED');
  }
  const itemLines = pkg.items.map((it) => presetLine({ ...it, name: it.preset_name }, it.quantity, it.bound_to));

  if (itemLines.length === 1) {
    // One item: the package line carries the price, the item is listed
    // below it without one (and follows the same hours/days binding).
    const [only] = itemLines;
    return {
      ...only,
      description: pkg.name,
      detailsText: pkg.description || null,
      isOptional,
      children: [{
        ...blankLine(), description: only.description, quantity: only.quantity, unit: only.unit, boundTo: only.boundTo,
      }],
    };
  }
  // Several items: each is priced, the package line shows their sum.
  return {
    ...blankLine(), description: pkg.name, detailsText: pkg.description || null, isOptional, children: itemLines,
  };
}

function assertKnownPlaceholders(texts) {
  const unknown = [...new Set(texts.flatMap((text) => unknownPlaceholders(text)))];
  if (unknown.length) {
    throw new AppError(
      `Unknown placeholder${unknown.length > 1 ? 's' : ''}: ${unknown.map((k) => `{{${k}}}`).join(', ')}`,
      400,
      'TEMPLATE_UNKNOWN_PLACEHOLDERS',
    );
  }
}

/** Resolve a working copy into a self-contained version snapshot. */
async function resolveDraft(draft) {
  const presetIds = draft.sections.filter((s) => s.type === 'item').map((s) => s.presetId);
  const packageIds = draft.sections.filter((s) => s.type === 'package').map((s) => s.packageId);
  const blockIds = [draft.introTextBlockId, draft.outroTextBlockId].filter(Boolean);

  const [presets, packages, blocks] = await Promise.all([
    presetIds.length ? db('quote_line_item_presets').whereIn('id', presetIds) : [],
    packageIds.length ? quoteCatalogService.listPackages({ ids: packageIds }) : [],
    blockIds.length ? db('quote_text_blocks').whereIn('id', blockIds) : [],
  ]);
  const presetById = new Map(presets.map((p) => [ensureInt(p.id), p]));
  const packageById = new Map(packages.map((p) => [ensureInt(p.id), p]));
  const blockById = new Map(blocks.map((b) => [ensureInt(b.id), b]));

  const lines = draft.sections.map((section) => {
    if (section.type === 'item') {
      const preset = presetById.get(section.presetId);
      if (!preset) throw new AppError('A catalogue item in this template no longer exists', 400, 'TEMPLATE_ITEM_NOT_FOUND');
      if (!isTruthyFlag(preset.is_active)) {
        throw new AppError(`"${preset.name}" is archived — pick another item`, 400, 'TEMPLATE_ITEM_ARCHIVED');
      }
      return { ...presetLine(preset, section.quantity, section.boundTo), isOptional: section.isOptional, children: [] };
    }
    if (section.type === 'package') {
      const pkg = packageById.get(section.packageId);
      if (!pkg) throw new AppError('A package in this template no longer exists', 400, 'TEMPLATE_PACKAGE_NOT_FOUND');
      return packageLine(pkg, section.isOptional);
    }
    return { ...section.line, isOptional: section.isOptional, children: section.children };
  });

  const blockText = (blockId, fallback) => {
    if (!blockId) return fallback;
    const block = blockById.get(blockId);
    if (!block) throw new AppError('A text block in this template no longer exists', 400, 'TEMPLATE_TEXT_BLOCK_NOT_FOUND');
    return block.body;
  };
  const introText = blockText(draft.introTextBlockId, draft.introText);
  const outroText = blockText(draft.outroTextBlockId, draft.outroText);
  assertKnownPlaceholders([introText, outroText]);

  return {
    lines,
    introText,
    outroText,
    promotionIds: draft.promotionIds,
    hours: draft.hours,
    days: draft.days,
    validityDays: draft.validityDays,
    paymentNetDaysTemplateId: draft.paymentNetDaysTemplateId,
    paymentTimingTemplateId: draft.paymentTimingTemplateId,
    bookingWorkflowId: draft.bookingWorkflowId,
    vatRate: draft.vatRate,
    vatCode: draft.vatCode,
  };
}

/** Freeze the working copy as the next immutable version. Returns its number. */
async function publishTemplate(id, adminId) {
  const template = await loadEditableTemplate(id);
  const draft = sanitizeDraft(parseSnapshot(template.draft_snapshot) || emptyDraft());
  if (draft.sections.length === 0) {
    throw new AppError('Add at least one section before publishing', 400, 'TEMPLATE_EMPTY');
  }
  const snapshot = {
    ...(await resolveDraft(draft)),
    language: template.language || null,
    currency: template.currency || null,
    eventType: template.event_type || null,
  };

  let version;
  try {
    version = await db.transaction(async (trx) => {
      const last = await trx('quote_template_versions').where({ template_id: id }).max('version as v').first();
      const next = ensureInt(last && last.v) + 1;
      await trx('quote_template_versions').insert({
        template_id: id,
        version: next,
        snapshot: JSON.stringify(snapshot),
        published_at: new Date(),
        published_by_admin_id: adminId || null,
      });
      await trx('quote_templates').where({ id }).update({ status: 'published', current_version: next, updated_at: new Date() });
      return next;
    });
  } catch (err) {
    // Two publishes at once both claim the same next number; the unique
    // (template_id, version) index lets one win.
    if (isUniqueViolation(err)) {
      throw new AppError('This template was just published by someone else — reload and try again', 409, 'TEMPLATE_PUBLISH_CONFLICT');
    }
    throw err;
  }
  try {
    await logActivity('quote_template_published', { templateId: id, version }, null, `admin:${adminId}`);
  } catch (_) { /* non-fatal */ }
  return version;
}

// ---------------------------------------------------------------------
// Quote from template / template from quote
// ---------------------------------------------------------------------

function firstNumber(...values) {
  for (const value of values) {
    if (value != null && value !== '') return ensureNumber(value);
  }
  return null;
}

function toServiceLine(line, { position, parentPosition = null }) {
  const isTopLevel = parentPosition == null;
  const isOptional = isTopLevel && Boolean(line.isOptional);
  return {
    position,
    parent_position: parentPosition,
    quantity: line.quantity ?? 1,
    description: line.description,
    unit_price_minor: ensureInt(line.unitPriceMinor),
    discount_percent: ensureNumber(line.discountPercent, 0),
    details_text: line.detailsText || null,
    line_kind: 'item',
    unit: line.unit || null,
    // An optional add-on starts unticked: the customer opts in.
    is_optional: isOptional,
    selected: !isOptional,
    price_mode: line.priceMode || null,
    rate_source: line.rateSource || null,
    bound_to: line.boundTo || null,
  };
}

async function placeholderValues(quote, customer, profile) {
  // The editor preview can render before a customer is picked.
  const c = customer || {};
  const rates = customer ? await rateResolver.loadRates(customer.id) : null;
  const hourly = rates ? rateResolver.pickRate(rates, 'hour') : null;
  const daily = rates ? rateResolver.pickRate(rates, 'day') : null;
  const { formatMajor } = quoteService()._internal;
  const country = buildIssuerBlock(profile, null).countryCode;
  const money = (rate) => (rate ? formatMajor(rate.rateMinor, quote.currency, quote.language, country) : null);
  const number = (value) => (value == null || value === '' ? null : String(Number(value)));
  const person = [c.first_name, c.last_name].map((s) => (s || '').trim()).filter(Boolean).join(' ');
  return {
    customer_name: person || (c.display_name || '').trim() || (c.company_name || '').trim() || c.email || null,
    customer_company: (c.company_name || '').trim() || null,
    event_name: quote.event_name || null,
    event_date: quote.event_date ? formatShortDate(quote.event_date) : null,
    quote_number: quote.quote_number,
    valid_until: quote.valid_until ? formatShortDate(quote.valid_until) : null,
    business_name: profile?.company_name || null,
    hours: number(quote.hours),
    days: number(quote.days),
    hourly_rate: money(hourly),
    day_rate: money(daily),
  };
}

/**
 * A quote's intro / outro with its allowlisted {{placeholders}} filled in
 * from the quote's own data. The quote row keeps the raw text: resolving
 * happens wherever the text is shown (PDF, public quote page, customer
 * portal), so later edits, a rate recalculation and "save as template" still
 * see the placeholders, and a value that isn't known yet (an event date)
 * fills in once it is. Unknown keys stay visible. `customer` and `profile`
 * are loaded when the caller doesn't pass them.
 */
async function resolveQuoteTexts(quote, { customer, profile } = {}) {
  const raw = { introText: quote.intro_text ?? null, outroText: quote.outro_text ?? null };
  const hasPlaceholders = [raw.introText, raw.outroText]
    .some((text) => typeof text === 'string' && text.includes('{{'));
  if (!hasPlaceholders) return raw;
  const who = customer !== undefined
    ? customer
    : await db('customer_accounts').where({ id: quote.customer_account_id }).first();
  const biz = profile !== undefined ? profile : (await businessProfileService.getProfile()).profile;
  const values = await placeholderValues(quote, who || null, biz);
  return {
    introText: renderPlaceholders(raw.introText, values),
    outroText: renderPlaceholders(raw.outroText, values),
  };
}

/**
 * Create a quote from the latest (or a given) published version. Returns
 * `{ quoteId, version, skippedPromotions }` — pre-ticked promotions that
 * aren't valid today are left out rather than blocking the quote.
 */
async function createQuoteFromTemplate(templateId, payload, adminId) {
  const template = await loadEditableTemplate(templateId);
  const versions = db('quote_template_versions').where({ template_id: templateId });
  const versionRow = payload.version
    ? await versions.where({ version: payload.version }).first()
    : await versions.orderBy('version', 'desc').first();
  if (!versionRow) {
    throw payload.version
      ? new AppError('Template version not found', 404, 'TEMPLATE_VERSION_NOT_FOUND')
      : new AppError('Publish this template before creating quotes from it', 409, 'TEMPLATE_NOT_PUBLISHED');
  }
  const snapshot = parseSnapshot(versionRow.snapshot) || {};
  const customer = await db('customer_accounts').where({ id: payload.customerAccountId }).first();
  if (!customer) throw new AppError('Customer not found', 404);
  const { profile } = await businessProfileService.getProfile();
  const currency = String(snapshot.currency || profile?.default_currency || 'CHF').toUpperCase();

  const lineItems = [];
  let position = 0;
  for (const line of snapshot.lines || []) {
    position += 1;
    const parentPosition = position;
    lineItems.push(toServiceLine(line, { position }));
    for (const child of line.children || []) {
      position += 1;
      lineItems.push(toServiceLine(child, { position, parentPosition }));
    }
  }

  const skippedPromotions = [];
  const promotionIds = Array.isArray(snapshot.promotionIds) ? snapshot.promotionIds : [];
  if (promotionIds.length) {
    const promotions = await db('quote_promotions').whereIn('id', promotionIds);
    const byId = new Map(promotions.map((p) => [ensureInt(p.id), p]));
    for (const id of promotionIds) {
      const promotion = byId.get(ensureInt(id));
      try {
        if (!promotion) throw new Error('missing');
        quoteCatalogService.assertPromotionApplicable(promotion, currency);
      } catch (_) {
        skippedPromotions.push(promotion ? promotion.name : `#${id}`);
        continue;
      }
      position += 1;
      lineItems.push({
        position, quantity: 1, description: promotion.name, unit_price_minor: 0, discount_percent: 0,
        line_kind: 'discount', promotion_id: promotion.id,
      });
    }
  }

  const validUntil = snapshot.validityDays
    ? new Date(Date.now() + snapshot.validityDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    : undefined;

  const quoteId = await quoteService().createQuote({
    customerAccountId: customer.id,
    currency,
    language: snapshot.language || undefined,
    eventName: payload.eventName || null,
    eventDate: payload.eventDate || null,
    eventType: snapshot.eventType || undefined,
    bookingWorkflowId: snapshot.bookingWorkflowId || undefined,
    paymentNetDaysTemplateId: snapshot.paymentNetDaysTemplateId || null,
    paymentTimingTemplateId: snapshot.paymentTimingTemplateId || null,
    vatRate: snapshot.vatRate ?? undefined,
    vatCode: snapshot.vatCode || undefined,
    validUntil,
    hours: firstNumber(payload.hours, snapshot.hours),
    days: firstNumber(payload.days, snapshot.days),
    introText: snapshot.introText || null,
    outroText: snapshot.outroText || null,
    lineItems,
    sourceTemplateId: template.id,
    sourceTemplateVersion: versionRow.version,
  }, adminId);

  try {
    await logActivity('quote_created_from_template',
      { quoteId, templateId: template.id, version: Number(versionRow.version) }, null, `admin:${adminId}`);
  } catch (_) { /* non-fatal */ }
  return { quoteId, version: Number(versionRow.version), skippedPromotions };
}

function quoteLineToDraft(li) {
  // Rates the quote took from the customer or the business default go back
  // to "use the rate", so the template stays customer-neutral.
  const fromChain = li.rate_source === 'customer' || li.rate_source === 'default';
  return {
    description: li.description,
    quantity: Number(li.quantity),
    unitPriceMinor: fromChain ? 0 : ensureInt(li.unit_price_minor),
    discountPercent: Number(li.discount_percent || 0),
    unit: li.unit || null,
    priceMode: li.price_mode || null,
    boundTo: li.bound_to || null,
    rateSource: fromChain ? 'auto' : (li.rate_source || null),
    detailsText: li.details_text || null,
  };
}

/** Save an existing quote as a new draft template. Returns the template id. */
async function saveQuoteAsTemplate(quoteId, { name }, adminId) {
  const data = await quoteService().getQuoteById(quoteId);
  if (!data) throw new AppError('Quote not found', 404);
  const { quote, lineItems } = data;

  const sections = [];
  const promotionIds = [];
  for (const li of lineItems.filter((row) => row.parent_line_item_id == null)) {
    if (li.line_kind === 'discount') {
      const snapshot = parsePromotionSnapshot(li.promotion_snapshot);
      if (snapshot && snapshot.promotionId) promotionIds.push(snapshot.promotionId);
      continue;
    }
    sections.push({
      type: 'line',
      line: quoteLineToDraft(li),
      children: lineItems.filter((c) => c.parent_line_item_id === li.id).map(quoteLineToDraft),
      isOptional: isTruthyFlag(li.is_optional),
    });
  }

  return createTemplate({
    name,
    event_type: quote.event_type || null,
    language: quote.language || null,
    currency: quote.currency || null,
    draft: {
      sections,
      introText: quote.intro_text,
      outroText: quote.outro_text,
      promotionIds,
      hours: quote.hours,
      days: quote.days,
      paymentNetDaysTemplateId: quote.payment_net_days_template_id,
      paymentTimingTemplateId: quote.payment_timing_template_id,
      bookingWorkflowId: quote.booking_workflow_id,
      vatRate: quote.vat_rate,
      vatCode: quote.vat_code,
    },
  }, adminId);
}

module.exports = {
  parseSnapshot,
  emptyDraft,
  sanitizeDraft,
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  archiveTemplate,
  publishTemplate,
  createQuoteFromTemplate,
  saveQuoteAsTemplate,
  resolveQuoteTexts,
};
