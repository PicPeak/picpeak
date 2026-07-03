/**
 * Migration to add email templates for admin invitation and password reset
 * These templates support the RBAC (Role-Based Access Control) feature
 */
exports.up = async function(knex) {
  // First, ensure the email_templates table has multilingual columns
  // This is needed for fresh installations where legacy migrations don't run
  const columnInfo = await knex('email_templates').columnInfo();

  if (!columnInfo.subject_en) {
    // Need to add multilingual columns
    console.log('Adding multilingual columns to email_templates table...');

    // Check if we're using SQLite or PostgreSQL
    const client = knex.client.config.client;
    const isSqlite = client === 'sqlite3' || client === 'better-sqlite3';

    if (isSqlite) {
      // SQLite doesn't support column rename directly in all versions
      // We need to recreate the table with new structure

      // Get existing data
      const existingData = await knex('email_templates').select('*');

      // Drop the old table
      await knex.schema.dropTable('email_templates');

      // Create new table with multilingual columns
      await knex.schema.createTable('email_templates', (table) => {
        table.increments('id').primary();
        table.string('template_key').unique().notNullable();
        table.string('subject_en');
        table.string('subject_de');
        table.text('body_html_en');
        table.text('body_html_de');
        table.text('body_text_en');
        table.text('body_text_de');
        table.json('variables');
        table.datetime('updated_at').defaultTo(knex.fn.now());
      });

      // Re-insert existing data with column mapping
      for (const row of existingData) {
        await knex('email_templates').insert({
          template_key: row.template_key,
          subject_en: row.subject,
          subject_de: row.subject, // Copy to German as default
          body_html_en: row.body_html,
          body_html_de: row.body_html,
          body_text_en: row.body_text,
          body_text_de: row.body_text,
          variables: row.variables,
          updated_at: row.updated_at
        });
      }

      console.log('Migrated email_templates table to multilingual structure');
    } else {
      // PostgreSQL supports ALTER TABLE for column operations
      await knex.schema.alterTable('email_templates', (table) => {
        table.renameColumn('subject', 'subject_en');
        table.renameColumn('body_html', 'body_html_en');
        table.renameColumn('body_text', 'body_text_en');
      });

      await knex.schema.alterTable('email_templates', (table) => {
        table.string('subject_de');
        table.text('body_html_de');
        table.text('body_text_de');
      });

      // Copy English values to German as defaults
      await knex('email_templates').update({
        subject_de: knex.raw('subject_en'),
        body_html_de: knex.raw('body_html_en'),
        body_text_de: knex.raw('body_text_en')
      });
    }
  }

  // Check which templates already exist
  const existingTemplates = await knex('email_templates')
    .select('template_key')
    .whereIn('template_key', ['admin_invitation', 'admin_password_reset']);

  const existingKeys = existingTemplates.map(t => t.template_key);

  // Admin Invitation Email Template
  if (!existingKeys.includes('admin_invitation')) {
    await knex('email_templates').insert({
      template_key: 'admin_invitation',
      subject_en: 'You have been invited to join PicPeak as {{role_name}}',
      subject_de: 'Sie wurden eingeladen, PicPeak als {{role_name}} beizutreten',
      body_html_en: `
<h2>Welcome to PicPeak!</h2>

<p>You have been invited to join the PicPeak photo sharing platform as a <strong>{{role_name}}</strong>.</p>

<div style="background-color: #f0f8ff; border-left: 4px solid #5C8762; padding: 20px; margin: 20px 0; border-radius: 4px;">
  <p style="margin: 0;"><strong>Your Role:</strong> {{role_name}}</p>
  <p style="margin: 10px 0 0 0;">This role grants you access to manage and administer the photo sharing platform.</p>
</div>

<p>To accept this invitation and set up your account, click the button below:</p>

<div style="text-align: center; margin: 30px 0;">
  <a href="{{invite_link}}" style="display: inline-block; padding: 14px 35px; background-color: #5C8762; color: white; text-decoration: none; border-radius: 5px; font-weight: 600; font-size: 16px;">Accept Invitation</a>
</div>

<div style="background-color: #fff3cd; border: 1px solid #ffeaa7; color: #856404; padding: 15px; border-radius: 4px; margin: 20px 0;">
  <p style="margin: 0;"><strong>Important:</strong> This invitation expires on <strong>{{expires_at}}</strong>. Please accept the invitation before this date.</p>
</div>

<p>If you did not expect this invitation or believe it was sent in error, you can safely ignore this email.</p>

<p style="color: #666; font-size: 13px; margin-top: 30px;">
  If the button above does not work, copy and paste this link into your browser:<br>
  <a href="{{invite_link}}" style="color: #5C8762; word-break: break-all;">{{invite_link}}</a>
</p>

<p>Best regards,<br>
The PicPeak Team</p>`,
      body_text_en: `Welcome to PicPeak!

You have been invited to join the PicPeak photo sharing platform as a {{role_name}}.

Your Role: {{role_name}}
This role grants you access to manage and administer the photo sharing platform.

To accept this invitation and set up your account, visit the following link:
{{invite_link}}

IMPORTANT: This invitation expires on {{expires_at}}. Please accept the invitation before this date.

If you did not expect this invitation or believe it was sent in error, you can safely ignore this email.

Best regards,
The PicPeak Team`,
      body_html_de: `
<h2>Willkommen bei PicPeak!</h2>

<p>Sie wurden eingeladen, der PicPeak Foto-Sharing-Plattform als <strong>{{role_name}}</strong> beizutreten.</p>

<div style="background-color: #f0f8ff; border-left: 4px solid #5C8762; padding: 20px; margin: 20px 0; border-radius: 4px;">
  <p style="margin: 0;"><strong>Ihre Rolle:</strong> {{role_name}}</p>
  <p style="margin: 10px 0 0 0;">Diese Rolle gewahrt Ihnen Zugang zur Verwaltung und Administration der Foto-Sharing-Plattform.</p>
</div>

<p>Um diese Einladung anzunehmen und Ihr Konto einzurichten, klicken Sie auf die Schaltflache unten:</p>

<div style="text-align: center; margin: 30px 0;">
  <a href="{{invite_link}}" style="display: inline-block; padding: 14px 35px; background-color: #5C8762; color: white; text-decoration: none; border-radius: 5px; font-weight: 600; font-size: 16px;">Einladung annehmen</a>
</div>

<div style="background-color: #fff3cd; border: 1px solid #ffeaa7; color: #856404; padding: 15px; border-radius: 4px; margin: 20px 0;">
  <p style="margin: 0;"><strong>Wichtig:</strong> Diese Einladung lauft am <strong>{{expires_at}}</strong> ab. Bitte nehmen Sie die Einladung vor diesem Datum an.</p>
</div>

<p>Wenn Sie diese Einladung nicht erwartet haben oder glauben, dass sie irrtumlicherweise gesendet wurde, konnen Sie diese E-Mail ignorieren.</p>

<p style="color: #666; font-size: 13px; margin-top: 30px;">
  Wenn die Schaltflache oben nicht funktioniert, kopieren Sie diesen Link in Ihren Browser:<br>
  <a href="{{invite_link}}" style="color: #5C8762; word-break: break-all;">{{invite_link}}</a>
</p>

<p>Mit freundlichen Grussen,<br>
Ihr PicPeak-Team</p>`,
      body_text_de: `Willkommen bei PicPeak!

Sie wurden eingeladen, der PicPeak Foto-Sharing-Plattform als {{role_name}} beizutreten.

Ihre Rolle: {{role_name}}
Diese Rolle gewahrt Ihnen Zugang zur Verwaltung und Administration der Foto-Sharing-Plattform.

Um diese Einladung anzunehmen und Ihr Konto einzurichten, besuchen Sie den folgenden Link:
{{invite_link}}

WICHTIG: Diese Einladung lauft am {{expires_at}} ab. Bitte nehmen Sie die Einladung vor diesem Datum an.

Wenn Sie diese Einladung nicht erwartet haben oder glauben, dass sie irrtumlicherweise gesendet wurde, konnen Sie diese E-Mail ignorieren.

Mit freundlichen Grussen,
Ihr PicPeak-Team`,
      variables: JSON.stringify(['invite_link', 'role_name', 'expires_at'])
    });
  }

  // Admin Password Reset Email Template
  if (!existingKeys.includes('admin_password_reset')) {
    await knex('email_templates').insert({
      template_key: 'admin_password_reset',
      subject_en: 'Your PicPeak administrator password has been reset',
      subject_de: 'Ihr PicPeak-Administratorpasswort wurde zuruckgesetzt',
      body_html_en: `
<h2>Password Reset Notification</h2>

<p>Hello <strong>{{username}}</strong>,</p>

<p>Your administrator password for PicPeak has been reset by a system administrator.</p>

<div style="background-color: #f9f9f9; padding: 20px; border-radius: 8px; margin: 20px 0;">
  <h3 style="margin-top: 0;">Your New Login Credentials:</h3>
  <ul style="list-style: none; padding: 0;">
    <li style="margin-bottom: 10px;"><strong>Username:</strong> {{username}}</li>
    <li style="margin-bottom: 10px;"><strong>Temporary Password:</strong> <code style="background-color: #e9ecef; padding: 4px 8px; border-radius: 4px; font-family: monospace; font-size: 14px;">{{new_password}}</code></li>
  </ul>
</div>

<div style="background-color: #fee; border: 1px solid #fcc; color: #c33; padding: 20px; border-radius: 8px; margin: 20px 0;">
  <p style="margin: 0; font-weight: bold; font-size: 16px;">Security Notice</p>
  <ul style="margin: 10px 0 0 0; padding-left: 20px;">
    <li>This is a temporary password. Please change it immediately after logging in.</li>
    <li>Never share your password with anyone.</li>
    <li>If you did not request this password reset, please contact your system administrator immediately.</li>
  </ul>
</div>

<p>To log in to the admin panel, click the button below:</p>

<div style="text-align: center; margin: 30px 0;">
  <a href="{{admin_login_url}}" style="display: inline-block; padding: 14px 35px; background-color: #5C8762; color: white; text-decoration: none; border-radius: 5px; font-weight: 600; font-size: 16px;">Log In Now</a>
</div>

<p style="color: #666; font-size: 13px;">After logging in, navigate to your profile settings to change your password to something secure that only you know.</p>

<p>Best regards,<br>
The PicPeak Team</p>`,
      body_text_en: `Password Reset Notification

Hello {{username}},

Your administrator password for PicPeak has been reset by a system administrator.

Your New Login Credentials:
- Username: {{username}}
- Temporary Password: {{new_password}}

SECURITY NOTICE:
- This is a temporary password. Please change it immediately after logging in.
- Never share your password with anyone.
- If you did not request this password reset, please contact your system administrator immediately.

To log in to the admin panel, visit: {{admin_login_url}}

After logging in, navigate to your profile settings to change your password to something secure that only you know.

Best regards,
The PicPeak Team`,
      body_html_de: `
<h2>Benachrichtigung uber Passwortzurucksetzung</h2>

<p>Hallo <strong>{{username}}</strong>,</p>

<p>Ihr Administratorpasswort fur PicPeak wurde von einem Systemadministrator zuruckgesetzt.</p>

<div style="background-color: #f9f9f9; padding: 20px; border-radius: 8px; margin: 20px 0;">
  <h3 style="margin-top: 0;">Ihre neuen Anmeldedaten:</h3>
  <ul style="list-style: none; padding: 0;">
    <li style="margin-bottom: 10px;"><strong>Benutzername:</strong> {{username}}</li>
    <li style="margin-bottom: 10px;"><strong>Vorlaufiges Passwort:</strong> <code style="background-color: #e9ecef; padding: 4px 8px; border-radius: 4px; font-family: monospace; font-size: 14px;">{{new_password}}</code></li>
  </ul>
</div>

<div style="background-color: #fee; border: 1px solid #fcc; color: #c33; padding: 20px; border-radius: 8px; margin: 20px 0;">
  <p style="margin: 0; font-weight: bold; font-size: 16px;">Sicherheitshinweis</p>
  <ul style="margin: 10px 0 0 0; padding-left: 20px;">
    <li>Dies ist ein vorlaufiges Passwort. Bitte andern Sie es sofort nach der Anmeldung.</li>
    <li>Teilen Sie Ihr Passwort niemals mit anderen.</li>
    <li>Wenn Sie diese Passwortzurucksetzung nicht angefordert haben, wenden Sie sich bitte umgehend an Ihren Systemadministrator.</li>
  </ul>
</div>

<p>Um sich im Admin-Panel anzumelden, klicken Sie auf die Schaltflache unten:</p>

<div style="text-align: center; margin: 30px 0;">
  <a href="{{admin_login_url}}" style="display: inline-block; padding: 14px 35px; background-color: #5C8762; color: white; text-decoration: none; border-radius: 5px; font-weight: 600; font-size: 16px;">Jetzt anmelden</a>
</div>

<p style="color: #666; font-size: 13px;">Nach der Anmeldung navigieren Sie zu Ihren Profileinstellungen, um Ihr Passwort in ein sicheres Passwort zu andern, das nur Sie kennen.</p>

<p>Mit freundlichen Grussen,<br>
Ihr PicPeak-Team</p>`,
      body_text_de: `Benachrichtigung uber Passwortzurucksetzung

Hallo {{username}},

Ihr Administratorpasswort fur PicPeak wurde von einem Systemadministrator zuruckgesetzt.

Ihre neuen Anmeldedaten:
- Benutzername: {{username}}
- Vorlaufiges Passwort: {{new_password}}

SICHERHEITSHINWEIS:
- Dies ist ein vorlaufiges Passwort. Bitte andern Sie es sofort nach der Anmeldung.
- Teilen Sie Ihr Passwort niemals mit anderen.
- Wenn Sie diese Passwortzurucksetzung nicht angefordert haben, wenden Sie sich bitte umgehend an Ihren Systemadministrator.

Um sich im Admin-Panel anzumelden, besuchen Sie: {{admin_login_url}}

Nach der Anmeldung navigieren Sie zu Ihren Profileinstellungen, um Ihr Passwort in ein sicheres Passwort zu andern, das nur Sie kennen.

Mit freundlichen Grussen,
Ihr PicPeak-Team`,
      variables: JSON.stringify(['username', 'new_password', 'admin_login_url'])
    });
  }
};

exports.down = async function(knex) {
  // Remove the admin email templates
  await knex('email_templates')
    .whereIn('template_key', ['admin_invitation', 'admin_password_reset'])
    .delete();
};
