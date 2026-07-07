/**
 * businessProfileService — single source of truth for the issuer block
 * printed at the top of every quote/invoice PDF.
 *
 * Two tables back this:
 *   - business_profile        singleton row (id=1) seeded by migration 102
 *   - business_bank_accounts  1:N from business_profile
 *
 * Bank accounts are partitioned by currency: at most one default per
 * currency. The Quote/Invoice editors auto-pick the matching default when
 * the user changes the doc currency. The defaulting rule is enforced at
 * the service layer (inside a transaction) — the DB doesn't have a
 * partial unique index so we can't rely on it cross-dialect.
 */

const { db, withRetry } = require('../database/db');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');
const { formatBoolean } = require('../utils/dbCompat');
const { normaliseSchedule } = require('../utils/businessHours');

const ALLOWED_PROFILE_FIELDS = [
  'company_name',
  'address_line1',
  'address_line2',
  'postal_code',
  'city',
  'state',
  'country_code',
  // Free-text country name (migration 107). Overrides the lookup
  // when set; falls back to COUNTRY_NAMES[locale][country_code] in
  // the PDF renderer when blank.
  'country_name',
  'phone',
  'mobile',
  'email',
  'website',
  'vat_id',
  // Steuernummer (migration 139). DE/AT §14 UStG accepts either
  // USt-IdNr. (vat_id) or local tax number (tax_id) on invoices; many
  // Kleinunternehmer only have the latter.
  'tax_id',
  'vat_label',
  'vat_rate_default',
  // Install-wide fallback hourly rate (migration 113), minor units.
  // Last link in the hour-entry rate chain after the per-entry
  // override and the per-customer default.
  'default_hourly_rate_minor',
  'default_currency',
  'default_locale',
  'default_qr_format',
  'footer_line',
  'logo_path',
  // Bundled-fonts dropdown (migration 121). Stores the on-disk
  // directory name under backend/assets/fonts/ (e.g. "Inter",
  // "Playfair-Display"). pdfService loads <family>/400.ttf as body
  // and <family>/700.ttf as bold at render time.
  //
  // Note: the legacy `pdf_font_ttf_path` column (migration 103) is
  // intentionally NOT in this whitelist anymore — the UI for setting
  // it was retired in favour of the dropdown. Existing values keep
  // working at render time (pdfService still reads the column with
  // priority), but new writes go exclusively through pdf_font_family.
  'pdf_font_family',
  // PDF letterhead visibility toggles (migration 106). Defaults true
  // to keep existing PDFs visually identical after the migration runs.
  'pdf_show_logo',
  'pdf_show_company_name',
  // PDF layout customisation (migration 108): folding marks at the
  // page edge, logo banner height in pt, and a toggle to render the
  // company name as inline plain text rather than as a bold title.
  'pdf_folding_marks',
  'pdf_logo_height',
  'pdf_company_name_inline',
  // Quote payment-block toggles (migration 110). Invoices always
  // show the full payment block; these only affect quote PDFs.
  'pdf_quote_show_net_days',
  'pdf_quote_show_skonto',
  // IANA timezone string for the admin calendar (migration 137). Used
  // by the calendar UI to render timed blocks in the operator's
  // working tz. Admin-only; never exposed via publicSettings.
  'timezone',
  // Per-ISO-weekday opening hours (migration 114). JSON TEXT; drives the
  // scheduled-email floor and is interpreted in `timezone`.
  'business_hours',
  // Master switch for the scheduled-email business-hours floor (mig 114).
  'scheduled_email_floor_enabled',
];

const ALLOWED_BANK_FIELDS = [
  'label',
  'account_holder',
  'iban',
  'bic',
  'currency',
  'is_default',
  'display_order',
];

const VALID_QR_FORMATS = new Set(['swiss', 'epc', 'none']);

function pickFields(payload, allowed) {
  if (!payload || typeof payload !== 'object') return {};
  const out = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      out[key] = payload[key];
    }
  }
  return out;
}

function normaliseIban(iban) {
  if (!iban) return iban;
  return String(iban).replace(/\s+/g, '').toUpperCase();
}

function normaliseCurrency(currency) {
  if (!currency) return currency;
  return String(currency).trim().toUpperCase();
}

function normaliseCountryCode(cc) {
  if (!cc) return cc;
  return String(cc).trim().toUpperCase().slice(0, 2);
}

