'use strict';
/**
 * Parcel tracking for an album order (issue 2422).
 *
 * The studio records each parcel it sent for a confirmed offer. The customer
 * of the order gets a mail with the tracking link (unless the studio unticks
 * it) and sees the parcel on the portal dashboard.
 *
 * Whose order it is: the offer's own customer (released_customer_id), else the
 * gallery's only customer, else the customer it is billed to. A gallery
 * opened by PIN alone, or shared by several customers with nobody named on
 * the offer, has nobody to tell: the admin form says so.
 */
const { AppError, ConflictError, NotFoundError } = require('../../utils/errors');
const { formatBoolean } = require('../../utils/dbCompat');
const { toIso } = require('../../utils/dateNormalize');
const logger = require('../../utils/logger');
const V = require('./validation');

// Public tracking pages. {n} is the URL-encoded tracking number.
const CARRIERS = {
  dhl: { name: 'DHL', url: 'https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode={n}' },
  dhl_express: { name: 'DHL Express', url: 'https://www.dhl.com/global-en/home/tracking.html?tracking-id={n}&submit=1' },
  deutsche_post: { name: 'Deutsche Post', url: 'https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode={n}' },
  dpd: { name: 'DPD', url: 'https://tracking.dpd.de/status/de_DE/parcel/{n}' },
  hermes: { name: 'Hermes', url: 'https://www.myhermes.de/empfangen/sendungsverfolgung/sendungsinformation/#{n}' },
  gls: { name: 'GLS', url: 'https://gls-group.com/DE/de/paketverfolgung?match={n}' },
  ups: { name: 'UPS', url: 'https://www.ups.com/track?tracknum={n}' },
  fedex: { name: 'FedEx', url: 'https://www.fedex.com/fedextrack/?trknbr={n}' },
  other: { name: null, url: null },
};
const NUMBER = /^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,63}$/;

/** An admin-entered link, kept only when it is a plain http(s) URL. */
function customUrl(value) {
  if (value == null || value === '') return null;
  let url;
  try {
    url = new URL(String(value).trim());
  } catch (_) {
    throw new AppError('Enter a tracking link that starts with https:// or http://', 400);
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.href.length > 2048)
    throw new AppError('Enter a tracking link that starts with https:// or http://', 400);
  return url.href;
}

/** The tracking link for a stored shipment, or null ("other" without a link). */
function trackingUrl(carrier, number, stored = null) {
  const known = CARRIERS[carrier];
  if (!known || !known.url) return stored || null;
  return known.url.replace('{n}', encodeURIComponent(number));
}

function shape(row) {
  return {
    id: row.id,
    offerId: row.offer_id,
    carrier: row.carrier,
    carrierName: CARRIERS[row.carrier]?.name || null,
    trackingNumber: row.tracking_number,
    trackingUrl: trackingUrl(row.carrier, row.tracking_number, row.tracking_url),
    shippedAt: toIso(row.shipped_at) || null,
    notifiedAt: toIso(row.notified_at) || null,
  };
}

/**
 * Where the customer's mail stands: 'sent', 'failed', 'queued' (waiting for
 * business hours or the next run) or null (none, withdrawn or held back).
 * notified_at only says it was queued; the queue row says whether it went.
 */
async function mailStates(conn, rows) {
  const ids = rows.map((r) => r.notification_id).filter((id) => id != null);
  const status = new Map(ids.length
    ? (await conn('email_queue').whereIn('id', ids).select('id', 'status')).map((q) => [Number(q.id), q.status])
    : []);
  return (row) => {
    if (!row.notified_at) return null;
    const state = status.get(Number(row.notification_id));
    if (state === 'sent' || state === 'failed') return state;
    if (state === 'cancelled' || state === 'suppressed') return null;
    // Pending, or a queue row pruned since: assume it went once pruned.
    return state === undefined && row.notification_id != null ? 'sent' : 'queued';
  };
}

