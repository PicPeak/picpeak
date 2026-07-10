/**
 * Migration 070: Add update notification settings and email template
 * - Settings for email notifications when new versions are available
 * - Email template for version update notifications
 */

exports.up = async function(knex) {
  console.log('Running migration: 070_add_update_notification_settings');

  // Add app_settings for update notifications
  const settings = [
    {
      setting_key: 'update_email_notifications_enabled',
      setting_value: JSON.stringify(false),
      setting_type: 'notifications'
    },
    {
      setting_key: 'update_email_recipients',
      setting_value: JSON.stringify(''), // Comma-separated emails, or empty for all admin emails
      setting_type: 'notifications'
    },
    {
      setting_key: 'last_notified_version',
      setting_value: JSON.stringify(''),
      setting_type: 'notifications'
    }
  ];

  for (const setting of settings) {
    const exists = await knex('app_settings').where('setting_key', setting.setting_key).first();
    if (!exists) {
      await knex('app_settings').insert({ ...setting, updated_at: knex.fn.now() });
    }
  }

  // Check if email template already exists
  const existingTemplate = await knex('email_templates')
    .where('template_key', 'version_update_available')
    .first();

  if (!existingTemplate) {
    await knex('email_templates').insert({
      template_key: 'version_update_available',
      subject_en: 'PicPeak Update Available: Version {{new_version}}',
      subject_de: 'PicPeak Update verfugbar: Version {{new_version}}',
      body_html_en: `
<h2>A New Version of PicPeak is Available</h2>

<p>Great news! A new version of PicPeak is available for your installation.</p>

<div style="background-color: #f0f8ff; border-left: 4px solid #5C8762; padding: 20px; margin: 20px 0; border-radius: 4px;">
  <p style="margin: 0;"><strong>Current Version:</strong> {{current_version}}</p>
  <p style="margin: 10px 0 0 0;"><strong>New Version:</strong> {{new_version}}</p>
  <p style="margin: 10px 0 0 0;"><strong>Channel:</strong> {{channel}}</p>
</div>

<h3>What's New?</h3>
<p>Check the release notes to see what's included in this update:</p>

<div style="text-align: center; margin: 30px 0;">
  <a href="{{release_notes_url}}" style="display: inline-block; padding: 14px 35px; background-color: #5C8762; color: white; text-decoration: none; border-radius: 5px; font-weight: 600; font-size: 16px;">View Release Notes</a>
</div>

<h3>How to Update</h3>
<p>To update your installation, log in to the admin panel and click on the "Update Available" notification. You'll find environment-specific instructions there.</p>

<div style="background-color: #fff3cd; border: 1px solid #ffeaa7; color: #856404; padding: 15px; border-radius: 4px; margin: 20px 0;">
  <p style="margin: 0;"><strong>Reminder:</strong> Always backup your database before updating to ensure you can recover if anything goes wrong.</p>
</div>

<p>Best regards,<br>
Your PicPeak Installation</p>`,
      body_text_en: `A New Version of PicPeak is Available

Great news! A new version of PicPeak is available for your installation.

Current Version: {{current_version}}
New Version: {{new_version}}
Channel: {{channel}}

What's New?
Check the release notes to see what's included in this update:
{{release_notes_url}}

How to Update
To update your installation, log in to the admin panel and click on the "Update Available" notification. You'll find environment-specific instructions there.

REMINDER: Always backup your database before updating to ensure you can recover if anything goes wrong.

Best regards,
Your PicPeak Installation`,
      body_html_de: `
<h2>Eine neue Version von PicPeak ist verfugbar</h2>

<p>Gute Neuigkeiten! Eine neue Version von PicPeak ist fur Ihre Installation verfugbar.</p>

<div style="background-color: #f0f8ff; border-left: 4px solid #5C8762; padding: 20px; margin: 20px 0; border-radius: 4px;">
  <p style="margin: 0;"><strong>Aktuelle Version:</strong> {{current_version}}</p>
  <p style="margin: 10px 0 0 0;"><strong>Neue Version:</strong> {{new_version}}</p>
  <p style="margin: 10px 0 0 0;"><strong>Kanal:</strong> {{channel}}</p>
</div>

<h3>Was ist neu?</h3>
<p>Schauen Sie sich die Versionshinweise an, um zu sehen, was in diesem Update enthalten ist:</p>

<div style="text-align: center; margin: 30px 0;">
  <a href="{{release_notes_url}}" style="display: inline-block; padding: 14px 35px; background-color: #5C8762; color: white; text-decoration: none; border-radius: 5px; font-weight: 600; font-size: 16px;">Versionshinweise anzeigen</a>
</div>

<h3>So aktualisieren Sie</h3>
<p>Um Ihre Installation zu aktualisieren, melden Sie sich im Admin-Panel an und klicken Sie auf die Benachrichtigung "Update verfugbar". Dort finden Sie umgebungsspezifische Anweisungen.</p>

<div style="background-color: #fff3cd; border: 1px solid #ffeaa7; color: #856404; padding: 15px; border-radius: 4px; margin: 20px 0;">
  <p style="margin: 0;"><strong>Erinnerung:</strong> Erstellen Sie immer ein Backup Ihrer Datenbank, bevor Sie aktualisieren, um sicherzustellen, dass Sie im Fehlerfall wiederherstellen konnen.</p>
</div>

<p>Mit freundlichen Grussen,<br>
Ihre PicPeak-Installation</p>`,
      body_text_de: `Eine neue Version von PicPeak ist verfugbar

Gute Neuigkeiten! Eine neue Version von PicPeak ist fur Ihre Installation verfugbar.

Aktuelle Version: {{current_version}}
Neue Version: {{new_version}}
Kanal: {{channel}}

Was ist neu?
Schauen Sie sich die Versionshinweise an, um zu sehen, was in diesem Update enthalten ist:
{{release_notes_url}}

So aktualisieren Sie
Um Ihre Installation zu aktualisieren, melden Sie sich im Admin-Panel an und klicken Sie auf die Benachrichtigung "Update verfugbar". Dort finden Sie umgebungsspezifische Anweisungen.

ERINNERUNG: Erstellen Sie immer ein Backup Ihrer Datenbank, bevor Sie aktualisieren, um sicherzustellen, dass Sie im Fehlerfall wiederherstellen konnen.

Mit freundlichen Grussen,
Ihre PicPeak-Installation`,
      variables: JSON.stringify(['current_version', 'new_version', 'channel', 'release_notes_url'])
    });
  }

  console.log('Migration 070_add_update_notification_settings completed');
};

exports.down = async function(knex) {
  console.log('Rollback: 070_add_update_notification_settings');

  // Remove settings
  await knex('app_settings')
    .whereIn('setting_key', [
      'update_email_notifications_enabled',
      'update_email_recipients',
      'last_notified_version'
    ])
    .del();

  // Remove email template
  await knex('email_templates')
    .where('template_key', 'version_update_available')
    .del();
};