function sanitiseProfilePayload(payload) {
  const updates = pickFields(payload, ALLOWED_PROFILE_FIELDS);

  if (updates.country_code !== undefined) {
    updates.country_code = normaliseCountryCode(updates.country_code);
  }
  if (updates.default_currency !== undefined) {
    updates.default_currency = normaliseCurrency(updates.default_currency);
  }
  if (updates.default_qr_format !== undefined) {
    const v = String(updates.default_qr_format || '').trim().toLowerCase();
    updates.default_qr_format = VALID_QR_FORMATS.has(v) ? v : 'none';
  }
  // Trim free-text fields to avoid silent leading/trailing whitespace
  // when the admin pastes from a printed letterhead.
  for (const field of ['company_name', 'address_line1', 'address_line2',
    'city', 'state', 'country_name', 'phone', 'mobile', 'email', 'website',
    'vat_id', 'tax_id', 'vat_label', 'footer_line', 'logo_path']) {
    if (typeof updates[field] === 'string') {
      updates[field] = updates[field].trim();
    }
  }
  // Normalise the boolean PDF visibility toggles. Empty / undefined
  // stays untouched (so partial updates don't reset existing values).
  for (const field of [
    'pdf_show_logo', 'pdf_show_company_name', 'pdf_company_name_inline',
    'pdf_quote_show_net_days', 'pdf_quote_show_skonto',
  ]) {
    if (updates[field] !== undefined) {
      updates[field] = formatBoolean(Boolean(updates[field]));
    }
  }
  // Folding-mark enum — whitelisted set. Garbage values fall back to
  // 'none' so a typo can't shoot itself in the foot.
  if (updates.pdf_folding_marks !== undefined) {
    const v = String(updates.pdf_folding_marks || '').toLowerCase();
    updates.pdf_folding_marks = ['none', 'half', 'third', 'both'].includes(v) ? v : 'none';
  }
  // Logo height — clamp to a sensible range (24-200pt). Out-of-range
  // values get snapped instead of rejected so the form can be lax.
  if (updates.pdf_logo_height !== undefined) {
    const n = parseInt(updates.pdf_logo_height, 10);
    updates.pdf_logo_height = Number.isFinite(n)
      ? Math.max(24, Math.min(200, n))
      : 56;
  }
  // Install-wide default hourly rate (minor units). Empty / null clears
  // it back to "no global default"; otherwise coerce to a non-negative
  // integer so a stray decimal can't land sub-cent values in the column.
  if (updates.default_hourly_rate_minor !== undefined) {
    if (updates.default_hourly_rate_minor === null || updates.default_hourly_rate_minor === '') {
      updates.default_hourly_rate_minor = null;
    } else {
      const n = parseInt(updates.default_hourly_rate_minor, 10);
      updates.default_hourly_rate_minor = Number.isFinite(n) && n >= 0 ? n : null;
    }
  }

  // Per-weekday opening hours. Accept the API object (or a JSON string),
  // run it through the shared validator (drops bad blocks, sorts, fills
  // all 7 days), and persist the canonical JSON string. An explicit
  // null / '' clears the schedule back to "no hours configured".
  if (updates.business_hours !== undefined) {
    if (updates.business_hours === null || updates.business_hours === '') {
      updates.business_hours = null;
    } else {
      updates.business_hours = JSON.stringify(normaliseSchedule(updates.business_hours));
    }
  }
  if (updates.scheduled_email_floor_enabled !== undefined) {
    updates.scheduled_email_floor_enabled = formatBoolean(Boolean(updates.scheduled_email_floor_enabled));
  }

  return updates;
}

function sanitiseBankPayload(payload) {
  const updates = pickFields(payload, ALLOWED_BANK_FIELDS);

  if (updates.iban !== undefined) {
    updates.iban = normaliseIban(updates.iban);
  }
  if (updates.bic !== undefined && typeof updates.bic === 'string') {
    updates.bic = updates.bic.replace(/\s+/g, '').toUpperCase();
  }
  if (updates.currency !== undefined) {
    updates.currency = normaliseCurrency(updates.currency);
  }
  if (updates.is_default !== undefined) {
    updates.is_default = formatBoolean(Boolean(updates.is_default));
  }
  for (const field of ['label', 'account_holder']) {
    if (typeof updates[field] === 'string') {
      updates[field] = updates[field].trim();
    }
  }

  return updates;
}

/**
 * Fetch the singleton business_profile row + its bank accounts.
 * Always returns a profile object even if the row is empty — the
 * Settings UI binds straight to this shape.
 */