/** The customer an offer's order belongs to, or null (see the header). */
async function orderCustomerId(conn, offer) {
  const assigned = (
    await conn('event_customer_assignments').where({ event_id: offer.event_id }).pluck('customer_account_id')
  ).map(Number);
  const candidate = offer.released_customer_id
    ?? (assigned.length === 1 ? assigned[0] : offer.billing_customer_id)
    ?? null;
  return candidate != null && assigned.includes(Number(candidate)) ? Number(candidate) : null;
}

/** Who the mail goes to: that customer, active and with an address. */
async function recipient(conn, customerId) {
  if (customerId == null) return null;
  const customer = await conn('customer_accounts')
    .where({ id: customerId, is_active: formatBoolean(true) })
    .first('id', 'email', 'display_name', 'first_name', 'last_name', 'preferred_language', 'password_hash');
  if (!customer || !customer.email) return null;
  return customer;
}
const customerName = (c) => (c.display_name && c.display_name.trim())
  || [c.first_name, c.last_name].filter(Boolean).join(' ').trim()
  || String(c.email || '').split('@')[0];

async function offerOf(conn, eventId, offerId) {
  const offer = await conn('event_album_products').where({ event_id: eventId, id: V.uuid(offerId) }).first();
  if (!offer) throw new NotFoundError('Product offer');
  return offer;
}

async function list(conn, eventId, offerId) {
  const offer = await offerOf(conn, eventId, offerId);
  const customer = await recipient(conn, await orderCustomerId(conn, offer));
  const rows = await conn('album_shipments').where({ offer_id: offer.id }).orderBy('shipped_at', 'desc').orderBy('id', 'desc');
  const mail = await mailStates(conn, rows);
  return {
    shipments: rows.map((row) => ({ ...shape(row), mail: mail(row) })),
    recipient: customer ? { id: customer.id, name: customerName(customer), email: customer.email } : null,
  };
}

/** Queues the customer's mail; returns what happened and the queue row. */
async function notify(conn, offer, row) {
  const ids = { shipmentId: row.id, offerId: offer.id };
  let queueId = null;
  try {
    const customer = await recipient(conn, row.customer_account_id);
    if (!customer) return { status: 'skipped' };
    const { getFrontendBaseUrl } = require('../../utils/frontendUrl');
    const base = ((await getFrontendBaseUrl()) || 'http://localhost:3000').replace(/\/+$/, '');
    const event = await conn('events').where({ id: offer.event_id }).first('event_name');
    let business = '';
    try {
      const { profile } = await require('../businessProfileService').getProfile();
      business = (profile && (profile.company_name || profile.legal_name)) || '';
    } catch (_) { /* the mail reads fine without a sender line */ }
    const result = await require('../emailProcessor').queueEmail(offer.event_id, customer.email, 'album_shipped', {
      customer_name: customerName(customer),
      business_name: business,
      product_name: V.parse(offer.selection)?.product?.name || '',
      event_name: (event && event.event_name) || '',
      carrier_name: CARRIERS[row.carrier]?.name || '',
      tracking_number: row.tracking_number,
      tracking_link: trackingUrl(row.carrier, row.tracking_number, row.tracking_url) || '',
      // A passive customer (no password) cannot sign in to the portal.
      portal_link: customer.password_hash ? `${base}/customer/dashboard` : '',
      __language: customer.preferred_language || undefined,
    }, {
      customerAccountId: customer.id,
      respectBusinessHours: true,
      onQueued: (id) => { queueId = id; },
    });
    if (result === 'suppressed') return { status: 'skipped' };
    return result ? { status: 'queued', queueId } : { status: 'failed' };
  } catch (err) {
    logger.warn('Could not queue the album shipment mail', { ...ids, error: err.message });
    return { status: 'failed' };
  }
}

/**
 * Records a parcel. The mail is queued after the row is written, and a failed
 * queue never undoes the record: the response says what happened.
 */
