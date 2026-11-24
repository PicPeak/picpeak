'use strict';
/**
 * Migration 374: every invoice owns its payment term.
 *
 * An invoice without a complete payment term of its own used to resolve one
 * on every render and Skonto check: the source quote's snapshot first, then
 * the global Skonto defaults. A quote resent or accepted later, or a changed
 * default, so changed the terms of invoices already issued. New invoices now
 * store the resolved term with `frozen: true` (src/services/invoice/
 * paymentTerm.js), and the readers take a frozen term as it is.
 *
 * This freezes the term every existing invoice shows today, resolved the way
 * the invoice PDF resolves it (invoice/render.js before this change):
 *   - its own snapshot when it has one, else the source quote's;
 *   - Skonto percent / days missing from it filled from
 *     crm_invoices_skonto_percent_default / crm_invoices_skonto_business_days;
 *   - with neither snapshot: no description, the default Skonto, and 30 net
 *     days for an issued invoice (what its PDF printed). A scheduled one takes
 *     crm_payment_default_net_days (then 30), the value its due date is
 *     re-anchored with when it is sent.
 * Where the old Skonto check (reminders.resolveSkontoPercentForInvoice)
 * disagreed with the PDF, the PDF's term is the one kept.
 *
 * The resolver is self-contained: it must keep resolving as the code did on
 * the day this shipped, whatever the src helpers become.
 *
 * Read in batches by id; the writes go through the accounting history
 * (actor "upgrade"), grouped by identical term. Only invoices without a
 * frozen term are touched, so a re-run changes nothing. JSON column on
 * PostgreSQL (read back parsed), text on SQLite: both are written as JSON
 * text.
 */
const BATCH = 500;
const UNISSUED = new Set(['scheduled', 'pending_delivery']);

function parseJson(value) {
  if (typeof value !== 'string') return value || null;
  try { return JSON.parse(value); } catch { return null; }
}

function isFrozen(snapshot) {
  return Boolean(snapshot && typeof snapshot === 'object' && snapshot.frozen === true);
}

function toInt(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
}

function positive(raw, parse) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? parse(raw) : null;
}

async function setting(knex, key) {
  const row = await knex('app_settings').where({ setting_key: key }).first('setting_value');
  if (!row || row.setting_value == null) return null;
  try { return JSON.parse(row.setting_value); } catch { return row.setting_value; }
}

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

async function freezeInvoicePaymentTerms(knex, { actor = 'upgrade' } = {}) {
  if (!(await knex.schema.hasTable('invoices'))) return 0;
  if (!(await knex.schema.hasColumn('invoices', 'payment_term_snapshot'))) return 0;
  const hasQuoteTerms = await knex.schema.hasTable('quotes')
    && await knex.schema.hasColumn('quotes', 'payment_term_snapshot');
  const hasSourceQuote = await knex.schema.hasColumn('invoices', 'source_quote_id');
  const hasHistory = await knex.schema.hasTable('accounting_change_history');
  const hasSettings = await knex.schema.hasTable('app_settings');

  const read = (key) => (hasSettings ? setting(knex, key) : null);
  const defaults = {
    skontoPercent: positive(await read('crm_invoices_skonto_percent_default'), Number),
    skontoWithinDays: positive(await read('crm_invoices_skonto_business_days'), (v) => parseInt(v, 10)),
  };
  const unissuedNetDays = toInt(await read('crm_payment_default_net_days')) || 30;

  const columns = ['id', 'status', 'payment_term_snapshot'];
  if (hasSourceQuote) columns.push('source_quote_id');

  let frozen = 0;
  let lastId = 0;
  for (;;) {
    const rows = await knex('invoices').where('id', '>', lastId).orderBy('id').limit(BATCH).select(columns);
    if (rows.length === 0) break;
    lastId = rows[rows.length - 1].id;

    const pending = rows
      .map((row) => ({ row, own: parseJson(row.payment_term_snapshot) }))
      .filter(({ own }) => !isFrozen(own));
    if (pending.length === 0) continue;

    const quoteIds = [...new Set(pending
      .filter(({ row, own }) => !own && row.source_quote_id)
      .map(({ row }) => row.source_quote_id))];
    const quoteTerms = new Map();
    if (hasQuoteTerms && quoteIds.length > 0) {
      const quotes = await knex('quotes').whereIn('id', quoteIds).select('id', 'payment_term_snapshot');
      for (const quote of quotes) quoteTerms.set(Number(quote.id), parseJson(quote.payment_term_snapshot));
    }

    // Invoices with the same term are written together.
    const byTerm = new Map();
    for (const { row, own } of pending) {
      const quoteTerm = own || !row.source_quote_id ? null : quoteTerms.get(Number(row.source_quote_id)) || null;
      const netDays = UNISSUED.has(row.status) ? unissuedNetDays : 30;
      const term = JSON.stringify(effectiveTerm(own, quoteTerm, defaults, netDays));
      if (!byTerm.has(term)) byTerm.set(term, []);
      byTerm.get(term).push(row.id);
    }
    for (const [term, ids] of byTerm) {
      if (hasHistory) {
        // Required here, as utils/invoiceSendAt does: the migration test runs
        // without the app's database.
        const { auditedUpdate } = require('../../src/services/accountingHistory');
        await auditedUpdate(knex, 'invoices', (q) => q.whereIn('id', ids),
          { payment_term_snapshot: term }, { actor, source: 'invoice.paymentTerm.freeze' });
      } else {
        await knex('invoices').whereIn('id', ids).update({ payment_term_snapshot: term });
      }
      frozen += ids.length;
    }
  }
  return frozen;
}

exports.up = async function up(knex) {
  await require('../../src/database/crmAccess').withTrustedCrmAccess('migration 374: freeze invoice payment terms',
    () => freezeInvoicePaymentTerms(knex));
};

// Irreversible by design: which invoices had no term of their own, or only
// part of one, is not kept. The frozen terms are the ones each invoice showed,
// and the code before this migration reads them as the invoice's own term
// (it ignores the marker), so leaving them in place is the safe way back.
exports.down = async function down() {};

exports.freezeInvoicePaymentTerms = freezeInvoicePaymentTerms;
