'use strict';

/**
 * Mails for client booking requests (#2440): the client's confirmation with
 * the estimate and the hold, the business notice, and the decline. Dates
 * and times print in the business timezone; template variables are escaped
 * by the email processor (client-typed names land in HTML bodies).
 */

const { logActivity } = require('../database/db');
const logger = require('../utils/logger');
const { getFrontendBaseUrl } = require('../utils/frontendUrl');
const { formatDate } = require('../utils/dateFormatter');
const { issuerIntlLocale } = require('../utils/issuerIntlLocale');
const { _internal: tz } = require('../utils/businessHours');
const emailProcessor = require('./emailProcessor');
const businessProfileService = require('./businessProfileService');

async function context(request) {
  const { profile } = await businessProfileService.getProfile();
  const { timezone } = await require('./bookingService').workingHours();
  const language = request.language || (profile && profile.default_locale) || 'en';
  const parts = (instant) => tz.getZonedParts(new Date(instant), timezone);
  const day = (p) => `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  const time = (p) => `${String(p.hh).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
  const start = parts(request.starts_at);
  const hold = parts(request.hold_expires_at);
  const locale = issuerIntlLocale(profile && profile.country_code) || (language === 'de' ? 'de-CH' : 'en-GB');
  // The admin notice reuses these vars; its dates go in the admin's language.
  const dates = async (lang) => ({
    booking_date: await formatDate(day(start), lang),
    hold_until: `${await formatDate(day(hold), lang)} ${time(hold)}`,
  });
  const estimate = new Intl.NumberFormat(locale, { style: 'currency', currency: request.currency || 'CHF' })
    .format(Number(request.estimate_minor || 0) / 100);
  return {
    profile,
    language,
    dates,
    vars: {
      client_name: request.name,
      client_email: request.email,
      business_name: (profile && (profile.company_name || profile.business_name)) || '',
      service_name: request.service_name,
      ...await dates(language),
      booking_time: time(start),
      estimate,
      reference: request.reference,
    },
  };
}

async function queue(type, recipient, data) {
  if (!recipient) return 'skipped';
  try {
    await emailProcessor.queueEmail(null, recipient, type, data);
    return 'queued';
  } catch (err) {
    logger.warn('Could not queue a booking mail', { type, error: err.message });
    return 'failed';
  }
}

/** A new request: confirm to the client, tell the business. */
async function notifyReceived(request, { mailClient = true } = {}) {
  const { profile, language, dates, vars } = await context(request);
  const base = ((await getFrontendBaseUrl()) || '').replace(/\/+$/, '');
  if (mailClient) await queue('booking_request_received', request.email, { ...vars, __language: language });
  if (profile && profile.email) {
    const adminLanguage = (profile && profile.default_locale) || language;
    await queue('booking_request_admin', profile.email, {
      ...vars,
      ...(adminLanguage !== language ? await dates(adminLanguage) : {}),
      admin_link: `${base}/admin/clients/bookings?request=${request.id}`,
      __language: adminLanguage,
    });
  }
  await logActivity('booking_request_received', {
    requestId: request.id, reference: request.reference, service: request.service_name,
  }).catch(() => {});
}

// Why a late deposit payment was refunded, in the client's language.
const LATE_PAYMENT_REASONS = {
  taken: {
    en: 'Your payment arrived after the reservation had run out, and the time has been booked since.',
    de: 'Ihre Zahlung ist nach Ablauf der Reservierung eingegangen, und der Termin ist inzwischen vergeben.',
  },
  begun: {
    en: 'Your payment arrived after the reservation had run out, and the time has already begun.',
    de: 'Ihre Zahlung ist nach Ablauf der Reservierung eingegangen, und der Termin hat bereits begonnen.',
  },
};

/**
 * The admin declined, or a late payment was refunded (`lateReason`: taken
 * or begun): tell the client.
 */
async function notifyDeclined(request, { lateReason = null } = {}) {
  // An erased client has no address left to write to.
  if (request.email === require('./bookingService').ERASED_EMAIL) return;
  const { language, vars } = await context(request);
  // What actually came in: a payment of another amount is refunded in full.
  // Amounts are hundredths in every currency, as everywhere in the app.
  const deposit = new Intl.NumberFormat(language === 'de' ? 'de-CH' : 'en-GB', { style: 'currency', currency: request.currency || 'CHF' })
    .format(Number(request.deposit_received_minor ?? request.deposit_minor ?? 0) / 100);
  const late = LATE_PAYMENT_REASONS[lateReason];
  await queue('booking_request_declined', request.email, {
    ...vars,
    decline_reason: late ? (late[language] || late.en) : (request.decline_reason || ''),
    // Part 3: what happened to a deposit the client paid.
    deposit_refunded: request.deposit_status === 'refunded' ? deposit : '',
    deposit_refund_pending: request.deposit_status === 'refund_failed' || request.deposit_status === 'review' ? deposit : '',
    __language: language,
  });
}

module.exports = { notifyReceived, notifyDeclined };
