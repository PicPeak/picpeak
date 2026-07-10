exports.up = async function(knex) {
  // Check if we have the default email templates
  const templates = await knex('email_templates').select('template_key');
  const existingKeys = templates.map(t => t.template_key);
  
  // Check which columns exist in the table
  const hasSubjectEn = await knex.schema.hasColumn('email_templates', 'subject_en');
  const hasSubject = await knex.schema.hasColumn('email_templates', 'subject');
  
  // Determine which columns to use based on schema
  const subjectCol = hasSubjectEn ? 'subject_en' : 'subject';
  const bodyHtmlCol = hasSubjectEn ? 'body_html_en' : 'body_html';
  const bodyTextCol = hasSubjectEn ? 'body_text_en' : 'body_text';
  
  const defaultTemplates = [
    {
      template_key: 'gallery_created',
      [subjectCol]: 'Your Photo Gallery is Ready!',
      [bodyHtmlCol]: `<h2>Gallery Created Successfully</h2>
<p>Dear {{host_name}},</p>
<p>Your photo gallery "{{event_name}}" has been created successfully!</p>
<p><strong>Gallery Details:</strong></p>
<ul>
  <li>Event Date: {{event_date}}</li>
  <li>Gallery Link: {{gallery_link}}</li>
  <li>Password: {{gallery_password}}</li>
  <li>Expires: {{expiry_date}}</li>
</ul>
<p>Share this link and password with your guests to allow them to view and download photos.</p>`,
      [bodyTextCol]: 'Gallery Created Successfully\n\nDear {{host_name}},\n\nYour photo gallery "{{event_name}}" has been created successfully!',
      variables: JSON.stringify(['host_name', 'event_name', 'event_date', 'gallery_link', 'gallery_password', 'expiry_date'])
    },
    {
      template_key: 'expiration_warning',
      [subjectCol]: 'Your Photo Gallery Expires Soon',
      [bodyHtmlCol]: `<h2>Gallery Expiring Soon</h2>
<p>Dear {{host_name}},</p>
<p>Your photo gallery "{{event_name}}" will expire in {{days_remaining}} days.</p>
<p>After expiration, the gallery will be archived and no longer accessible to guests.</p>
<p><a href="{{gallery_link}}">Visit Gallery</a></p>`,
      [bodyTextCol]: 'Gallery Expiring Soon\n\nDear {{host_name}},\n\nYour photo gallery "{{event_name}}" will expire in {{days_remaining}} days.',
      variables: JSON.stringify(['host_name', 'event_name', 'days_remaining', 'gallery_link'])
    },
    {
      template_key: 'gallery_expired',
      [subjectCol]: 'Your Photo Gallery Has Expired',
      [bodyHtmlCol]: `<h2>Gallery Expired</h2>
<p>Dear {{host_name}},</p>
<p>Your photo gallery "{{event_name}}" has expired and been archived.</p>
<p>The photos are safely stored in our archive system. If you need access to the archived photos, please contact support.</p>`,
      [bodyTextCol]: 'Gallery Expired\n\nDear {{host_name}},\n\nYour photo gallery "{{event_name}}" has expired and been archived.',
      variables: JSON.stringify(['host_name', 'event_name'])
    },
    {
      template_key: 'archive_complete',
      [subjectCol]: 'Gallery Archive Complete',
      [bodyHtmlCol]: `<h2>Archive Complete</h2>
<p>Dear {{host_name}},</p>
<p>Your photo gallery "{{event_name}}" has been successfully archived.</p>
<p>Archive size: {{archive_size}}</p>
<p>The archive is stored securely and can be retrieved if needed.</p>`,
      [bodyTextCol]: 'Archive Complete\n\nDear {{host_name}},\n\nYour photo gallery "{{event_name}}" has been successfully archived.',
      variables: JSON.stringify(['host_name', 'event_name', 'archive_size'])
    }
  ];
  
  // Insert missing templates
  for (const template of defaultTemplates) {
    if (!existingKeys.includes(template.template_key)) {
      // If we have language columns, also set German versions with same content
      if (hasSubjectEn) {
        template.subject_de = template[subjectCol];
        template.body_html_de = template[bodyHtmlCol];
        template.body_text_de = template[bodyTextCol];
        
        // Also ensure we have the basic columns if they exist
        if (hasSubject) {
          template.subject = template[subjectCol];
          template.body_html = template[bodyHtmlCol];
          template.body_text = template[bodyTextCol];
        }
      }
      
      await knex('email_templates').insert(template);
    }
  }
};

exports.down = async function(knex) {
  // Don't remove templates on rollback as they might have been customized
};