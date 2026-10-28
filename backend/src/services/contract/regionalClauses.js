'use strict';

/**
 * System clauses written for one legal system.
 *
 * The seeded closing provisions name Swiss or German law, and the
 * data-protection clause cites the GDPR and the Swiss FADP: none of them
 * belongs in a contract from a business in the United States, and the US
 * closing provisions belong in no one else's. The standard contract keeps the
 * European clauses — it is shared by every install and built before a
 * country is set — and a US business's new contract made from it, or from the
 * system blocks directly, swaps them for the US closing provisions. A template
 * an admin built is taken as they built it.
 */

const { isUnitedStates } = require('../../utils/postalAddress');
const content = require('./content');

const US_CLOSING = 'closing_jurisdiction_us';
const EUROPEAN_ONLY = new Set(['closing_jurisdiction_ch', 'closing_jurisdiction_de', 'dsgvo_data_protection']);

/** Is this the clause only a US business's contracts carry? */
function isUsOnlyClause(slug) {
  return slug === US_CLOSING;
}

/** The active system blocks a new contract without a template gets. */
function systemBlocksFor(blocks, countryCode) {
  return isUnitedStates(countryCode)
    ? blocks.filter((block) => !EUROPEAN_ONLY.has(block.slug))
    : blocks.filter((block) => !isUsOnlyClause(block.slug));
}

/**
 * A standard-contract version's items (in order, with `block_slug`) for a
 * business in `countryCode`. A US business's lose the European clauses and
 * take `usClosingBlock` (a contract_blocks row) in place of the first closing
 * clause; everyone else's come back unchanged.
 */
function standardItemsFor(items, countryCode, usClosingBlock) {
  if (!isUnitedStates(countryCode) || !usClosingBlock) return items;
  let placed = items.some((item) => item.kind === 'block' && isUsOnlyClause(item.block_slug));
  const out = [];
  for (const item of items) {
    if (item.kind !== 'block' || !EUROPEAN_ONLY.has(item.block_slug)) {
      out.push(item);
    } else if (!placed && item.section === 'closing') {
      out.push({
        ...item,
        block_id: usClosingBlock.id,
        block_slug: US_CLOSING,
        body_snapshot: content.serializeLocaleMap(content.blockBodies(usClosingBlock)),
        body_override: null,
      });
      placed = true;
    }
  }
  return out;
}

module.exports = { US_CLOSING, isUsOnlyClause, systemBlocksFor, standardItemsFor };
