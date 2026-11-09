/**
 * Migration 355: booking deposits and gallery unlock on payment (#2440, part 3).
 *
 * Per service (quote_line_item_presets):
 *   booking_deposit_type     none | percent | fixed — paid by card through
 *                            Stripe Checkout when the client sends the
 *                            request; it secures the slot.
 *   booking_deposit_percent  percent of the estimate
 *   booking_deposit_minor    fixed amount (capped at the estimate)
 *   gallery_unlock           full_payment (default) | deposit | off — when a
 *                            gallery made from the booking's quote opens:
 *                            once every invoice of the deal is paid, once the
 *                            deposit is paid, or right away.
 *
 * Per request (booking_requests), the status also takes `awaiting_payment`
 * (the slot is held for the checkout only):
 *   deposit_minor, deposit_status (none | open | paid | refunded |
 *   refund_failed | expired | review — paid, but not the expected amount),
 *   checkout_session_id, payment_intent_id, deposit_paid_at, deposit_invoice_id (the invoice the admin booked the
 *   deposit on), gallery_unlock (the service's setting when it came in),
 *   status_token_hash (sha256 of the token on the client's status page).
 *
 * Per gallery (events):
 *   payment_lock             full_payment while the gallery waits for full
 *                            payment; NULL = no lock
 *   payment_lock_request_id  the booking request it came from
 *   payment_unlocked_at      when it opened (paid, or unlocked by hand)
 *
 * Additive and idempotent.
 */

async function addColumn(knex, table, column, build) {
  if (!(await knex.schema.hasTable(table))) return;
  if (await knex.schema.hasColumn(table, column)) return;
  await knex.schema.alterTable(table, (t) => build(t));
}

const PRESET_COLUMNS = [
  ['booking_deposit_type', (t) => t.string('booking_deposit_type', 8).notNullable().defaultTo('none')],
  ['booking_deposit_percent', (t) => t.decimal('booking_deposit_percent', 5, 2)],
  ['booking_deposit_minor', (t) => t.bigInteger('booking_deposit_minor')],
  ['gallery_unlock', (t) => t.string('gallery_unlock', 16).notNullable().defaultTo('full_payment')],
];

const REQUEST_COLUMNS = [
  ['deposit_minor', (t) => t.bigInteger('deposit_minor').notNullable().defaultTo(0)],
  ['deposit_status', (t) => t.string('deposit_status', 16).notNullable().defaultTo('none')],
  ['checkout_session_id', (t) => t.string('checkout_session_id', 255).unique()],
  ['payment_intent_id', (t) => t.string('payment_intent_id', 255)],
  ['deposit_paid_at', (t) => t.timestamp('deposit_paid_at')],
  ['deposit_invoice_id', (t) => t.integer('deposit_invoice_id')],
  ['gallery_unlock', (t) => t.string('gallery_unlock', 16)],
  ['status_token_hash', (t) => t.string('status_token_hash', 64)],
];

const EVENT_COLUMNS = [
  ['payment_lock', (t) => t.string('payment_lock', 16)],
  ['payment_lock_request_id', (t) => t.integer('payment_lock_request_id')],
  ['payment_unlocked_at', (t) => t.timestamp('payment_unlocked_at')],
];

exports.up = async function (knex) {
  for (const [column, build] of PRESET_COLUMNS) await addColumn(knex, 'quote_line_item_presets', column, build);
  for (const [column, build] of REQUEST_COLUMNS) await addColumn(knex, 'booking_requests', column, build);
  for (const [column, build] of EVENT_COLUMNS) await addColumn(knex, 'events', column, build);
  await knex.raw('CREATE INDEX IF NOT EXISTS booking_requests_status_token ON booking_requests (status_token_hash)');
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS booking_requests_status_token');
  const drop = async (table, columns) => {
    for (const [column] of columns) {
      if (await knex.schema.hasColumn(table, column)) {
        await knex.schema.alterTable(table, (t) => t.dropColumn(column));
      }
    }
  };
  await drop('events', EVENT_COLUMNS);
  await drop('booking_requests', REQUEST_COLUMNS);
  await drop('quote_line_item_presets', PRESET_COLUMNS);
};
