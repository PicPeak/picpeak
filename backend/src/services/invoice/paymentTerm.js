const { getAppSetting } = require('../../utils/appSettings');
const { ensureInt } = require('../../utils/numericHelpers');
const { parseJsonObject } = require('./helpers');

/**
 * Every invoice owns its payment term. When it is created, the term it
 * shows is resolved once (its own snapshot, else the source quote's, then
 * the global Skonto defaults) and stored on `payment_term_snapshot` with
 * `frozen: true`. Rendering and the Skonto checks read that snapshot as it
 * is, so a quote resent or accepted later, or a changed default, no longer
 * changes an invoice that already exists. Migration 374 froze the invoices
 * from before.
 *
 * A snapshot without the marker (an invoice written between the migration
 * and this code, or restored from an older archive before the migration
 * re-runs) still resolves the way it always did.
 */

function isFrozenTerm(snapshot) {
  return Boolean(snapshot && typeof snapshot === 'object' && snapshot.frozen === true);
}

function positive(raw, parse) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? parse(raw) : null;
}

/** The global Skonto defaults, as the invoice renderer reads them. */
async function loadSkontoDefaults(conn) {
  return {
    skontoPercent: positive(await getAppSetting('crm_invoices_skonto_percent_default', null, conn), Number),
    skontoWithinDays: positive(await getAppSetting('crm_invoices_skonto_business_days', null, conn), (v) => parseInt(v, 10)),
  };
}

/**
 * The term an invoice shows, with every fallback applied: its own snapshot
 * when it has one, else the source quote's, the missing Skonto parts from
 * the defaults; with neither, the defaults and `netDays`.
 */
function effectiveTerm(own, quoteSnapshot, defaults, netDays) {
  const base = own || quoteSnapshot || null;
  if (!base) {
    return {
      description: null,
      net_days: netDays,
      skonto_percent: defaults.skontoPercent,
      skonto_within_days: defaults.skontoWithinDays,
      installments: null,
      frozen: true,
    };
  }
  return {
    ...base,
    description: base.description ?? null,
    net_days: base.net_days ?? null,
    skonto_percent: base.skonto_percent ?? defaults.skontoPercent,
    skonto_within_days: base.skonto_within_days ?? defaults.skontoWithinDays,
    installments: base.installments ?? null,
    frozen: true,
  };
}

/**
 * The JSON text to store as a new (or re-termed) invoice's
 * payment_term_snapshot. `snapshot` is the term picked for the invoice
 * itself (null for none), `sourceQuoteId` the quote it is made from,
 * `netDays` the net days its due date was computed with when it has no term
 * of its own (defaults to the crm_payment_default_net_days setting, then 30).
 */
async function frozenPaymentTerm(conn, { snapshot = null, sourceQuoteId = null, netDays = null } = {}) {
  const own = parseJsonObject(snapshot);
  if (isFrozenTerm(own)) return JSON.stringify(own);
  let quoteSnapshot = null;
  if (!own && sourceQuoteId) {
    // The invoice keeps the term of the quote it is made from, whoever may
    // read that quote. Only the term leaves here.
    const quote = await require('../../database/crmAccess').withTrustedCrmAccess('invoice payment term: source quote',
      () => conn('quotes').where({ id: sourceQuoteId }).first('payment_term_snapshot'));
    quoteSnapshot = parseJsonObject(quote?.payment_term_snapshot);
  }
  const fallbackNetDays = !own && !quoteSnapshot
    ? (ensureInt(netDays) || ensureInt(await getAppSetting('crm_payment_default_net_days', null, conn)) || 30)
    : null;
  return JSON.stringify(effectiveTerm(own, quoteSnapshot, await loadSkontoDefaults(conn), fallbackNetDays));
}

module.exports = { effectiveTerm, frozenPaymentTerm, isFrozenTerm, loadSkontoDefaults };
