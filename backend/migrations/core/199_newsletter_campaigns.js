/**
 * Newsletter campaigns (issue #1264, Part B).
 *
 * A campaign is NOT a parallel sender. It is a body + a recipient rule, and
 * queueing one writes ordinary `email_queue` rows — so retry, `rendered_html`,
 * `sent_at`, `error_message` and the System Health queue view all come for
 * free from the existing processor. The only new column on the queue is
 * `campaign_id`, which follows the `origin` column added by migration 155.
 *
 * Two new tables:
 *
 *  - `email_campaigns` — the campaign itself. `body_html` / `body_css` are
 *    stored ALREADY SANITIZED (newsletterService.sanitizeCampaignBody /
 *    sanitizeCampaignCss); raw HTML is never persisted.
 *
 *  - `email_campaign_recipients` — the per-recipient audit trail. Deliberately
 *    NOT derivable from `email_queue`: queue rows are pruned, and a campaign's
 *    "who did this actually reach" record has to outlive that. It stores email
 *    + status only, no rendered body.
 *
 * Plus:
 *  - `customer_accounts.marketing_opt_out` — opt-out, per customer, one
 *    column. Transactional mail ignores it entirely; it is checked at queue
 *    time AND again at send time, so a customer who unsubscribes after a
 *    campaign is queued is still skipped.
 *  - `newsletters.view` / `newsletters.send` permissions, granted to
 *    super_admin and the admin role (175-style idempotent grant). `send` is
 *    separate from `view` on purpose: mass mail is the one CRM action a
 *    compromised or careless account can't take back.
 *
 * Every step is hasTable/hasColumn-guarded and safe to re-run.
 */

const NEW_PERMISSIONS = [
  {
    name: 'newsletters.view',
    display_name: 'View Newsletters',
    category: 'clients',
    description: 'Read newsletter campaigns, their recipients and delivery status.',
  },
  {
    name: 'newsletters.send',
    display_name: 'Send Newsletters',
    category: 'clients',
    description: 'Create, edit and queue newsletter campaigns to customers. Mass mail — grant deliberately.',
  },
];

