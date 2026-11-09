'use strict';

/**
 * System clauses written for one legal system.
 *
 * The seeded closing provisions name Swiss or German law, and the
 * data-protection clause cites the GDPR and the Swiss FADP: none of them
 * belongs in a contract from a business in the United States or the United
 * Kingdom, and the US and UK clauses belong in no one else's. The standard
 * contract keeps the European clauses — it is shared by every install and
 * built before a country is set — and a new contract made from it, or from
 * the system blocks directly, is fitted to the business's legal system:
 *
 *   - United States: the US closing provisions take the place of the first
 *     European closing clause.
 *   - United Kingdom (issue 2439): UK closing provisions, UK data protection
 *     and a deposit/cancellation clause take the places of the European
 *     closing, data-protection and tiered-cancellation clauses; the moral
 *     rights assertion and the portfolio consent follow the image-rights
 *     clauses; and a consumer's contract adds the 14-day cancellation notice
 *     after the deposit clause (utils/customerKind).
 *
 * A template an admin built is taken as they built it.
 */

const { db } = require('../../database/db');
const { isUnitedStates, isUnitedKingdom } = require('../../utils/postalAddress');
const { isBusinessCustomer } = require('../../utils/customerKind');
const content = require('./content');

const US_CLOSING = 'closing_jurisdiction_us';
const EUROPEAN_ONLY = new Set(['closing_jurisdiction_ch', 'closing_jurisdiction_de', 'dsgvo_data_protection']);

// UK clauses (contractBlocksService seeds them at runtime).
const GB_CLOSING = 'closing_jurisdiction_gb';
const GB_DATA_PROTECTION = 'data_protection_uk';
const GB_DEPOSIT = 'deposit_cancellation_gb';
const GB_MORAL_RIGHTS = 'moral_rights_gb';
const GB_PORTFOLIO = 'portfolio_consent_gb';
const GB_CONSUMER_CANCELLATION = 'consumer_cancellation_gb';
const GB_ONLY = new Set([GB_CLOSING, GB_DATA_PROTECTION, GB_DEPOSIT, GB_MORAL_RIGHTS, GB_PORTFOLIO, GB_CONSUMER_CANCELLATION]);
// A seeded clause a UK contract replaces although it isn't European-only:
// the tiered fees (75 % / 100 %) need the CMA37 test for UK consumers.
const GB_REPLACES = { cancellation_tiered: GB_DEPOSIT, dsgvo_data_protection: GB_DATA_PROTECTION };

/** Is this the clause only a US business's contracts carry? */
function isUsOnlyClause(slug) {
  return slug === US_CLOSING;
}

/** Does this clause belong to one country's legal system only (US or UK)? */
function isRegionalOnlyClause(slug) {
  return isUsOnlyClause(slug) || GB_ONLY.has(slug);
}

/** Does this clause belong in a new contract from a business in `countryCode`? */
function appliesTo(slug, countryCode) {
  if (isUnitedStates(countryCode)) return !EUROPEAN_ONLY.has(slug) && !GB_ONLY.has(slug);
  if (isUnitedKingdom(countryCode)) return !EUROPEAN_ONLY.has(slug) && !isUsOnlyClause(slug);
  return !isRegionalOnlyClause(slug);
}

/**
 * The consumer-only cancellation notice stays out of a contract for a known
 * business customer. Without a customer (the library list) it stays in.
 */
function fitsCustomer(slug, customer) {
  return slug !== GB_CONSUMER_CANCELLATION || !customer || !isBusinessCustomer(customer);
}

/** The blocks of `blocks` a new contract without a template starts from. */
function systemBlocksFor(blocks, countryCode, customer = null) {
  const present = new Set(blocks.map((block) => block.slug));
  // A UK business's replacement takes the clause's place — while it exists.
  const replaced = (slug) => isUnitedKingdom(countryCode)
    && Object.prototype.hasOwnProperty.call(GB_REPLACES, slug) && present.has(GB_REPLACES[slug]);
  return blocks.filter((block) => appliesTo(block.slug, countryCode)
    && !replaced(block.slug)
    && fitsCustomer(block.slug, customer));
}

/**
 * A template item standing for `block` in the place of `item`, or — `added` —
 * a new item next to it (no id of its own: it isn't a row of the version).
 */
function itemFor(item, block, slug, { added = false } = {}) {
  const base = { ...item };
  if (added) delete base.id;
  return {
    ...base,
    block_id: block.id,
    block_slug: slug,
    body_snapshot: content.serializeLocaleMap(content.blockBodies(block)),
    body_override: null,
  };
}

