exports.up = async function(knex) {
  // Add default welcome message to app_settings
  const existingSetting = await knex('app_settings')
    .where('setting_key', 'general_default_welcome_message')
    .first();
  
  if (!existingSetting) {
    await knex('app_settings').insert({
      setting_key: 'general_default_welcome_message',
      setting_value: JSON.stringify('Thank you for using our photo sharing service! We hope you enjoy your photos.'),
      setting_type: 'general'
    });
  }

  // Update the gallery_created email template to ensure it has the welcome_message placeholder
  await knex('email_templates')
    .where('template_key', 'gallery_created')
    .update({
      body_html_en: `<h2>Gallery Successfully Created</h2>
<p>Dear {{host_name}},</p>
<p>Your photo gallery "{{event_name}}" has been successfully created!</p>
{{#if welcome_message}}
<div style="background-color: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
  <p style="margin: 0 0 10px 0; font-weight: 600; color: #374151;">Personal Message:</p>
  <p style="margin: 0; color: #4b5563;">{{welcome_message}}</p>
</div>
{{/if}}
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
{{#if welcome_message}}
<div style="background-color: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
  <p style="margin: 0 0 10px 0; font-weight: 600; color: #374151;">Persönliche Nachricht:</p>
  <p style="margin: 0; color: #4b5563;">{{welcome_message}}</p>
</div>
{{/if}}
<p><strong>Galerie-Details:</strong></p>
<ul>
  <li>Veranstaltungsdatum: {{event_date}}</li>
  <li>Galerie-Link: <a href="{{gallery_link}}" style="color: #5C8762; text-decoration: none;">{{gallery_link}}</a></li>
  <li>Passwort: {{gallery_password}}</li>
  <li>Gültig bis: {{expiry_date}}</li>
</ul>
<p>Teilen Sie diesen Link und das Passwort mit Ihren Gästen, damit sie Fotos ansehen und herunterladen können.</p>
<p><a href="{{gallery_link}}" style="display: inline-block; padding: 10px 20px; background-color: #5C8762; color: white; text-decoration: none; border-radius: 5px;">Galerie anzeigen</a></p>`,
      body_text_en: `Gallery Successfully Created

Dear {{host_name}},

Your photo gallery "{{event_name}}" has been successfully created!

{{#if welcome_message}}
Personal Message:
{{welcome_message}}

{{/if}}
Gallery Details:
- Event Date: {{event_date}}
- Gallery Link: {{gallery_link}}
- Password: {{gallery_password}}
- Valid Until: {{expiry_date}}

Share this link and password with your guests so they can view and download photos.`,
      body_text_de: `Galerie erfolgreich erstellt

Liebe(r) {{host_name}},

Ihre Fotogalerie "{{event_name}}" wurde erfolgreich erstellt!

{{#if welcome_message}}
Persönliche Nachricht:
{{welcome_message}}

{{/if}}
Galerie-Details:
- Veranstaltungsdatum: {{event_date}}
- Galerie-Link: {{gallery_link}}
- Passwort: {{gallery_password}}
- Gültig bis: {{expiry_date}}

Teilen Sie diesen Link und das Passwort mit Ihren Gästen, damit sie Fotos ansehen und herunterladen können.`
    });
};

exports.down = async function(knex) {
  // Remove the default welcome message setting
  await knex('app_settings')
    .where('setting_key', 'general_default_welcome_message')
    .del();

  // Revert email templates
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
};