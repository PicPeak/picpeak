/**
 * Migration 087: Add a dedicated email template for the admin "Send Test
 * Email" button on the Update Notifications settings page (#418).
 *
 * Previously the button reused the version_update_available template via
 * sendUpdateNotificationNow(), which bailed out early when no real update
 * was pending — so admins on the latest version had no way to verify
 * their SMTP / recipient list config worked.
 *
 * The test template makes the intent unambiguous in the inbox ("This is
 * a test of your update-notification setup, no action needed") and lets
 * the send code run unconditionally regardless of update availability.
 *
 * Languages: EN + DE only, matching the convention of the existing
 * version_update_available template (070). The email_templates table
 * doesn't have nl/pt/ru columns; sendTemplateEmail falls back to EN.
 */

exports.up = async function(knex) {
  console.log('Running migration: 087_add_update_notification_test_template');

  const existing = await knex('email_templates')
    .where('template_key', 'version_update_test')
    .first();

  if (existing) {
    console.log('  version_update_test template already exists, skipping insert');
    return;
  }

  await knex('email_templates').insert({
    template_key: 'version_update_test',
    subject_en: '[TEST] PicPeak Update Notification — configuration check',
    subject_de: '[TEST] PicPeak Update-Benachrichtigung — Konfigurationsprüfung',
    body_html_en: `
<h2>This is a test email</h2>

<p>You are receiving this message because an administrator clicked
<strong>Send Test Email</strong> on the Update Notifications page of your
PicPeak installation.</p>

<div style="background-color: #f0f8ff; border-left: 4px solid #5C8762; padding: 20px; margin: 20px 0; border-radius: 4px;">
  <p style="margin: 0;"><strong>Installed version:</strong> {{current_version}}</p>
  <p style="margin: 10px 0 0 0;"><strong>Channel:</strong> {{channel}}</p>
  <p style="margin: 10px 0 0 0;"><strong>Recipient address:</strong> {{recipient_email}}</p>
</div>

<p>If you can read this email, your SMTP configuration and the recipient
list are working correctly. When a real new version becomes available,
PicPeak will send a separate notification with release notes and update
instructions.</p>

<p style="color: #666; font-size: 13px; margin-top: 30px;">No action is required.
You may safely delete this message.</p>

<p>Best regards,<br>
Your PicPeak Installation</p>`,
    body_text_en: `This is a test email

You are receiving this message because an administrator clicked
"Send Test Email" on the Update Notifications page of your PicPeak
installation.

Installed version: {{current_version}}
Channel: {{channel}}
Recipient address: {{recipient_email}}

If you can read this email, your SMTP configuration and the recipient
list are working correctly. When a real new version becomes available,
PicPeak will send a separate notification with release notes and update
instructions.

No action is required. You may safely delete this message.

Best regards,
Your PicPeak Installation`,
    body_html_de: `
<h2>Dies ist eine Test-E-Mail</h2>

<p>Sie erhalten diese Nachricht, weil ein Administrator auf der Seite
"Update-Benachrichtigungen" Ihrer PicPeak-Installation auf
<strong>Test-E-Mail senden</strong> geklickt hat.</p>

<div style="background-color: #f0f8ff; border-left: 4px solid #5C8762; padding: 20px; margin: 20px 0; border-radius: 4px;">
  <p style="margin: 0;"><strong>Installierte Version:</strong> {{current_version}}</p>
  <p style="margin: 10px 0 0 0;"><strong>Kanal:</strong> {{channel}}</p>
  <p style="margin: 10px 0 0 0;"><strong>Empfänger-Adresse:</strong> {{recipient_email}}</p>
</div>

<p>Wenn Sie diese E-Mail lesen können, funktionieren Ihre SMTP-Konfiguration
und die Empfängerliste korrekt. Sobald eine echte neue Version verfügbar
ist, sendet PicPeak eine separate Benachrichtigung mit Versionshinweisen
und Update-Anweisungen.</p>

<p style="color: #666; font-size: 13px; margin-top: 30px;">Es ist keine Aktion
erforderlich. Sie können diese Nachricht gefahrlos löschen.</p>

<p>Mit freundlichen Grüßen,<br>
Ihre PicPeak-Installation</p>`,
    body_text_de: `Dies ist eine Test-E-Mail

Sie erhalten diese Nachricht, weil ein Administrator auf der Seite
"Update-Benachrichtigungen" Ihrer PicPeak-Installation auf
"Test-E-Mail senden" geklickt hat.

Installierte Version: {{current_version}}
Kanal: {{channel}}
Empfänger-Adresse: {{recipient_email}}

Wenn Sie diese E-Mail lesen können, funktionieren Ihre SMTP-Konfiguration
und die Empfängerliste korrekt. Sobald eine echte neue Version verfügbar
ist, sendet PicPeak eine separate Benachrichtigung mit Versionshinweisen
und Update-Anweisungen.

Es ist keine Aktion erforderlich. Sie können diese Nachricht gefahrlos löschen.

Mit freundlichen Grüßen,
Ihre PicPeak-Installation`,
    variables: JSON.stringify(['current_version', 'channel', 'recipient_email'])
  });

  console.log('Migration 087_add_update_notification_test_template completed');
};

exports.down = async function(knex) {
  console.log('Rollback: 087_add_update_notification_test_template');
  await knex('email_templates')
    .where('template_key', 'version_update_test')
    .del();
};