async function create(conn, eventId, offerId, input, adminId) {
  const offer = await offerOf(conn, eventId, offerId);
  // Confirmed as the portal reads it: locked, or a client-final submission.
  const confirmed = offer.status === 'locked'
    || (offer.status === 'submitted' && !!V.parse(offer.selection)?.clientFinal);
  if (!confirmed) throw new ConflictError('Only a confirmed order can be shipped');
  const carrier = typeof input.carrier === 'string' ? input.carrier : '';
  if (!Object.prototype.hasOwnProperty.call(CARRIERS, carrier))
    throw new AppError('Choose a carrier', 400);
  const number = typeof input.trackingNumber === 'string' ? input.trackingNumber.trim() : '';
  if (!NUMBER.test(number))
    throw new AppError('Enter a tracking number of up to 64 letters and digits', 400);
  if (input.notify !== undefined && typeof input.notify !== 'boolean')
    throw new AppError('Invalid notification setting', 400);
  const now = new Date().toISOString();
  const row = {
    offer_id: offer.id,
    carrier,
    tracking_number: number,
    tracking_url: carrier === 'other' ? customUrl(input.trackingUrl) : null,
    shipped_at: now,
    notified_at: null,
    created_by: adminId ?? null,
    created_at: now,
    // Whose order it is now; a later change of the gallery's customers
    // must not hand this parcel to someone else.
    customer_account_id: await orderCustomerId(conn, offer),
  };
  const inserted = await conn('album_shipments').insert(row).returning('id');
  row.id = inserted[0]?.id ?? inserted[0];
  const sent = input.notify === false ? { status: 'off' } : await notify(conn, offer, row);
  if (sent.status === 'queued') {
    row.notified_at = new Date().toISOString();
    await conn('album_shipments').where({ id: row.id })
      .update({ notified_at: row.notified_at, notification_id: sent.queueId ?? null });
  }
  return {
    shipment: { ...shape(row), mail: sent.status === 'queued' ? 'queued' : null },
    notification: sent.status,
  };
}

/**
 * Deletes a mistaken parcel. Its mail, if it still waits for business hours,
 * goes with it, so the customer never gets a number the studio withdrew; a
 * mail already sent stays in the log.
 */
async function remove(conn, eventId, offerId, shipmentId) {
  const offer = await offerOf(conn, eventId, offerId);
  await conn.transaction(async (trx) => {
    const row = await trx('album_shipments').where({ id: shipmentId, offer_id: offer.id }).first('id', 'notification_id');
    if (!row) throw new NotFoundError('Shipment');
    if (row.notification_id != null)
      await trx('email_queue').where({ id: row.notification_id, status: 'pending' }).update({ status: 'cancelled' });
    await trx('album_shipments').where({ id: row.id }).del();
  });
}

/**
 * The parcels of this customer's orders, newest first, for the portal: the
 * ones recorded for them, in galleries they are still assigned to.
 */
async function forCustomer(conn, customerId) {
  const rows = await conn('album_shipments as s')
    .join('event_album_products as o', 'o.id', 's.offer_id')
    .join('events as e', 'e.id', 'o.event_id')
    .join('event_customer_assignments as a', function joinAssignment() {
      this.on('a.event_id', '=', 'o.event_id').andOn('a.customer_account_id', '=', 's.customer_account_id');
    })
    .where('s.customer_account_id', customerId)
    .select('s.*', 'o.selection', 'e.event_name')
    .orderBy('s.shipped_at', 'desc')
    .orderBy('s.id', 'desc');
  return rows.map((row) => ({
    ...shape(row),
    productName: V.parse(row.selection)?.product?.name || null,
    eventName: row.event_name,
  }));
}

/**
 * Customer erasure: a tracking number leads to the person's address. The
 * parcels recorded for them, and any on an order still released to them.
 */
async function forgetCustomer(tx, customerId) {
  if (!(await tx.schema.hasTable('album_shipments'))) return;
  const id = Number(customerId);
  await tx('album_shipments')
    .where({ customer_account_id: id })
    .orWhereIn('offer_id', tx('event_album_products').where({ released_customer_id: id }).select('id'))
    .del();
}

module.exports = {
  CARRIERS, trackingUrl, orderCustomerId, list, create, remove, forCustomer, forgetCustomer,
};
