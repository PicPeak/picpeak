/**
 * #327 — outbound webhooks (push API) for the event/photo lifecycle.
 *
 * Two tables:
 *   webhooks                — admin-managed subscriptions (URL + events + secret)
 *   webhook_deliveries      — single source of truth for the delivery worker
 *                              (audit log + retry queue in one).
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('webhooks'))) {
    await knex.schema.createTable('webhooks', (table) => {
      table.increments('id').primary();
      table.string('name', 100).notNullable();
      // Validated via networkValidation.validateExternalUrl on create + per
      // delivery (DNS-rebinding mitigation).
      table.string('url', 2048).notNullable();
      // Plaintext signing secret (`whsec_<random>`). Stored unencrypted
      // because we need to recompute HMAC-SHA256 over every outbound body
      // — a hash would make the secret unrecoverable. Same posture as
      // SMTP passwords stored in app_settings; protect the DB. The
      // plaintext is also returned to the admin once on create so they can
      // configure the receiver to verify signatures.
      table.string('secret', 100).notNullable();
      // First 8 chars of the secret for the admin UI so operators can
      // tell which webhook is which without revealing the full secret.
      table.string('secret_preview', 16).nullable();
      // JSON array of subscribed event types
      // (e.g. ["event.published","photo.uploaded"]).
      table.jsonb('events').notNullable().defaultTo('[]');
      table.boolean('active').notNullable().defaultTo(true);
      table.integer('created_by').notNullable()
        .references('id').inTable('admin_users').onDelete('CASCADE');
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());
      table.timestamp('last_success_at').nullable();
      table.timestamp('last_failure_at').nullable();
      // Index for the delivery worker's "find subscriptions for this event"
      // query — small set, but keeps the lookup constant-time as it grows.
      table.index('active', 'webhooks_active_idx');
    });
  }

  if (!(await knex.schema.hasTable('webhook_deliveries'))) {
    await knex.schema.createTable('webhook_deliveries', (table) => {
      table.increments('id').primary();
      table.integer('webhook_id').notNullable()
        .references('id').inTable('webhooks').onDelete('CASCADE');
      table.string('event_type', 64).notNullable();
      // Full signed payload (the JSON body that was POSTed).
      table.jsonb('payload').notNullable();
      table.integer('attempt_count').notNullable().defaultTo(0);
      // pending → success | failed. pending rows with next_retry_at <= NOW()
      // are picked up by the worker.
      table.string('status', 16).notNullable().defaultTo('pending');
      table.integer('response_status').nullable();
      // Truncated to 1KB before storage so a verbose receiver can't blow
      // up the row size.
      table.text('response_body').nullable();
      table.text('last_error').nullable();
      table.integer('latency_ms').nullable();
      table.timestamp('next_retry_at').nullable();
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('completed_at').nullable();
      // Worker hot-path query: WHERE status='pending' AND next_retry_at <= NOW()
      // ORDER BY next_retry_at LIMIT N. This composite index serves it directly.
      table.index(['status', 'next_retry_at'], 'webhook_deliveries_status_retry_idx');
      table.index('webhook_id', 'webhook_deliveries_webhook_idx');
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('webhook_deliveries')) {
    await knex.schema.dropTable('webhook_deliveries');
  }
  if (await knex.schema.hasTable('webhooks')) {
    await knex.schema.dropTable('webhooks');
  }
};
