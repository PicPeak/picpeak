/**
 * Migration: Customer-surface feature flags, branding toggles, and password resets (#354 follow-up).
 *
 * Three things in one migration so a single rollback returns the install
 * to the prior state:
 *
 *  1. Per-customer feature flags on customer_accounts:
 *       feature_calendar / feature_quotes / feature_bills (BOOLEAN, default
 *       false). Default false because the matching pages are still
 *       coming-soon stubs — admin opts a customer in once the feature is
 *       actually useful for them. Combined with the global toggles below
 *       via AND-logic in the customer session response.
 *
 *  2. Global customer-surface toggles seeded into app_settings under
 *     setting_type='customer_surface':
 *       customer_feature_calendar_enabled  (default false)
 *       customer_feature_quotes_enabled    (default false)
 *       customer_feature_bills_enabled     (default false)
 *       customer_show_logo                 (default true  — preserves
 *                                           current visual behaviour)
 *       customer_show_company_name         (default true  — preserves
 *                                           current visual behaviour)
 *
 *  3. customer_password_resets table — admin-triggered password reset
 *     flow. Distinct from customer_invitations (which is the "create
 *     account" flow): a reset always points at an existing customer_id
 *     and updates the existing password_hash on accept.
 *
 *  Plus the customer_password_reset email template, idempotently seeded.
 *
 * All steps are idempotent — a partial rollout can be resumed by re-running
 * `knex migrate:latest`.
 */

