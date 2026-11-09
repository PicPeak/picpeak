'use strict';

/**
 * Booking deposits and gallery unlock on payment (#2440, part 3).
 *
 * Deposit: a bookable service can ask for a deposit (percent of the estimate
 * or a fixed amount). The request then waits in `awaiting_payment` while the
 * client pays by card in Stripe Checkout (the Stripe account set up for photo
 * sales); the slot is held only for the checkout. Paid, the request becomes
 * an ordinary pending request with the full hold, and the mails go out. An
 * expired checkout frees the slot. Declining a paid request refunds it.
 * The deposit is no invoice: once the deal's invoice exists, the admin books
 * the deposit on it as a payment (method "stripe", the payment id as the
 * reference), so the books and the VAT stay with the invoice.
 *
 * Gallery unlock: a gallery made from the booking's quote is locked with the
 * service's setting. `full_payment` keeps it closed to clients until every
 * invoice of the deal is paid; `deposit` and `off` set no lock (the deposit
 * was paid before the request counted). Admins always see it, and can open
 * it by hand. The check runs when an invoice is paid and again whenever a
 * client opens the locked gallery, so a missed hook cannot keep it shut.
 */

const crypto = require('crypto');
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');
const { toTimestamp } = require('../utils/dateNormalize');
const { withTrustedCrmAccess } = require('../database/crmAccess');

const { hasColumnCached } = require('../utils/schemaCache');
const { isFeatureEnabled } = require('../middleware/requireFeatureFlag');

const DEPOSIT_TYPES = ['none', 'percent', 'fixed'];
const LATE_PAYMENT_REASON = 'Your payment arrived after the reservation had run out, and the time has been booked since.';
const GALLERY_UNLOCK = ['full_payment', 'deposit', 'off'];
// Stripe's shortest Checkout lifetime; the hold covers it with a margin.
const CHECKOUT_MINUTES = 30;
const CHECKOUT_HOLD_MINUTES = 35;

const ts = (v) => new Date(v instanceof Date ? v.getTime() : toTimestamp(v)).toISOString();
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/** Deposit in minor units for a service and an estimate; 0 = none. */
function depositFor(preset, estimateMinor) {
  const type = DEPOSIT_TYPES.includes(preset.booking_deposit_type) ? preset.booking_deposit_type : 'none';
  const total = Math.max(0, Number(estimateMinor) || 0);
  if (type === 'percent') {
    const pct = Math.min(100, Math.max(0, Number(preset.booking_deposit_percent) || 0));
    return Math.round(total * pct / 100);
  }
  if (type === 'fixed') return Math.min(total, Math.max(0, Math.round(Number(preset.booking_deposit_minor) || 0)));
  return 0;
}

/** Stripe is set up (keys + webhook) and switched on for checkouts. */
async function stripeReady() {
  try {
    const { configuration } = require('../modules/photoSales/providers');
    return (await configuration()).available.includes('stripe');
  } catch (err) {
    logger.warn('Could not read the payment configuration', { error: err.message });
    return false;
  }
}

function newStatusToken() {
  return crypto.randomBytes(24).toString('hex');
}

// ---------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------

/**
 * Open the Stripe Checkout for a request's deposit. Called right after the
 * request row is written (status awaiting_payment). On failure the request
 * is expired so its slot is free again, and the error goes to the client.
 */
async function startCheckout(request, statusToken) {
  const { stripeClient } = require('../modules/photoSales/stripeClient');
  const { getFrontendBaseUrl } = require('../utils/frontendUrl');
  const base = ((await getFrontendBaseUrl()) || '').replace(/\/+$/, '');
  const statusUrl = `${base}/book/status/${statusToken}`;
  try {
    const client = await stripeClient();
    // picpeak_origin as photo sales stamps it: installs sharing one Stripe
    // account can tell their sessions apart (reconcileWebhook checks it).
    const metadata = { picpeak_booking_ref: request.reference, picpeak_origin: base };
    const session = await client.checkout.sessions.create({
      mode: 'payment',
      // Card only: a delayed method could settle after the hold ran out.
      payment_method_types: ['card'],
      customer_email: request.email,
      client_reference_id: request.reference,
      metadata,
      payment_intent_data: { metadata, description: `Deposit ${request.reference}` },
      line_items: [{
        quantity: 1,
        price_data: {
          currency: String(request.currency || 'CHF').toLowerCase(),
          unit_amount: Number(request.deposit_minor),
          product_data: { name: `Deposit: ${request.service_name}` },
        },
      }],
      expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_MINUTES * 60 + 30,
      success_url: `${statusUrl}?paid=1`,
      cancel_url: `${statusUrl}?cancelled=1`,
    }, { idempotencyKey: `picpeak-booking-deposit:${request.reference}` });
    await db('booking_requests').where({ id: request.id })
      .update({ checkout_session_id: session.id, deposit_status: 'open', updated_at: ts(new Date()) });
    return session.url;
  } catch (err) {
    await db('booking_requests').where({ id: request.id })
      .update({ status: 'expired', deposit_status: 'expired', updated_at: ts(new Date()) });
    logger.error('Could not open the deposit checkout', { requestId: request.id, type: err.type || err.name });
    throw new AppError('The payment page could not be opened. Please try again later.', 502, 'BOOKING_CHECKOUT_FAILED');
  }
}

