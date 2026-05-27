/**
 * Migration: Add Customer Accounts (recurring user logins)
 *
 * Implements the customer tier from discussion the-luap/picpeak#354.
 *
 * Three new tables:
 *  - customer_accounts        : the user record (email + bcrypt password)
 *  - customer_invitations     : admin → customer invite handshake (mirrors admin_invitations)
 *  - event_customer_assignments: many-to-many junction with events
 *
 * Three new RBAC permissions seeded so super_admin and admin roles can
 * manage customers immediately after migrate. Editor / viewer remain
 * locked out by design (matches the existing users.* permissions pattern).
 *
 * Migration is idempotent — every step checks for existing state so a
 * partial install can be resumed.
 */

exports.up = async function(knex) {
  // ---- customer_accounts -----------------------------------------------
  if (!(await knex.schema.hasTable('customer_accounts'))) {
    await knex.schema.createTable('customer_accounts', (table) => {
      table.increments('id').primary();
      table.string('email', 255).unique().notNullable();

      // --- auth ---------------------------------------------------------
      // password_hash is nullable until the invitation is accepted —
      // an unaccepted account row exists only after acceptInvitation, so
      // in practice this is always set, but the column is nullable to
      // allow for future "admin creates pre-loaded account" flows.
      table.string('password_hash', 255);
      table.boolean('must_change_password').notNullable().defaultTo(false);
      table.boolean('is_active').notNullable().defaultTo(true);
      // Tracks password-change time so JWTs issued before a password
      // change are rejected by customerAuth middleware. Mirrors the
      // admin_users.password_changed_at column.
      table.timestamp('password_changed_at');
      table.timestamp('last_login');
      table.string('last_login_ip', 45);
      table.string('preferred_language', 8).defaultTo('en');

      // --- contact ------------------------------------------------------
      // Salutation honorific (Herr / Frau / Mx / Dr / Other). Stored as
      // free text rather than an enum so future locales (German "Frau",
      // French "Mme", legal titles "Dr.", etc.) don't need a migration.
      table.string('salutation', 32);
      table.string('first_name', 80);
      table.string('last_name', 80);
      // Convenience display name kept separately so the dashboard can
      // greet customers without joining first/last (e.g. "Welcome, Luca").
      table.string('display_name', 120);
      table.string('phone', 40);
      table.string('company_name', 120);

      // --- billing / address (for future quotes & invoicing) -----------
      table.string('billing_email', 255);
      table.string('vat_id', 40);
      table.string('address_line1', 255);
      table.string('address_line2', 255);
      table.string('postal_code', 20);
      table.string('city', 120);
      table.string('state', 120);
      table.string('country_code', 2); // ISO 3166-1 alpha-2

      // --- audit --------------------------------------------------------
      table.text('notes'); // free-text admin notes, never shown to the customer
      table.integer('created_by_admin_id').unsigned()
        .references('id').inTable('admin_users').onDelete('SET NULL');
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());

      table.index(['email']);
      table.index(['is_active']);
      table.index(['last_name']);
      table.index(['company_name']);
    });
  }

  // ---- customer_invitations --------------------------------------------
  if (!(await knex.schema.hasTable('customer_invitations'))) {
    await knex.schema.createTable('customer_invitations', (table) => {
      table.increments('id').primary();
      table.string('email', 255).notNullable();
      // 64 chars = 32 bytes hex = 256 bits — same entropy as admin invites.
      table.string('token', 64).unique().notNullable();
      table.integer('invited_by').unsigned()
        .references('id').inTable('admin_users').onDelete('CASCADE').notNullable();
      table.timestamp('expires_at').notNullable();
      table.timestamp('accepted_at');
      table.integer('accepted_customer_id').unsigned()
        .references('id').inTable('customer_accounts').onDelete('SET NULL');
      table.timestamp('created_at').defaultTo(knex.fn.now());

      table.index(['token']);
      table.index(['email']);
      table.index(['expires_at']);
      table.index(['accepted_at']);
    });
  }

  // ---- event_customer_assignments --------------------------------------
  if (!(await knex.schema.hasTable('event_customer_assignments'))) {
    await knex.schema.createTable('event_customer_assignments', (table) => {
      table.increments('id').primary();
      table.integer('event_id').unsigned().notNullable()
        .references('id').inTable('events').onDelete('CASCADE');
      table.integer('customer_account_id').unsigned().notNullable()
        .references('id').inTable('customer_accounts').onDelete('CASCADE');
      table.integer('assigned_by_admin_id').unsigned()
        .references('id').inTable('admin_users').onDelete('SET NULL');
      table.timestamp('assigned_at').defaultTo(knex.fn.now());

      table.unique(['event_id', 'customer_account_id']);
      table.index(['customer_account_id']);
      table.index(['event_id']);
    });
  }

  // ---- RBAC permissions -------------------------------------------------
  // Insert the three customers.* permissions if they're not already present
  // (guards against re-running the migration in dev). The same idempotency
  // pattern as 055_add_permissions_table.js.
  const existingPermissions = await knex('permissions').select('name');
  const existingNames = new Set(existingPermissions.map((p) => p.name));
  const newPermissions = [
    {
      name: 'customers.view',
      display_name: 'View Customers',
      category: 'customers',
      description: 'View customer accounts and their event assignments',
    },
    {
      name: 'customers.create',
      display_name: 'Invite Customers',
      category: 'customers',
      description: 'Issue customer invitations and assign customers to events',
    },
    {
      name: 'customers.delete',
      display_name: 'Deactivate Customers',
      category: 'customers',
      description: 'Deactivate customer accounts and revoke their access',
    },
  ].filter((p) => !existingNames.has(p.name));

  if (newPermissions.length > 0) {
    await knex('permissions').insert(newPermissions);
  }

  // Grant the three permissions to super_admin and admin so the feature
  // is usable immediately. We look up role / permission ids fresh because
  // the inserts above just landed.
  const roles = await knex('roles').select('id', 'name')
    .whereIn('name', ['super_admin', 'admin']);
  const perms = await knex('permissions').select('id', 'name')
    .whereIn('name', ['customers.view', 'customers.create', 'customers.delete']);

  if (roles.length > 0 && perms.length > 0) {
    const existing = await knex('role_permissions').select('role_id', 'permission_id');
    const existingSet = new Set(existing.map((m) => `${m.role_id}-${m.permission_id}`));
    const inserts = [];
    for (const role of roles) {
      for (const perm of perms) {
        const key = `${role.id}-${perm.id}`;
        if (!existingSet.has(key)) {
          inserts.push({ role_id: role.id, permission_id: perm.id });
        }
      }
    }
    if (inserts.length > 0) {
      await knex('role_permissions').insert(inserts);
    }
  }

  // ---- email template seed ---------------------------------------------
  // Schema is the post-075 shape: a master `email_templates` row keyed by
  // template_key, plus one `email_template_translations` row per language.
  // The legacy subject/body_html/body_text columns on email_templates may
  // still exist for back-compat, so we populate both wherever the column
  // is present — defensive, since some installs may run mid-upgrade.
  if (await knex.schema.hasTable('email_templates')) {
    const existing = await knex('email_templates')
      .where('template_key', 'customer_invitation')
      .first();

    let templateId = existing?.id;
    if (!existing) {
      // Build the master row by introspecting the columns that actually
      // exist on this install. The schema has drifted across migrations
      // (075 adds language-specific columns then 075 normalises into a
      // separate translations table; some installs lack `created_at` /
      // `updated_at` on the master row). Anything not present is skipped
      // silently rather than causing the whole migration to abort and
      // taking the backend down with it.
      const masterColumns = await knex('email_templates').columnInfo();
      const insertRow = {
        template_key: 'customer_invitation',
      };
      if (masterColumns.variables) {
        insertRow.variables = JSON.stringify(['invite_link', 'expires_at']);
      }
      if (masterColumns.created_at) insertRow.created_at = knex.fn.now();
      if (masterColumns.updated_at) insertRow.updated_at = knex.fn.now();
      // Populate legacy single-language columns when present so older
      // email service code paths still find a sensible default body.
      if (masterColumns.subject) insertRow.subject = 'You\'ve been invited to access your photo galleries';
      if (masterColumns.body_html) {
        insertRow.body_html = '<p>You\'ve been invited to create a customer account. <a href="{{invite_link}}">Set up your account</a> (expires {{expires_at}}).</p>';
      }
      if (masterColumns.body_text) {
        insertRow.body_text = 'Set up your customer account: {{invite_link}} (expires {{expires_at}}).';
      }
      // Some installs have language-specific master columns from migration 075.
      if (masterColumns.subject_en) insertRow.subject_en = insertRow.subject || 'You\'ve been invited to access your photo galleries';
      if (masterColumns.body_html_en) insertRow.body_html_en = insertRow.body_html || '';
      if (masterColumns.body_text_en) insertRow.body_text_en = insertRow.body_text || '';

      const [insertedId] = await knex('email_templates').insert(insertRow).returning('id');
      templateId = insertedId?.id || insertedId;
    }

    if (templateId && await knex.schema.hasTable('email_template_translations')) {
      const transColumns = await knex('email_template_translations').columnInfo();
      const buildTranslationRow = (language, subject, bodyHtml, bodyText) => {
        const row = { template_id: templateId, language };
        if (transColumns.subject) row.subject = subject;
        if (transColumns.body_html) row.body_html = bodyHtml;
        if (transColumns.body_text) row.body_text = bodyText;
        if (transColumns.created_at) row.created_at = new Date();
        if (transColumns.updated_at) row.updated_at = new Date();
        return row;
      };

      // The button uses the wrapper's `.button` class instead of inline
      // styles, which inherits the admin-configured `email_primary_color`
      // (Settings → Branding → Email palette). Inline `background-color`
      // would override it and lock the button to the legacy green
      // regardless of branding — that's the bug shipped on the very
      // first cut of this template.
      const en = buildTranslationRow(
        'en',
        'You\'ve been invited to access your photo galleries',
        `
<h2>Welcome to your photo galleries</h2>
<p>You've been invited to create a customer account so you can view all of your event galleries in one place — no more juggling separate links and passwords.</p>
<div style="text-align: center; margin: 30px 0;">
  <a href="{{invite_link}}" class="button">Set up your account</a>
</div>
<p>This invitation expires on {{expires_at}}. If the link doesn't work, copy and paste it into your browser:</p>
<p style="word-break: break-all; font-size: 13px; color: #666;">{{invite_link}}</p>
<p>If you weren't expecting this email, you can safely ignore it.</p>`,
        `Welcome to your photo galleries

You've been invited to create a customer account so you can view all of your event galleries in one place — no more juggling separate links and passwords.

Set up your account: {{invite_link}}

This invitation expires on {{expires_at}}.

If you weren't expecting this email, you can safely ignore it.`
      );

      const de = buildTranslationRow(
        'de',
        'Sie wurden eingeladen, auf Ihre Fotogalerien zuzugreifen',
        `
<h2>Willkommen bei Ihren Fotogalerien</h2>
<p>Sie wurden eingeladen, ein Kundenkonto anzulegen, damit Sie alle Ihre Eventgalerien an einem Ort einsehen können — ohne mehrere Links und Passwörter verwalten zu müssen.</p>
<div style="text-align: center; margin: 30px 0;">
  <a href="{{invite_link}}" class="button">Konto einrichten</a>
</div>
<p>Diese Einladung läuft am {{expires_at}} ab. Falls der Link nicht funktioniert, kopieren Sie ihn in Ihren Browser:</p>
<p style="word-break: break-all; font-size: 13px; color: #666;">{{invite_link}}</p>
<p>Wenn Sie diese E-Mail nicht erwartet haben, können Sie sie ignorieren.</p>`,
        `Willkommen bei Ihren Fotogalerien

Sie wurden eingeladen, ein Kundenkonto anzulegen, damit Sie alle Ihre Eventgalerien an einem Ort einsehen können — ohne mehrere Links und Passwörter verwalten zu müssen.

Konto einrichten: {{invite_link}}

Diese Einladung läuft am {{expires_at}} ab.

Wenn Sie diese E-Mail nicht erwartet haben, können Sie sie ignorieren.`
      );

      for (const row of [en, de]) {
        const exists = await knex('email_template_translations')
          .where({ template_id: templateId, language: row.language })
          .first();
        if (!exists) {
          await knex('email_template_translations').insert(row);
        }
      }
    }
  }
};

exports.down = async function(knex) {
  // Drop in reverse dependency order. Permissions / role grants are left
  // alone — they're idempotent on re-run and cleaning them on rollback
  // would require deleting role_permissions rows we may not own.
  await knex.schema.dropTableIfExists('event_customer_assignments');
  await knex.schema.dropTableIfExists('customer_invitations');
  await knex.schema.dropTableIfExists('customer_accounts');

  // Best-effort cleanup of the three customers.* permissions if no other
  // code path inserted them. role_permissions rows cascade via FK.
  await knex('permissions').whereIn('name', [
    'customers.view',
    'customers.create',
    'customers.delete',
  ]).del();
};