/**
 * The standard contract's items for a UK business (see the header). `gbBlocks`
 * maps a GB slug to its contract_blocks row; a clause an admin retired is
 * missing from it and simply left out.
 */
function ukItemsFor(items, gbBlocks, customer) {
  const has = (slug) => items.some((item) => item.kind === 'block' && item.block_slug === slug);
  const out = [];
  let closingPlaced = has(GB_CLOSING);
  const lastScope = items.reduce((at, item, i) => (item.kind === 'block' && item.section === 'scope' ? i : at), -1);
  items.forEach((item, i) => {
    const slug = item.kind === 'block' ? item.block_slug : null;
    if (slug && Object.prototype.hasOwnProperty.call(GB_REPLACES, slug)) {
      const replacement = GB_REPLACES[slug];
      if (gbBlocks[replacement] && !has(replacement)) out.push(itemFor(item, gbBlocks[replacement], replacement));
      // Without its replacement a European-only clause still goes; the
      // tiered cancellation clause stays rather than leave a gap.
      else if (!gbBlocks[replacement] && !EUROPEAN_ONLY.has(slug)) out.push(item);
      if (replacement === GB_DEPOSIT && gbBlocks[GB_CONSUMER_CANCELLATION] && !has(GB_CONSUMER_CANCELLATION)
        && fitsCustomer(GB_CONSUMER_CANCELLATION, customer)) {
        out.push(itemFor(item, gbBlocks[GB_CONSUMER_CANCELLATION], GB_CONSUMER_CANCELLATION, { added: true }));
      }
    } else if (slug && EUROPEAN_ONLY.has(slug)) {
      if (gbBlocks[GB_CLOSING] && !closingPlaced && item.section === 'closing') {
        out.push(itemFor(item, gbBlocks[GB_CLOSING], GB_CLOSING));
        closingPlaced = true;
      }
    } else {
      out.push(item);
    }
    if (i === lastScope) {
      for (const added of [GB_MORAL_RIGHTS, GB_PORTFOLIO]) {
        if (gbBlocks[added] && !has(added)) out.push(itemFor(item, gbBlocks[added], added, { added: true }));
      }
    }
  });
  // Positions run 1..n across the whole contract (templates.seedContractFromVersion).
  return out.map((item, i) => ({ ...item, position: i + 1 }));
}

/**
 * A standard-contract version's items (in order, with `block_slug`) for a
 * business in `countryCode`. A US business's lose the European clauses and
 * take `usClosingBlock` (a contract_blocks row, none when an admin retired it)
 * in place of the first closing clause; a UK business's are fitted by
 * ukItemsFor; everyone else's come back unchanged.
 */
function standardItemsFor(items, countryCode, usClosingBlock, { gbBlocks = {}, customer = null } = {}) {
  if (isUnitedKingdom(countryCode)) return ukItemsFor(items, gbBlocks, customer);
  if (!isUnitedStates(countryCode)) return items;
  let placed = items.some((item) => item.kind === 'block' && isUsOnlyClause(item.block_slug));
  const out = [];
  for (const item of items) {
    if (item.kind !== 'block' || !EUROPEAN_ONLY.has(item.block_slug)) {
      out.push(item);
    } else if (usClosingBlock && !placed && item.section === 'closing') {
      out.push(itemFor(item, usClosingBlock, US_CLOSING));
      placed = true;
    }
  }
  return out;
}

/**
 * Fit a resolved template version to the business, in place: the standard
 * template's items for its legal system, and for a UK business its customer
 * (a consumer gets the cancellation notice). A template an admin built stays
 * as built. Every path that makes a contract from a version goes through
 * here, before its transaction (this reads through the global db).
 */
async function fitVersionToBusiness(version, countryCode, customer = null) {
  if (!version || !version.template_is_system) return version;
  const usClosing = await db('contract_blocks').where({ slug: US_CLOSING, is_active: true }).first();
  let gbBlocks = {};
  if (isUnitedKingdom(countryCode)) {
    const rows = await db('contract_blocks').whereIn('slug', [...GB_ONLY]).where({ is_active: true });
    gbBlocks = Object.fromEntries(rows.map((row) => [row.slug, row]));
  }
  version.items = standardItemsFor(version.items, countryCode, usClosing, { gbBlocks, customer });
  return version;
}

module.exports = {
  isUsOnlyClause, isRegionalOnlyClause, appliesTo, fitsCustomer, systemBlocksFor, standardItemsFor, fitVersionToBusiness,
};