const intentOf = (session) => (typeof session.payment_intent === 'string'
  ? session.payment_intent : session.payment_intent?.id || null);

async function notifyPaid(requestId, opts = {}) {
  const fresh = await db('booking_requests').where({ id: requestId }).first();
  await require('./bookingNotifications').notifyReceived(fresh, opts).catch((err) => {
    logger.warn('Could not queue the booking request mails', { requestId, error: err.message });
  });
}

/**
 * Apply an authoritative Checkout Session to its request. Idempotent: every
 * write is conditional on the state it moves from.
 *   paid, right amount     awaiting_payment → pending (full hold), mails
 *   paid after the hold    expired → pending again when the slot is still
 *                          free, else refunded (the client is not charged
 *                          for a time they no longer hold)
 *   paid, other amount     → pending with deposit_status `review`: held until
 *                          the admin decides, who is told and checks Stripe
 *   expired                awaiting_payment → expired, slot free
 */
async function reconcileSession(request, session) {
  const paid = session.payment_status === 'paid' && session.status === 'complete';
  const amountOk = Number(session.amount_total) === Number(request.deposit_minor)
    && String(session.currency || '').toUpperCase() === String(request.currency || '').toUpperCase();
  const now = new Date();
  if (paid && amountOk) {
    const settings = await require('./bookingService').getSettings();
    // Conditional on the deposit not being settled yet: a replay or the
    // status page cannot overwrite a refund or a review.
    const paidFields = {
      deposit_status: 'paid',
      deposit_paid_at: ts(now),
      payment_intent_id: intentOf(session),
      hold_expires_at: ts(now.getTime() + settings.hold_hours * 3600000),
      updated_at: ts(now),
    };
    const updated = await db('booking_requests').where({ id: request.id, status: 'awaiting_payment' })
      .whereIn('deposit_status', ['open', 'expired'])
      .update({ status: 'pending', ...paidFields });
    if (updated) {
      await notifyPaid(request.id);
      return 'paid';
    }
    // The hold ran out before the payment arrived (a late webhook). The
    // check and the write share the lock new requests take, so a request
    // made meanwhile and this restore cannot both win the slot.
    const booking = require('./bookingService');
    await hasColumnCached('booking_requests', 'deposit_status'); // warm before the transaction
    const outcome = await booking.withRequestLock(async (trx) => {
      const late = await trx('booking_requests').where({ id: request.id, status: 'expired' })
        .whereIn('deposit_status', ['open', 'expired']).first();
      if (!late) return 'none';
      if (!(await booking.slotTaken(late, trx))) {
        await trx('booking_requests').where({ id: late.id, status: 'expired' })
          .whereIn('deposit_status', ['open', 'expired'])
          .update({ status: 'pending', ...paidFields });
        return 'restored';
      }
      await trx('booking_requests').where({ id: late.id, status: 'expired' })
        .whereIn('deposit_status', ['open', 'expired'])
        .update({ ...paidFields, hold_expires_at: late.hold_expires_at });
      return 'taken';
    });
    if (outcome === 'restored') {
      await notifyPaid(request.id);
      return 'paid';
    }
    if (outcome === 'taken') {
      // The time went to someone else: refund, and tell the client why.
      const row = await db('booking_requests').where({ id: request.id }).first();
      await refundDeposit(row);
      await require('./bookingNotifications').notifyDeclined(
        { ...(await db('booking_requests').where({ id: request.id }).first()), decline_reason: LATE_PAYMENT_REASON },
      ).catch((err) => logger.warn('Could not queue the late-payment refund mail', { requestId: request.id, error: err.message }));
      return 'refunded';
    }
    return 'paid';
  }
  if (paid && !amountOk) {
    // Never treat a different amount as the deposit.
    logger.error('Deposit checkout paid with an unexpected amount', { requestId: request.id });
    // Waiting for the checkout: held for review until the admin decides.
    // Already expired: marked for review, but not put back on the calendar.
    const held = await db('booking_requests').where({ id: request.id, status: 'awaiting_payment' })
      .whereIn('deposit_status', ['open', 'expired'])
      .update({ status: 'pending', deposit_status: 'review', payment_intent_id: intentOf(session), updated_at: ts(now) });
    const marked = held ? 0 : await db('booking_requests').where({ id: request.id, status: 'expired' })
      .whereIn('deposit_status', ['open', 'expired'])
      .update({ deposit_status: 'review', payment_intent_id: intentOf(session), updated_at: ts(now) });
    if (held || marked) await notifyPaid(request.id, { mailClient: Boolean(held) });
    return 'mismatch';
  }
  if (session.status === 'expired') {
    await db('booking_requests').where({ id: request.id, status: 'awaiting_payment' })
      .update({ status: 'expired', deposit_status: 'expired', updated_at: ts(now) });
    return 'expired';
  }
  return 'open';
}


