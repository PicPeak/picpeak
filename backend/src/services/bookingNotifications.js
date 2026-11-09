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
  const estimate = new Intl.NumberFormat(locale, { style: 'currency', currency: request.currency || 'CHF' })
    .format(Number(request.estimate_minor || 0) / 100);
  return {
    profile,
    language,
    vars: {
      client_name: request.name,
      client_email: request.email,
      business_name: (profile && (profile.company_name || profile.business_name)) || '',
      service_name: request.service_name,
      booking_date: await formatDate(day(start), language),
      booking_time: time(start),
      hold_until: `${await formatDate(day(hold), language)} ${time(hold)}`,
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
  const { profile, language, vars } = await context(request);
  const base = ((await getFrontendBaseUrl()) || '').replace(/\/+$/, '');
  if (mailClient) await queue('booking_request_received', request.email, { ...vars, __language: language });
  if (profile && profile.email) {
    await queue('booking_request_admin', profile.email, {
      ...vars,
      admin_link: `${base}/admin/clients/bookings?request=${request.id}`,
      __language: (profile && profile.default_locale) || language,
    });
  }
  await logActivity('booking_request_received', {
    requestId: request.id, reference: request.reference, service: request.service_name,
  }).catch(() => {});
}

/** The admin declined: tell the client the time is free again. */
async function notifyDeclined(request) {
  const { language, vars } = await context(request);
  const deposit = new Intl.NumberFormat(language === 'de' ? 'de-CH' : 'en-GB', { style: 'currency', currency: request.currency || 'CHF' })
    .format(Number(request.deposit_minor || 0) / 100);
  await queue('booking_request_declined', request.email, {
    ...vars,
    decline_reason: request.decline_reason || '',
    // Part 3: what happened to a deposit the client paid.
    deposit_refunded: request.deposit_status === 'refunded' ? deposit : '',
    deposit_refund_pending: request.deposit_status === 'refund_failed' || request.deposit_status === 'review' ? deposit : '',
    __language: language,
  });
}

module.exports = { notifyReceived, notifyDeclined };
