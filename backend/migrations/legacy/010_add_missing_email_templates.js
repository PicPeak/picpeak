exports.up = async function(knex) {
  // Check if gallery_expired template exists
  const galleryExpiredExists = await knex('email_templates')
    .where('template_key', 'gallery_expired')
    .first();
    
  if (!galleryExpiredExists) {
    await knex('email_templates').insert({
      template_key: 'gallery_expired',
      subject_en: 'Your {{event_name}} photo gallery has expired',
      body_html_en: `<h2>Gallery Expired</h2>
<p>Your photo gallery for {{event_name}} has expired and is no longer accessible.</p>
<p>The photos have been archived for safekeeping. If you need access to them, please contact the event administrator at {{admin_email}}.</p>
<p>Thank you for using our photo sharing service!</p>
<p>Best regards,<br>The Photo Sharing Team</p>`,
      body_text_en: 'Your photo gallery for {{event_name}} has expired and is no longer accessible.\n\nThe photos have been archived. Please contact the administrator at {{admin_email}} if you need access.',
      subject_de: 'Ihre Fotogalerie {{event_name}} ist abgelaufen',
      body_html_de: `<h2>Galerie abgelaufen</h2>
<p>Ihre Fotogalerie für "{{event_name}}" ist abgelaufen und nicht mehr zugänglich.</p>
<p>Die Fotos wurden zur sicheren Aufbewahrung archiviert. Wenn Sie wieder Zugriff benötigen, wenden Sie sich bitte an den Administrator unter {{admin_email}}.</p>
<p>Vielen Dank für die Nutzung unseres Foto-Sharing-Services!</p>
<p>Mit freundlichen Grüßen,<br>Das Foto-Sharing-Team</p>`,
      body_text_de: 'Ihre Fotogalerie für {{event_name}} ist abgelaufen und nicht mehr zugänglich.\n\nDie Fotos wurden archiviert. Bei Bedarf kontaktieren Sie bitte den Administrator unter {{admin_email}}.',
      variables: JSON.stringify(['event_name', 'admin_email'])
    });
  }
  
  // Check if archive_complete template exists
  const archiveCompleteExists = await knex('email_templates')
    .where('template_key', 'archive_complete')
    .first();
    
  if (!archiveCompleteExists) {
    await knex('email_templates').insert({
      template_key: 'archive_complete',
      subject_en: 'Archive Complete: {{event_name}}',
      body_html_en: `<h2>Archive Complete</h2>
<p>The photo gallery "{{event_name}}" has been successfully archived.</p>
<p>Archive size: {{archive_size}}</p>
<p>The archive has been stored securely and can be restored if needed.</p>`,
      body_text_en: 'The photo gallery "{{event_name}}" has been successfully archived.\n\nArchive size: {{archive_size}}',
      subject_de: 'Archivierung abgeschlossen: {{event_name}}',
      body_html_de: `<h2>Archivierung abgeschlossen</h2>
<p>Die Fotogalerie "{{event_name}}" wurde erfolgreich archiviert.</p>
<p>Archivgröße: {{archive_size}}</p>
<p>Das Archiv wird sicher aufbewahrt und kann bei Bedarf wiederhergestellt werden.</p>`,
      body_text_de: 'Die Fotogalerie "{{event_name}}" wurde erfolgreich archiviert.\n\nArchivgröße: {{archive_size}}',
      variables: JSON.stringify(['event_name', 'archive_size'])
    });
  }
};

exports.down = async function(knex) {
  await knex('email_templates')
    .whereIn('template_key', ['gallery_expired', 'archive_complete'])
    .del();
};