/**
 * Stripe webhook entry: returns true when the event belonged to a booking
 * deposit (handled here), false to let photo sales take it.
 */
/**
 * Refund and dispute events for a deposit: a refund that fails later, or a
 * chargeback, shows on the request instead of being dropped.
 */
async function reconcilePaymentEvent(event) {
  const object = event.data?.object || {};
  const intent = typeof object.payment_intent === 'string' ? object.payment_intent : object.payment_intent?.id;
  if (!intent) return false;
  const request = await db('booking_requests').where({ payment_intent_id: intent }).first();
  if (!request) return false;
  const failedRefund = (event.type === 'refund.failed' || event.type === 'refund.updated') && object.status === 'failed';
  if (failedRefund) {
    await db('booking_requests').where({ id: request.id }).update({ deposit_status: 'refund_failed', updated_at: ts(new Date()) });
    logger.error('A booking deposit refund failed at Stripe', { requestId: request.id });
  } else if (event.type.startsWith('charge.dispute.')) {
    await db('booking_requests').where({ id: request.id }).update({ deposit_status: 'disputed', updated_at: ts(new Date()) });
    logger.error('A booking deposit is disputed', { requestId: request.id });
  }
  return true;
}

async function reconcileWebhook(event, client) {
  if (event.type.startsWith('refund.') || event.type.startsWith('charge.dispute.')) {
    return reconcilePaymentEvent(event);
  }
  if (!event.type.startsWith('checkout.session.')) return false;
  const object = event.data?.object || {};
  const reference = object.metadata?.picpeak_booking_ref;
  if (!reference) return false;
  const { getFrontendBaseUrl } = require('../utils/frontendUrl');
  const origin = object.metadata?.picpeak_origin;
  const base = ((await getFrontendBaseUrl()) || '').replace(/\/+$/, '');
  if (origin && origin !== base) return true; // another install's session
  let request = await db('booking_requests').where({ reference }).first();
  if (request && !request.checkout_session_id) {
    // The session was made but storing its id failed: adopt it.
    await db('booking_requests').where({ id: request.id }).whereNull('checkout_session_id')
      .whereIn('deposit_status', ['open', 'expired'])
      .update({ checkout_session_id: object.id, updated_at: ts(new Date()) });
    request = await db('booking_requests').where({ id: request.id }).first();
  }
  if (!request || request.checkout_session_id !== object.id) {
    // Another install sharing the Stripe account, or a superseded session.
    logger.warn('Deposit checkout for an unknown booking request', { type: event.type });
    return true;
  }
  const session = await client.checkout.sessions.retrieve(object.id);
  await reconcileSession(request, session);
  return true;
}

/**
 * The client came back from Checkout before the webhook: look the session up
 * once so the status page can say "paid" without waiting.
 */
async function refreshFromStripe(request) {
  if (request.status !== 'awaiting_payment' || !request.checkout_session_id) return request;
  try {
    const { stripeClient } = require('../modules/photoSales/stripeClient');
    const client = await stripeClient();
    const session = await client.checkout.sessions.retrieve(request.checkout_session_id);
    await reconcileSession(request, session);
  } catch (err) {
    logger.warn('Could not refresh a deposit checkout', { requestId: request.id, type: err.type || err.name });
  }
  return db('booking_requests').where({ id: request.id }).first();
}

