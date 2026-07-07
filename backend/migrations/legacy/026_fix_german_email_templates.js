exports.up = async function(knex) {
  // Update gallery_created template with proper German translation
  await knex('email_templates')
    .where('template_key', 'gallery_created')
    .update({
      subject_de: 'Ihre Fotogalerie ist bereit!',
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
  <li>Galerie-Link: <a href="{{gallery_link}}" style="color: #5C8762;">{{gallery_link}}</a></li>
  <li>Passwort: {{gallery_password}}</li>
  <li>Ablaufdatum: {{expiry_date}}</li>
</ul>
<p>Teilen Sie diesen Link und das Passwort mit Ihren Gästen, damit diese die Fotos ansehen und herunterladen können.</p>
<p style="background-color: #FEF3C7; padding: 15px; border-radius: 5px; border-left: 4px solid #F59E0B;">
  <strong>Wichtig:</strong> Diese Galerie läuft am {{expiry_date}} ab. Nach diesem Datum werden die Fotos archiviert und sind nicht mehr zugänglich.
</p>
<a href="{{gallery_link}}" style="display: inline-block; padding: 12px 30px; background-color: #5C8762; color: white; text-decoration: none; border-radius: 5px; font-weight: 500; margin: 20px 0;">Galerie anzeigen</a>
<p>Mit freundlichen Grüßen,<br>Ihr Foto-Sharing-Team</p>`,
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
- Ablaufdatum: {{expiry_date}}

Teilen Sie diesen Link und das Passwort mit Ihren Gästen, damit diese die Fotos ansehen und herunterladen können.

WICHTIG: Diese Galerie läuft am {{expiry_date}} ab. Nach diesem Datum werden die Fotos archiviert und sind nicht mehr zugänglich.

Mit freundlichen Grüßen,
Ihr Foto-Sharing-Team`
    });

  // Update expiration_warning template with proper German translation
  await knex('email_templates')
    .where('template_key', 'expiration_warning')
    .update({
      subject_de: 'Ihre Fotogalerie läuft bald ab',
      body_html_de: `<h2>Galerie läuft bald ab</h2>
<p>Liebe(r) {{host_name}},</p>
<p>Ihre Fotogalerie "{{event_name}}" läuft in <strong>{{days_remaining}} Tagen</strong> ab.</p>
<p>Nach Ablauf wird die Galerie archiviert und ist für Gäste nicht mehr zugänglich. Bitte stellen Sie sicher, dass alle gewünschten Fotos heruntergeladen wurden.</p>
<p><strong>Ablaufdatum:</strong> {{expiry_date}}</p>
<a href="{{gallery_link}}" style="display: inline-block; padding: 12px 30px; background-color: #5C8762; color: white; text-decoration: none; border-radius: 5px; font-weight: 500; margin: 20px 0;">Galerie jetzt besuchen</a>
<p style="background-color: #FEE2E2; padding: 15px; border-radius: 5px; border-left: 4px solid #EF4444;">
  <strong>Erinnerung:</strong> Nach dem {{expiry_date}} können Ihre Gäste nicht mehr auf die Galerie zugreifen.
</p>
<p>Mit freundlichen Grüßen,<br>Ihr Foto-Sharing-Team</p>`,
      body_text_de: `Galerie läuft bald ab

Liebe(r) {{host_name}},

Ihre Fotogalerie "{{event_name}}" läuft in {{days_remaining}} Tagen ab.

Nach Ablauf wird die Galerie archiviert und ist für Gäste nicht mehr zugänglich. Bitte stellen Sie sicher, dass alle gewünschten Fotos heruntergeladen wurden.

Ablaufdatum: {{expiry_date}}

Galerie-Link: {{gallery_link}}

ERINNERUNG: Nach dem {{expiry_date}} können Ihre Gäste nicht mehr auf die Galerie zugreifen.

Mit freundlichen Grüßen,
Ihr Foto-Sharing-Team`
    });

  // Update gallery_expired template with proper German translation
  await knex('email_templates')
    .where('template_key', 'gallery_expired')
    .update({
      subject_de: 'Ihre Fotogalerie {{event_name}} ist abgelaufen',
      body_html_de: `<h2>Galerie abgelaufen</h2>
<p>Liebe(r) {{host_name}},</p>
<p>Ihre Fotogalerie "{{event_name}}" ist am {{expiry_date}} abgelaufen und wurde archiviert.</p>
<p>Die Galerie ist nicht mehr für Gäste zugänglich. Alle Fotos wurden sicher in unserem Archivsystem gespeichert.</p>
<p>Wenn Sie wieder Zugriff auf die archivierten Fotos benötigen, wenden Sie sich bitte an unseren Support:</p>
<p style="background-color: #F3F4F6; padding: 15px; border-radius: 5px;">
  <strong>Kontakt:</strong><br>
  E-Mail: <a href="mailto:{{admin_email}}" style="color: #5C8762;">{{admin_email}}</a><br>
  {{#if support_phone}}Telefon: {{support_phone}}{{/if}}
</p>
<p>Vielen Dank für die Nutzung unseres Foto-Sharing-Services!</p>
<p>Mit freundlichen Grüßen,<br>Ihr Foto-Sharing-Team</p>`,
      body_text_de: `Galerie abgelaufen

Liebe(r) {{host_name}},

Ihre Fotogalerie "{{event_name}}" ist am {{expiry_date}} abgelaufen und wurde archiviert.

Die Galerie ist nicht mehr für Gäste zugänglich. Alle Fotos wurden sicher in unserem Archivsystem gespeichert.

Wenn Sie wieder Zugriff auf die archivierten Fotos benötigen, wenden Sie sich bitte an unseren Support:

E-Mail: {{admin_email}}
{{#if support_phone}}Telefon: {{support_phone}}{{/if}}

Vielen Dank für die Nutzung unseres Foto-Sharing-Services!

Mit freundlichen Grüßen,
Ihr Foto-Sharing-Team`
    });

  // Update archive_complete template with proper German translation
  await knex('email_templates')
    .where('template_key', 'archive_complete')
    .update({
      subject_de: 'Archivierung abgeschlossen: {{event_name}}',
      body_html_de: `<h2>Archivierung abgeschlossen</h2>
<p>Liebe(r) {{host_name}},</p>
<p>Die Fotogalerie "{{event_name}}" wurde erfolgreich archiviert.</p>
<p><strong>Archiv-Details:</strong></p>
<ul>
  <li>Archivgröße: {{archive_size}}</li>
  <li>Archivierungsdatum: {{archive_date}}</li>
  <li>Anzahl der Fotos: {{photo_count}}</li>
</ul>
<p>Das Archiv wird sicher in unserem System aufbewahrt. Bei Bedarf können Sie sich an unseren Support wenden, um Zugriff auf die archivierten Fotos zu erhalten.</p>
<p style="background-color: #F0FDF4; padding: 15px; border-radius: 5px; border-left: 4px solid #22C55E;">
  <strong>✓ Erfolgreich archiviert:</strong> Ihre Fotos sind sicher gespeichert und können bei Bedarf wiederhergestellt werden.
</p>
<p>Kontakt für Archivzugriff:<br>
E-Mail: <a href="mailto:{{admin_email}}" style="color: #5C8762;">{{admin_email}}</a></p>
<p>Mit freundlichen Grüßen,<br>Ihr Foto-Sharing-Team</p>`,
      body_text_de: `Archivierung abgeschlossen

Liebe(r) {{host_name}},

Die Fotogalerie "{{event_name}}" wurde erfolgreich archiviert.

Archiv-Details:
- Archivgröße: {{archive_size}}
- Archivierungsdatum: {{archive_date}}
- Anzahl der Fotos: {{photo_count}}

Das Archiv wird sicher in unserem System aufbewahrt. Bei Bedarf können Sie sich an unseren Support wenden, um Zugriff auf die archivierten Fotos zu erhalten.

✓ ERFOLGREICH ARCHIVIERT: Ihre Fotos sind sicher gespeichert und können bei Bedarf wiederhergestellt werden.

Kontakt für Archivzugriff:
E-Mail: {{admin_email}}

Mit freundlichen Grüßen,
Ihr Foto-Sharing-Team`
    });

  // Also update the non-language-specific fields to match German for consistency
  await knex('email_templates')
    .where('template_key', 'gallery_created')
    .update({
      subject: knex.raw('subject_de'),
      body_html: knex.raw('body_html_de'),
      body_text: knex.raw('body_text_de')
    });

  await knex('email_templates')
    .where('template_key', 'expiration_warning')
    .update({
      subject: knex.raw('subject_de'),
      body_html: knex.raw('body_html_de'),
      body_text: knex.raw('body_text_de')
    });

  await knex('email_templates')
    .where('template_key', 'gallery_expired')
    .update({
      subject: knex.raw('subject_de'),
      body_html: knex.raw('body_html_de'),
      body_text: knex.raw('body_text_de')
    });

  await knex('email_templates')
    .where('template_key', 'archive_complete')
    .update({
      subject: knex.raw('subject_de'),
      body_html: knex.raw('body_html_de'),
      body_text: knex.raw('body_text_de')
    });
};

exports.down = async function(knex) {
  // Revert to previous German translations
  // This is a simplified rollback - in production you might want to store the old values
  await knex('email_templates')
    .where('template_key', 'gallery_created')
    .update({
      subject: knex.raw('subject_en'),
      body_html: knex.raw('body_html_en'),
      body_text: knex.raw('body_text_en')
    });

  await knex('email_templates')
    .where('template_key', 'expiration_warning')
    .update({
      subject: knex.raw('subject_en'),
      body_html: knex.raw('body_html_en'),
      body_text: knex.raw('body_text_en')
    });

  await knex('email_templates')
    .where('template_key', 'gallery_expired')
    .update({
      subject: knex.raw('subject_en'),
      body_html: knex.raw('body_html_en'),
      body_text: knex.raw('body_text_en')
    });

  await knex('email_templates')
    .where('template_key', 'archive_complete')
    .update({
      subject: knex.raw('subject_en'),
      body_html: knex.raw('body_html_en'),
      body_text: knex.raw('body_text_en')
    });
};