exports.up = async function(knex) {
  // Update gallery_created template with German content
  await knex('email_templates')
    .where('template_key', 'gallery_created')
    .update({
      subject_de: 'Ihre Fotogalerie ist bereit!',
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
<p>Teilen Sie diesen Link und das Passwort mit Ihren Gästen, damit sie Fotos ansehen und herunterladen können.</p>`,
      body_text_de: 'Galerie erfolgreich erstellt\n\nLiebe(r) {{host_name}},\n\nIhre Fotogalerie "{{event_name}}" wurde erfolgreich erstellt!'
    });
  
  // Update expiration_warning template with German content
  await knex('email_templates')
    .where('template_key', 'expiration_warning')
    .update({
      subject_de: 'Ihre Fotogalerie läuft bald ab',
      body_html_de: `<h2>Galerie läuft bald ab</h2>
<p>Liebe(r) {{host_name}},</p>
<p>Ihre Fotogalerie "{{event_name}}" läuft in {{days_remaining}} Tagen ab.</p>
<p>Nach Ablauf wird die Galerie archiviert und ist für Gäste nicht mehr zugänglich.</p>
<p><a href="{{gallery_link}}">Galerie besuchen</a></p>`,
      body_text_de: 'Galerie läuft bald ab\n\nLiebe(r) {{host_name}},\n\nIhre Fotogalerie "{{event_name}}" läuft in {{days_remaining}} Tagen ab.'
    });
  
  // Update gallery_expired template if it exists
  await knex('email_templates')
    .where('template_key', 'gallery_expired')
    .update({
      subject_de: 'Ihre Fotogalerie {{event_name}} ist abgelaufen',
      body_html_de: `<h2>Galerie abgelaufen</h2>
<p>Ihre Fotogalerie für "{{event_name}}" ist abgelaufen und nicht mehr zugänglich.</p>
<p>Die Fotos wurden zur sicheren Aufbewahrung archiviert. Wenn Sie wieder Zugriff benötigen, wenden Sie sich bitte an den Administrator unter {{admin_email}}.</p>
<p>Vielen Dank für die Nutzung unseres Foto-Sharing-Services!</p>
<p>Mit freundlichen Grüßen,<br>Das Foto-Sharing-Team</p>`,
      body_text_de: 'Ihre Fotogalerie für {{event_name}} ist abgelaufen und nicht mehr zugänglich.\n\nDie Fotos wurden archiviert. Bei Bedarf kontaktieren Sie bitte den Administrator unter {{admin_email}}.'
    });
  
  // Update archive_complete template if it exists
  await knex('email_templates')
    .where('template_key', 'archive_complete')
    .update({
      subject_de: 'Archivierung abgeschlossen: {{event_name}}',
      body_html_de: `<h2>Archivierung abgeschlossen</h2>
<p>Die Fotogalerie "{{event_name}}" wurde erfolgreich archiviert.</p>
<p>Archivgröße: {{archive_size}}</p>
<p>Das Archiv wird sicher aufbewahrt und kann bei Bedarf wiederhergestellt werden.</p>`,
      body_text_de: 'Die Fotogalerie "{{event_name}}" wurde erfolgreich archiviert.\n\nArchivgröße: {{archive_size}}'
    });
};

exports.down = async function(knex) {
  // Reset German fields to null
  await knex('email_templates').update({
    subject_de: null,
    body_html_de: null,
    body_text_de: null
  });
};