/**
 * The client cancelled the checkout: close it at Stripe and free the slot at
 * once, so "book again" finds it. A session that was paid meanwhile is
 * reconciled as paid instead.
 */
async function cancelCheckout(request) {
  if (request.status !== 'awaiting_payment' || !request.checkout_session_id) return request;
  try {
    const { stripeClient } = require('../modules/photoSales/stripeClient');
    const client = await stripeClient();
    try {
      await client.checkout.sessions.expire(request.checkout_session_id);
    } catch {
      // Already complete or expired: the retrieve below tells which.
    }
    await reconcileSession(request, await client.checkout.sessions.retrieve(request.checkout_session_id));
  } catch (err) {
    logger.warn('Could not close a cancelled deposit checkout', { requestId: request.id, type: err.type || err.name });
  }
  return db('booking_requests').where({ id: request.id }).first();
}

/** Refund a paid deposit (the admin declined the request). */
async function refundDeposit(request) {
  if (request.deposit_status !== 'paid' || !request.payment_intent_id) return request.deposit_status;
  try {
    const { stripeClient } = require('../modules/photoSales/stripeClient');
    const client = await stripeClient();
    await client.refunds.create({ payment_intent: request.payment_intent_id },
      { idempotencyKey: `picpeak-booking-refund:${request.reference}` });
    await db('booking_requests').where({ id: request.id }).update({ deposit_status: 'refunded', updated_at: ts(new Date()) });
    return 'refunded';
  } catch (err) {
    // Stays visible on the request: the admin refunds in Stripe by hand.
    await db('booking_requests').where({ id: request.id }).update({ deposit_status: 'refund_failed', updated_at: ts(new Date()) });
    logger.error('Could not refund a booking deposit', { requestId: request.id, type: err.type || err.name });
    return 'refund_failed';
  }
}

