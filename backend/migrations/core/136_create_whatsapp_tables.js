/**
 * Migration 136: WhatsApp Business API notification channel (#640 part D).
 *
 * Adds an alternative to the email channel for the gallery-created
 * notification — useful in markets where customers expect WhatsApp by default
 * (DACH photographers report this frequently). Strictly opt-in via the
 * `whatsapp` feature flag; defaults OFF on every install.
 *
 * Two tables:
 *   - whatsapp_configs : single-row config (Meta phone_number_id, waba_id,
 *                        access_token, template_name). Token is admin-only,
 *                        masked on GET, never returned in plaintext outside
 *                        the route layer.
 *   - whatsapp_queue   : per-message queue mirroring email_queue's shape —
 *                        recipient, message_type, message_data JSON, retry
 *                        count, error_message. Polled by the WhatsApp queue
 *                        processor every 30s.
 *
 * Loose-FK on event_id by design — matches `inbound_documents.event_id` and
 * `expenses.event_id` and avoids the RESTRICT-on-delete problem (deleting an
 * event shouldn't fail because a stale queue row references it).
 *
 * Ported from filpgame's #1 with adjustments: loose-FK, renumbered to next
 * free migration slot, schema otherwise compatible.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('whatsapp_configs'))) {
    await knex.schema.createTable('whatsapp_configs', (table) => {
      table.increments('id').primary();
      table.string('phone_number_id', 255).notNullable().defaultTo('');
      table.string('waba_id', 255).notNullable().defaultTo('');
      // Meta access tokens are long-lived JWT-style strings; 1000 chars
      // covers system-user tokens with comfortable headroom.
      table.string('access_token', 1000).notNullable().defaultTo('');
      table.string('template_name', 255).notNullable().defaultTo('gallery_ready');
      table.boolean('enabled').notNullable().defaultTo(false);
      table.timestamp('updated_at').defaultTo(knex.fn.now());
    });
  }

  if (!(await knex.schema.hasTable('whatsapp_queue'))) {
    await knex.schema.createTable('whatsapp_queue', (table) => {
      table.increments('id').primary();
      // Loose-FK: event_id references events.id but no FK constraint, so an
      // event delete doesn't RESTRICT against stale queue rows.
      table.integer('event_id').unsigned();
      table.string('recipient_phone', 50).notNullable();
      table.string('message_type', 50).notNullable();
      table.json('message_data');
      table.string('status', 20).notNullable().defaultTo('pending');
      table.integer('retry_count').notNullable().defaultTo(0);
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('scheduled_at').defaultTo(knex.fn.now());
      table.timestamp('sent_at');
      table.text('error_message');
      // Index the poll path: pending + retry_count < threshold, ordered by
      // created_at. Single composite index covers all three.
      table.index(['status', 'retry_count', 'created_at'], 'whatsapp_queue_poll_index');
      table.index(['event_id']);
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('whatsapp_queue');
  await knex.schema.dropTableIfExists('whatsapp_configs');
};