exports.up = async function (knex) {
  // ---- email_campaigns ------------------------------------------------
  if (!(await knex.schema.hasTable('email_campaigns'))) {
    await knex.schema.createTable('email_campaigns', (t) => {
      t.increments('id').primary();
      t.string('name', 120).notNullable();
      t.string('subject', 255).notNullable();
      // Sanitized on write. Never raw admin input.
      t.text('body_html');
      t.text('body_css');
      t.string('language', 8).notNullable().defaultTo('en');
      // draft | queued | sending | sent | cancelled | failed
      t.string('status', 16).notNullable().defaultTo('draft');
      // all_active | manual
      t.string('recipient_mode', 16).notNullable().defaultTo('all_active');
      // Reserved for tags/segments (issue #1264 decision 9 keeps them out of
      // v1). Having the column now means adding them later is a service
      // change, not a migration on a table holding live campaigns.
      t.text('recipient_filter');
      t.integer('recipient_count').notNullable().defaultTo(0);
      t.integer('sent_count').notNullable().defaultTo(0);
      t.integer('failed_count').notNullable().defaultTo(0);
      // Staggering rate. Clamped 1..120 at the service layer — a provider
      // limit (SES 14/s, many shared hosts 100/h) is the real constraint.
      t.integer('send_rate_per_minute').notNullable().defaultTo(20);
      // SET NULL, matching the ownership-reference invariant elsewhere: on
      // Postgres the default NO ACTION would make deleteAdminUser() fail
      // permanently once that admin had created a campaign.
      t.integer('created_by_admin_id').unsigned()
        .references('id').inTable('admin_users').onDelete('SET NULL');
      t.timestamp('test_sent_at');
      t.timestamp('queued_at');
      t.timestamp('completed_at');
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('updated_at').defaultTo(knex.fn.now());
      t.index(['status']);
    });
  }

  // ---- email_campaign_recipients --------------------------------------
  if (!(await knex.schema.hasTable('email_campaign_recipients'))) {
    await knex.schema.createTable('email_campaign_recipients', (t) => {
      t.increments('id').primary();
      t.integer('campaign_id').unsigned().notNullable()
        .references('id').inTable('email_campaigns').onDelete('CASCADE');
      // SET NULL, not CASCADE: deleting a customer must not erase the record
      // that a campaign reached their address.
      t.integer('customer_account_id').unsigned()
        .references('id').inTable('customer_accounts').onDelete('SET NULL');
      t.string('email', 255).notNullable();
      t.integer('email_queue_id').unsigned();
      // queued | sent | failed | cancelled | skipped_opt_out
      t.string('status', 20).notNullable().defaultTo('queued');
      t.text('error_message');
      t.timestamp('sent_at');
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.index(['campaign_id', 'status']);
      // One row per customer per campaign — the guard against a double-queue
      // sending the same person the same newsletter twice.
      t.unique(['campaign_id', 'customer_account_id']);
    });
  }

  // ---- email_queue.campaign_id ----------------------------------------
  if (await knex.schema.hasTable('email_queue')) {
    if (!(await knex.schema.hasColumn('email_queue', 'campaign_id'))) {
      await knex.schema.alterTable('email_queue', (t) => {
        t.integer('campaign_id').unsigned();
        t.index(['campaign_id']);
      });
    }
  }

  // ---- customer_accounts marketing opt-out -----------------------------
  if (await knex.schema.hasTable('customer_accounts')) {
    if (!(await knex.schema.hasColumn('customer_accounts', 'marketing_opt_out'))) {
      await knex.schema.alterTable('customer_accounts', (t) => {
        t.boolean('marketing_opt_out').notNullable().defaultTo(false);
      });
    }
    if (!(await knex.schema.hasColumn('customer_accounts', 'marketing_opt_out_at'))) {
      await knex.schema.alterTable('customer_accounts', (t) => {
        t.timestamp('marketing_opt_out_at');
      });
    }
  }

  // ---- permissions ------------------------------------------------------
  const hasPermissions = await knex.schema.hasTable('permissions');
  const hasRoles = await knex.schema.hasTable('roles');
  const hasRolePermissions = await knex.schema.hasTable('role_permissions');
  if (!hasPermissions || !hasRoles || !hasRolePermissions) return;

  const existing = await knex('permissions')
    .whereIn('name', NEW_PERMISSIONS.map((p) => p.name))
    .select('name');
  const have = new Set(existing.map((r) => r.name));
  const toInsert = NEW_PERMISSIONS.filter((p) => !have.has(p.name));
  if (toInsert.length > 0) {
    await knex('permissions').insert(toInsert);
  }

  const permIds = (await knex('permissions')
    .whereIn('name', NEW_PERMISSIONS.map((p) => p.name))
    .select('id')).map((p) => p.id);
  if (permIds.length === 0) return;

  // super_admin tracks all (the boot self-heal would grant these anyway —
  // doing it here means a fresh install is correct before first boot).
  // `admin` gets them too, matching the plan: newsletters are a day-to-day
  // operator capability, not an owner-only one. Every other role, including
  // the frozen presets, starts without them.
  for (const roleName of ['super_admin', 'admin']) {
    const role = await knex('roles').where({ name: roleName }).first();
    if (!role) continue;
    const granted = await knex('role_permissions')
      .where({ role_id: role.id })
      .whereIn('permission_id', permIds)
      .select('permission_id');
    const has = new Set(granted.map((r) => r.permission_id));
    const inserts = permIds
      .filter((id) => !has.has(id))
      .map((id) => ({ role_id: role.id, permission_id: id }));
    if (inserts.length > 0) {
      await knex('role_permissions').insert(inserts);
    }
  }
};

exports.down = async function (knex) {
  if (await knex.schema.hasTable('email_campaign_recipients')) {
    await knex.schema.dropTable('email_campaign_recipients');
  }
  if (await knex.schema.hasTable('email_campaigns')) {
    await knex.schema.dropTable('email_campaigns');
  }
  if (await knex.schema.hasTable('email_queue')
    && await knex.schema.hasColumn('email_queue', 'campaign_id')) {
    await knex.schema.alterTable('email_queue', (t) => t.dropColumn('campaign_id'));
  }
  if (await knex.schema.hasTable('customer_accounts')) {
    for (const column of ['marketing_opt_out', 'marketing_opt_out_at']) {
      if (await knex.schema.hasColumn('customer_accounts', column)) {
        await knex.schema.alterTable('customer_accounts', (t) => t.dropColumn(column));
      }
    }
  }
  if (await knex.schema.hasTable('permissions')) {
    const perms = await knex('permissions')
      .whereIn('name', NEW_PERMISSIONS.map((p) => p.name))
      .select('id');
    const ids = perms.map((p) => p.id);
    if (ids.length > 0) {
      if (await knex.schema.hasTable('role_permissions')) {
        await knex('role_permissions').whereIn('permission_id', ids).del();
      }
      await knex('permissions').whereIn('id', ids).del();
    }
  }
};