/** The calendar day of an instant in the business timezone (VAT periods follow it). */
async function businessDay(instant) {
  const { timezone } = await require('./bookingService').workingHours();
  const { _internal: tz } = require('../utils/businessHours');
  const p = tz.getZonedParts(new Date(ts(instant)), timezone);
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/**
 * Book a paid deposit as a payment on an invoice of the request's deal.
 * Once per request.
 */
async function applyDepositToInvoice(requestId, invoiceId, adminId) {
  const request = await db('booking_requests').where({ id: requestId }).first();
  if (!request) throw new AppError('Booking request not found', 404);
  if (request.deposit_status !== 'paid') throw new AppError('This request has no paid deposit', 409, 'BOOKING_NO_DEPOSIT');
  if (request.deposit_invoice_id) throw new AppError('The deposit is already booked on an invoice', 409, 'BOOKING_DEPOSIT_APPLIED');
  // Read in the admin's own CRM scope (the route's context): an invoice the
  // admin may not see is not one they can book a payment on.
  const quote = request.quote_id ? await db('quotes').where({ id: request.quote_id }).first('deal_uuid') : null;
  const invoice = quote && quote.deal_uuid
    ? await db('invoices').where({ id: invoiceId, deal_uuid: quote.deal_uuid })
      .first('id', 'currency', 'status', 'kind', 'cancels_invoice_id', 'total_amount_minor', 'paid_amount_minor')
    : null;
  if (!invoice) throw new AppError('Pick an invoice from this booking\'s quote', 400, 'BOOKING_INVOICE_MISMATCH');
  // Only an issued, open invoice takes the deposit: not a Storno, not a
  // cancelled or paid one, not one that has not gone out yet.
  if (invoice.kind === 'storno' || invoice.cancels_invoice_id || ['cancelled', 'paid', 'scheduled', 'pending_delivery', 'draft'].includes(invoice.status)) {
    throw new AppError('Book the deposit on an issued invoice that is still open', 409, 'BOOKING_INVOICE_NOT_OPEN');
  }
  const openMinor = Number(invoice.total_amount_minor) - Number(invoice.paid_amount_minor || 0);
  if (openMinor <= 0) throw new AppError('This invoice is already paid', 409, 'BOOKING_INVOICE_NOT_OPEN');
  // Capped at what is still open: no overpayment. The rest stays on the
  // request for the next invoice.
  const amountMinor = Math.min(Number(request.deposit_minor), openMinor);
  if (String(invoice.currency || '').toUpperCase() !== String(request.currency || '').toUpperCase()) {
    throw new AppError('The invoice is in another currency', 400, 'BOOKING_INVOICE_MISMATCH');
  }
  const claimed = await db('booking_requests').where({ id: requestId }).whereNull('deposit_invoice_id')
    .update({ deposit_invoice_id: invoice.id, updated_at: ts(new Date()) });
  if (!claimed) throw new AppError('The deposit is already booked on an invoice', 409, 'BOOKING_DEPOSIT_APPLIED');
  try {
    await require('./invoice/payments').markPaid(invoice.id, {
      amountMinor,
      paidAt: await businessDay(request.deposit_paid_at),
      paymentMethod: 'stripe',
      reference: request.payment_intent_id,
      notes: `Booking deposit ${request.reference}`,
    }, adminId);
  } catch (err) {
    await db('booking_requests').where({ id: requestId }).update({ deposit_invoice_id: null, updated_at: ts(new Date()) });
    throw err;
  }
  return db('booking_requests').where({ id: requestId }).first();
}

// ---------------------------------------------------------------------
// Gallery lock
// ---------------------------------------------------------------------

/**
 * Inside the quote → gallery conversion: lock the new gallery when the quote
 * came from a booking request whose service unlocks on full payment.
 */
async function applyGalleryLock(trx, quoteId, eventId) {
  // Through the deal, not the quote id: a reissued quote is a new quote in
  // the same deal, and its gallery must lock like the original's.
  const quote = await trx('quotes').where({ id: quoteId }).first('deal_uuid');
  const quoteIds = quote && quote.deal_uuid
    ? await trx('quotes').where({ deal_uuid: quote.deal_uuid }).pluck('id')
    : [quoteId];
  const request = await trx('booking_requests').whereIn('quote_id', quoteIds)
    .orderBy('id', 'desc').first('id', 'gallery_unlock', 'deposit_status');
  if (!request) return false;
  const mode = request.gallery_unlock || 'full_payment';
  // "Once the deposit is paid" with no paid deposit (Stripe was off, or the
  // service took none) falls back to full payment rather than opening.
  const locks = mode === 'full_payment' || (mode === 'deposit' && request.deposit_status !== 'paid');
  if (!locks) return false;
  await trx('events').where({ id: eventId })
    .update({ payment_lock: 'full_payment', payment_lock_request_id: request.id, payment_unlocked_at: null });
  return true;
}

/** Invoices that count for a deal: no Storno, no cancelled or replaced invoice. */
function countingInvoices(rows) {
  return rows.filter((inv) => inv.status !== 'cancelled'
    && inv.kind !== 'storno'
    && !inv.cancels_invoice_id
    && Number(inv.total_amount_minor) >= 0);
}

const isPaid = (inv) => inv.status === 'paid' || Number(inv.paid_amount_minor) >= Number(inv.total_amount_minor);

/**
 * Is the deal behind a locked gallery fully paid? Every invoice of the deal
 * that bills something is paid, AND together they bill at least the quote
 * the deal was agreed on (its newest accepted or converted version), so a
 * paid first instalment does not open the gallery while the rest is not
 * invoiced yet.
 */
async function dealFullyPaid(requestId) {
  return withTrustedCrmAccess('booking gallery unlock: deal invoices', async () => {
    const request = await db('booking_requests').where({ id: requestId }).first('quote_id');
    const quote = request && request.quote_id ? await db('quotes').where({ id: request.quote_id }).first('deal_uuid') : null;
    if (!quote || !quote.deal_uuid) return false;
    // Every quote the client agreed to in this deal (a reissued one is
    // declined, so only its replacement counts; an add-on quote adds), in
    // the invoices' currency.
    const rows = await db('invoices').where({ deal_uuid: quote.deal_uuid })
      .select('id', 'status', 'kind', 'cancels_invoice_id', 'currency', 'total_amount_minor', 'paid_amount_minor');
    const invoices = countingInvoices(rows).filter((inv) => Number(inv.total_amount_minor) > 0);
    if (!invoices.length) return false;
    const currency = invoices[0].currency;
    const agreedRows = await db('quotes').where({ deal_uuid: quote.deal_uuid, currency })
      .whereIn('status', ['accepted', 'converted']).select('total_amount_minor');
    const agreed = agreedRows.reduce((sum, q) => sum + Number(q.total_amount_minor || 0), 0);
    const billed = invoices.filter((inv) => inv.currency === currency)
      .reduce((sum, inv) => sum + Number(inv.total_amount_minor), 0);
    return invoices.every(isPaid) && billed >= agreed;
  });
}

/**
 * Re-check a locked gallery and open it when its deal is paid.
 * @returns {Promise<boolean>} true while it stays locked
 */
async function refreshGalleryLock(event) {
  if (!event || !event.payment_lock || event.payment_unlocked_at) return false;
  // With client booking switched off nobody can open it by hand (the
  // Bookings page is gone), so the lock does not apply.
  if (!(await isFeatureEnabled('calendarBooking'))) return false;
  if (!event.payment_lock_request_id || !(await dealFullyPaid(event.payment_lock_request_id))) return true;
  await db('events').where({ id: event.id }).whereNull('payment_unlocked_at')
    .update({ payment_unlocked_at: ts(new Date()) });
  logger.info('Gallery unlocked after full payment', { eventId: event.id });
  return false;
}

/** An invoice was paid: open the galleries of its deal that wait for it. */
async function onInvoicePaid(invoiceId) {
  const events = await withTrustedCrmAccess('booking gallery unlock: paid invoice', async () => {
    const invoice = await db('invoices').where({ id: invoiceId }).first('deal_uuid');
    if (!invoice || !invoice.deal_uuid) return [];
    const quoteIds = await db('quotes').where({ deal_uuid: invoice.deal_uuid }).pluck('id');
    if (!quoteIds.length) return [];
    const requestIds = await db('booking_requests').whereIn('quote_id', quoteIds).pluck('id');
    if (!requestIds.length) return [];
    return db('events').whereIn('payment_lock_request_id', requestIds)
      .whereNotNull('payment_lock').whereNull('payment_unlocked_at');
  });
  for (const event of events) await refreshGalleryLock(event);
}

/** Open a locked gallery by hand. */
async function unlockGallery(eventId) {
  const updated = await db('events').where({ id: eventId }).whereNotNull('payment_lock').whereNull('payment_unlocked_at')
    .update({ payment_unlocked_at: ts(new Date()) });
  if (!updated) throw new AppError('This gallery is not waiting for payment', 409, 'GALLERY_NOT_LOCKED');
}

/** The invoices of each accepted request's deal, in the caller's CRM scope. */
async function dealInvoicesForRequests(requests) {
  const quoteIds = requests.map((r) => r.quote_id).filter(Boolean);
  const map = new Map();
  if (!quoteIds.length) return map;
  const quotes = await db('quotes').whereIn('id', quoteIds).select('id', 'deal_uuid');
  const deals = [...new Set(quotes.map((q) => q.deal_uuid).filter(Boolean))];
  if (!deals.length) return map;
  const invoices = countingInvoices(await db('invoices').whereIn('deal_uuid', deals)
    .select('id', 'invoice_number', 'status', 'kind', 'cancels_invoice_id', 'deal_uuid', 'currency', 'total_amount_minor', 'paid_amount_minor'));
  const dealByQuote = new Map(quotes.map((q) => [q.id, q.deal_uuid]));
  for (const r of requests) {
    const deal = dealByQuote.get(r.quote_id);
    map.set(r.id, deal ? invoices.filter((i) => i.deal_uuid === deal) : []);
  }
  return map;
}

/**
 * Lock state of the galleries made from each request's quote, limited to
 * the galleries `admin` may see (the events list's own scope).
 */
async function galleryLocksForRequests(requestIds, admin) {
  if (!requestIds.length) return new Map();
  const { scopeEventsListQuery } = require('../middleware/ownership');
  const rows = await scopeEventsListQuery(db('events').whereIn('payment_lock_request_id', requestIds), admin)
    .select('id', 'slug', 'event_name', 'payment_lock', 'payment_lock_request_id', 'payment_unlocked_at');
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.payment_lock_request_id)) map.set(r.payment_lock_request_id, []);
    map.get(r.payment_lock_request_id).push(r);
  }
  return map;
}

module.exports = {
  DEPOSIT_TYPES,
  GALLERY_UNLOCK,
  CHECKOUT_HOLD_MINUTES,
  hashToken,
  newStatusToken,
  depositFor,
  stripeReady,
  startCheckout,
  cancelCheckout,
  reconcileSession,
  reconcileWebhook,
  refreshFromStripe,
  refundDeposit,
  applyDepositToInvoice,
  applyGalleryLock,
  refreshGalleryLock,
  onInvoicePaid,
  unlockGallery,
  galleryLocksForRequests,
  dealInvoicesForRequests,
  countingInvoices,
};