exports.up = async function(knex) {
  // ---- per-customer feature flags ---------------------------------------

  if (await knex.schema.hasTable('customer_accounts')) {
    const cols = ['feature_calendar', 'feature_quotes', 'feature_bills'];
    for (const col of cols) {
      const exists = await knex.schema.hasColumn('customer_accounts', col);
      if (!exists) {
        // Add as a separate alterTable per column so a half-applied
        // migration (column A added, B failing) leaves the table in a
        // consistent state on retry.
        await knex.schema.alterTable('customer_accounts', (table) => {
          table.boolean(col).notNullable().defaultTo(false);
        });
      }
    }
  }

  // ---- global customer-surface settings ---------------------------------

  if (await knex.schema.hasTable('app_settings')) {
    const seeds = [
      // Features: default false. Admin must explicitly enable on the
      // settings page before the corresponding sidebar entry can show
      // for any customer.
      { setting_key: 'customer_feature_calendar_enabled', setting_value: false, setting_type: 'customer_surface' },
      { setting_key: 'customer_feature_quotes_enabled',   setting_value: false, setting_type: 'customer_surface' },
      { setting_key: 'customer_feature_bills_enabled',    setting_value: false, setting_type: 'customer_surface' },
      // Branding: default true so existing installs keep their current
      // logo + company name in the customer header until the admin
      // opts to hide them.
      { setting_key: 'customer_show_logo',          setting_value: true,  setting_type: 'customer_surface' },
      { setting_key: 'customer_show_company_name',  setting_value: true,  setting_type: 'customer_surface' },
    ];

    for (const row of seeds) {
      const existing = await knex('app_settings').where('setting_key', row.setting_key).first();
      if (!existing) {
        // Postgres JSONB column accepts both a JSON literal and a
        // JSON-stringified value depending on driver version. Stringify
        // for SQLite compatibility; Postgres accepts the same shape.
        await knex('app_settings').insert({
          setting_key: row.setting_key,
          setting_value: JSON.stringify(row.setting_value),
          setting_type: row.setting_type,
        });
      }
    }
  }

  // ---- customer_password_resets table -----------------------------------

  if (!(await knex.schema.hasTable('customer_password_resets'))) {
    await knex.schema.createTable('customer_password_resets', (table) => {
      table.increments('id').primary();
      // 64-char hex token, same shape as invitations and admin invites.
      table.string('token', 64).unique().notNullable();
      // Always points at an existing customer_account; if the account is
      // deleted, the reset disappears too.
      table.integer('customer_account_id').notNullable()
        .references('id').inTable('customer_accounts').onDelete('CASCADE');
      table.integer('requested_by_admin_id')
        .references('id').inTable('admin_users').onDelete('SET NULL');
      table.timestamp('expires_at').notNullable();
      table.timestamp('used_at');
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.index('token');
      table.index('customer_account_id');
    });
  }

  // ---- customer_password_reset email template ---------------------------

  if (await knex.schema.hasTable('email_templates')) {
    const existing = await knex('email_templates').where('template_key', 'customer_password_reset').first();
    if (!existing) {
      // Two email_templates schema variants exist in the wild:
      //
      //   (a) legacy single-locale: subject / body_html / body_text columns
      //   (b) multi-locale: subject_en / subject_de / body_html_en /
      //       body_text_en / ... — all NOT NULL on at least one install
      //       (the maintainer's prod), where the previous version of this
      //       migration silently produced a 23502 NOT NULL violation and
      //       crash-looped the backend.
      //
      // Detect whichever variant is present and populate every matching
      // column. For non-en locale columns we fall back to the English
      // content so the install isn't left with NULL-violation rows;
      // proper translations can be filled in later via the admin UI.
      const cols = await knex('email_templates').columnInfo();
      const SUBJECT = 'Reset your password';
      const BODY_HTML = `<p>Hello,</p>
<p>Your photographer has triggered a password reset for your customer account.</p>
<p><a href="{{reset_link}}">Click here to set a new password</a>. This link expires on {{expires_at}}.</p>
<p>If you didn't expect this, you can ignore the message — your current password will keep working until you click the link.</p>`;
      const BODY_TEXT = `Your photographer has triggered a password reset for your customer account.\n\nSet a new password: {{reset_link}}\n\nThis link expires on {{expires_at}}.\n\nIf you didn't expect this, you can ignore the message — your current password keeps working until you click the link.`;

      const row = {};
      if ('template_key' in cols) row.template_key = 'customer_password_reset';
      if ('language' in cols) row.language = 'en';
      if ('is_active' in cols) row.is_active = true;
      if ('created_at' in cols) row.created_at = new Date();
      if ('updated_at' in cols) row.updated_at = new Date();

      // Populate every subject/body column that exists, regardless of
      // locale suffix. Fallback content == English; safe because email
      // templates are user-editable post-install.
      for (const colName of Object.keys(cols)) {
        if (colName === 'subject' || /^subject_[a-z]{2,3}$/i.test(colName)) {
          row[colName] = SUBJECT;
        } else if (colName === 'body_html' || /^body_html_[a-z]{2,3}$/i.test(colName)) {
          row[colName] = BODY_HTML;
        } else if (colName === 'body_text' || /^body_text_[a-z]{2,3}$/i.test(colName)) {
          row[colName] = BODY_TEXT;
        }
      }

      await knex('email_templates').insert(row);
    }
  }
};

exports.down = async function(knex) {
  // ---- table -----------------------------------------------------------
  if (await knex.schema.hasTable('customer_password_resets')) {
    await knex.schema.dropTable('customer_password_resets');
  }

  // ---- per-customer flags ---------------------------------------------
  if (await knex.schema.hasTable('customer_accounts')) {
    const cols = ['feature_calendar', 'feature_quotes', 'feature_bills'];
    for (const col of cols) {
      if (await knex.schema.hasColumn('customer_accounts', col)) {
        await knex.schema.alterTable('customer_accounts', (table) => {
          table.dropColumn(col);
        });
      }
    }
  }

  // ---- settings -------------------------------------------------------
  if (await knex.schema.hasTable('app_settings')) {
    await knex('app_settings').whereIn('setting_key', [
      'customer_feature_calendar_enabled',
      'customer_feature_quotes_enabled',
      'customer_feature_bills_enabled',
      'customer_show_logo',
      'customer_show_company_name',
    ]).del();
  }

  // ---- template --------------------------------------------------------
  if (await knex.schema.hasTable('email_templates')) {
    await knex('email_templates').where('template_key', 'customer_password_reset').del();
  }
};