async function getProfile() {
  return await withRetry(async () => {
    let profile = await db('business_profile').where({ id: 1 }).first();
    if (!profile) {
      // Belt-and-braces: migration 102 seeds id=1, but if a fresh install
      // ran an earlier rollback that wiped the row, re-create it so the
      // service never throws.
      await db('business_profile').insert({ id: 1 });
      profile = await db('business_profile').where({ id: 1 }).first();
    }

    const accounts = await db('business_bank_accounts')
      .where({ business_profile_id: 1 })
      .orderBy('display_order', 'asc')
      .orderBy('id', 'asc');

    return { profile, bankAccounts: accounts };
  });
}

async function updateProfile(payload, adminId) {
  const updates = sanitiseProfilePayload(payload);
  if (Object.keys(updates).length === 0) {
    return await getProfile();
  }
  updates.updated_at = new Date();

  await withRetry(async () => {
    await db('business_profile').where({ id: 1 }).update(updates);
  });

  logger.info('Business profile updated', {
    adminId,
    fields: Object.keys(updates).filter((k) => k !== 'updated_at'),
  });

  return await getProfile();
}

/**
 * Insert a new bank account. If `is_default = true`, atomically clear
 * the default flag on every other account in the same currency.
 */
async function createBankAccount(payload, adminId) {
  const data = sanitiseBankPayload(payload);
  if (!data.iban) {
    throw new AppError('iban is required', 400);
  }
  data.business_profile_id = 1;
  data.created_at = new Date();
  data.updated_at = new Date();
  // Default off when not specified — we don't want the first account
  // accidentally becoming default just because the form omitted the field.
  if (data.is_default === undefined) data.is_default = formatBoolean(false);

  return await db.transaction(async (trx) => {
    if (data.is_default && (data.is_default === true || data.is_default === 1)) {
      await trx('business_bank_accounts')
        .where({ business_profile_id: 1, currency: data.currency })
        .update({ is_default: formatBoolean(false), updated_at: new Date() });
    }
    const inserted = await trx('business_bank_accounts').insert(data).returning('id');
    const id = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];

    logger.info('Business bank account created', {
      adminId, id, iban: data.iban?.slice(-4), currency: data.currency,
    });

    return await trx('business_bank_accounts').where({ id }).first();
  });
}

async function updateBankAccount(id, payload, adminId) {
  const data = sanitiseBankPayload(payload);
  data.updated_at = new Date();

  return await db.transaction(async (trx) => {
    const existing = await trx('business_bank_accounts').where({ id }).first();
    if (!existing) {
      throw new AppError('Bank account not found', 404);
    }
    // Honour the per-currency single-default rule.
    if (data.is_default === true || data.is_default === 1 || data.is_default === formatBoolean(true)) {
      const targetCurrency = data.currency || existing.currency;
      await trx('business_bank_accounts')
        .where({ business_profile_id: 1, currency: targetCurrency })
        .andWhereNot({ id })
        .update({ is_default: formatBoolean(false), updated_at: new Date() });
    }
    await trx('business_bank_accounts').where({ id }).update(data);

    logger.info('Business bank account updated', { adminId, id });

    return await trx('business_bank_accounts').where({ id }).first();
  });
}

async function deleteBankAccount(id, adminId) {
  return await withRetry(async () => {
    const existing = await db('business_bank_accounts').where({ id }).first();
    if (!existing) {
      throw new AppError('Bank account not found', 404);
    }
    await db('business_bank_accounts').where({ id }).del();
    logger.info('Business bank account deleted', { adminId, id });
    return { deleted: true };
  });
}

/**
 * Resolve the bank account that should print on a quote/invoice for a
 * given currency: explicit override → default for that currency →
 * default for the profile's default_currency → first by display_order.
 */
async function resolveBankAccountForCurrency(currency, overrideId = null) {
  return await withRetry(async () => {
    if (overrideId) {
      const explicit = await db('business_bank_accounts').where({ id: overrideId }).first();
      if (explicit) return explicit;
    }
    if (currency) {
      const match = await db('business_bank_accounts')
        .where({ business_profile_id: 1, currency, is_default: formatBoolean(true) })
        .first();
      if (match) return match;
    }
    const anyDefault = await db('business_bank_accounts')
      .where({ business_profile_id: 1, is_default: formatBoolean(true) })
      .first();
    if (anyDefault) return anyDefault;
    return await db('business_bank_accounts')
      .where({ business_profile_id: 1 })
      .orderBy('display_order', 'asc').orderBy('id', 'asc').first();
  });
}

module.exports = {
  getProfile,
  updateProfile,
  createBankAccount,
  updateBankAccount,
  deleteBankAccount,
  resolveBankAccountForCurrency,
};
