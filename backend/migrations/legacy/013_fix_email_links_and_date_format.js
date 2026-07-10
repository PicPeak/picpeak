exports.up = async function(knex) {
  // First, add date format configuration to app_settings table
  const dateFormatSetting = await knex('app_settings').where('setting_key', 'general_date_format').first();
  if (!dateFormatSetting) {
    await knex('app_settings').insert({
      setting_key: 'general_date_format',
      setting_value: JSON.stringify({
        format: 'DD/MM/YYYY',  // European format as default
        locale: 'en-GB'
      }),
      setting_type: 'general',
      updated_at: new Date()
    });
  }

  // Update English email templates to use proper HTML links
  await knex('email_templates')
    .where('template_key', 'gallery_created')
    .update({
      body_html_en: `<h2>Gallery Successfully Created</h2>
<p>Dear {{host_name}},</p>
<p>Your photo gallery "{{event_name}}" has been successfully created!</p>
<p><strong>Gallery Details:</strong></p>
<ul>
  <li>Event Date: {{event_date}}</li>
  <li>Gallery Link: <a href="{{gallery_link}}" style="color: #5C8762; text-decoration: none;">{{gallery_link}}</a></li>
  <li>Password: {{gallery_password}}</li>
  <li>Valid Until: {{expiry_date}}</li>
</ul>
<p>Share this link and password with your guests so they can view and download photos.</p>
<p><a href="{{gallery_link}}" style="display: inline-block; padding: 10px 20px; background-color: #5C8762; color: white; text-decoration: none; border-radius: 5px;">View Gallery</a></p>`,
      body_html_de: `<h2>Galerie erfolgreich erstellt</h2>
<p>Liebe(r) {{host_name}},</p>
<p>Ihre Fotogalerie "{{event_name}}" wurde erfolgreich erstellt!</p>
<p><strong>Galerie-Details:</strong></p>
<ul>
  <li>Veranstaltungsdatum: {{event_date}}</li>
  <li>Galerie-Link: <a href="{{gallery_link}}" style="color: #5C8762; text-decoration: none;">{{gallery_link}}</a></li>
  <li>Passwort: {{gallery_password}}</li>
  <li>Gültig bis: {{expiry_date}}</li>
</ul>
<p>Teilen Sie diesen Link und das Passwort mit Ihren Gästen, damit sie Fotos ansehen und herunterladen können.</p>
<p><a href="{{gallery_link}}" style="display: inline-block; padding: 10px 20px; background-color: #5C8762; color: white; text-decoration: none; border-radius: 5px;">Galerie anzeigen</a></p>`
    });

  // Update expiration warning template
  await knex('email_templates')
    .where('template_key', 'expiration_warning')
    .update({
      body_html_en: `<h2>Gallery Expiring Soon</h2>
<p>Dear {{host_name}},</p>
<p>Your photo gallery "{{event_name}}" will expire in {{days_remaining}} days.</p>
<p>After expiration, the gallery will be archived and no longer accessible to guests.</p>
<p><a href="{{gallery_link}}" style="display: inline-block; padding: 10px 20px; background-color: #5C8762; color: white; text-decoration: none; border-radius: 5px;">Visit Gallery</a></p>
<p>Gallery Link: <a href="{{gallery_link}}" style="color: #5C8762;">{{gallery_link}}</a></p>`,
      body_html_de: `<h2>Galerie läuft bald ab</h2>
<p>Liebe(r) {{host_name}},</p>
<p>Ihre Fotogalerie "{{event_name}}" läuft in {{days_remaining}} Tagen ab.</p>
<p>Nach Ablauf wird die Galerie archiviert und ist für Gäste nicht mehr zugänglich.</p>
<p><a href="{{gallery_link}}" style="display: inline-block; padding: 10px 20px; background-color: #5C8762; color: white; text-decoration: none; border-radius: 5px;">Galerie besuchen</a></p>
<p>Galerie-Link: <a href="{{gallery_link}}" style="color: #5C8762;">{{gallery_link}}</a></p>`
    });

  // Update gallery expired template
  await knex('email_templates')
    .where('template_key', 'gallery_expired')
    .update({
      body_html_en: `<h2>Gallery Expired</h2>
<p>Your photo gallery for "{{event_name}}" has expired and is no longer accessible.</p>
<p>The photos have been safely archived. If you need access again, please contact the administrator at <a href="mailto:{{admin_email}}" style="color: #5C8762;">{{admin_email}}</a>.</p>
<p>Thank you for using our photo sharing service!</p>
<p>Best regards,<br>The Photo Sharing Team</p>`,
      body_html_de: `<h2>Galerie abgelaufen</h2>
<p>Ihre Fotogalerie für "{{event_name}}" ist abgelaufen und nicht mehr zugänglich.</p>
<p>Die Fotos wurden zur sicheren Aufbewahrung archiviert. Wenn Sie wieder Zugriff benötigen, wenden Sie sich bitte an den Administrator unter <a href="mailto:{{admin_email}}" style="color: #5C8762;">{{admin_email}}</a>.</p>
<p>Vielen Dank für die Nutzung unseres Foto-Sharing-Services!</p>
<p>Mit freundlichen Grüßen,<br>Das Foto-Sharing-Team</p>`
    });
};

exports.down = async function(knex) {
  // Remove date format setting
  await knex('app_settings').where('setting_key', 'general_date_format').del();
  
  // Revert email templates to plain text links
  await knex('email_templates')
    .where('template_key', 'gallery_created')
    .update({
      body_html_en: `<h2>Gallery Successfully Created</h2>
<p>Dear {{host_name}},</p>
<p>Your photo gallery "{{event_name}}" has been successfully created!</p>
<p><strong>Gallery Details:</strong></p>
<ul>
  <li>Event Date: {{event_date}}</li>
  <li>Gallery Link: {{gallery_link}}</li>
  <li>Password: {{gallery_password}}</li>
  <li>Valid Until: {{expiry_date}}</li>
</ul>
<p>Share this link and password with your guests so they can view and download photos.</p>`,
      body_html_de: `<h2>Galerie erfolgreich erstellt</h2>
<p>Liebe(r) {{host_name}},</p>
<p>Ihre Fotogalerie "{{event_name}}" wurde erfolgreich erstellt!</p>
<p><strong>Galerie-Details:</strong></p>
<ul>
  <li>Veranstaltungsdatum: {{event_date}}</li>
  <li>Galerie-Link: {{gallery_link}}</li>
  <li>Passwort: {{gallery_password}}</li>
  <li>Gültig bis: {{expiry_date}}</li>
</ul>
<p>Teilen Sie diesen Link und das Passwort mit Ihren Gästen, damit sie Fotos ansehen und herunterladen können.</p>`
    });
};