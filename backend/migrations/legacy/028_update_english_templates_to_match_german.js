exports.up = async function(knex) {
  // Update English templates to match the quality and content of German templates
  
  // 1. Gallery Created - Match German version with proper styling and conditionals
  await knex('email_templates')
    .where('template_key', 'gallery_created')
    .update({
      subject_en: 'Your photo gallery is ready',
      body_html_en: `
<h2>Hello {{host_name}},</h2>

<p>Your photo gallery <strong>{{event_name}}</strong> for {{event_date}} has been successfully created and is now online!</p>

{{#if welcome_message}}
<div style="background-color: #f0f8ff; border-left: 4px solid #5C8762; padding: 15px; margin: 20px 0; border-radius: 4px;">
  <p style="margin: 0;"><strong>Personal message from your photographer:</strong></p>
  <p style="margin: 10px 0 0 0;">{{welcome_message}}</p>
</div>
{{/if}}

<div style="background-color: #f9f9f9; padding: 20px; border-radius: 8px; margin: 20px 0;">
  <h3 style="margin-top: 0;">Your access data:</h3>
  <ul style="list-style: none; padding: 0;">
    <li style="margin-bottom: 10px;"><strong>Gallery link:</strong> <a href="{{gallery_link}}" style="color: #5C8762;">{{gallery_link}}</a></li>
    <li style="margin-bottom: 10px;"><strong>Password:</strong> {{gallery_password}}</li>
  </ul>
</div>

<div style="text-align: center; margin: 30px 0;">
  <a href="{{gallery_link}}" style="display: inline-block; padding: 12px 30px; background-color: #5C8762; color: white; text-decoration: none; border-radius: 5px; font-weight: 500;">View Gallery</a>
</div>

<div style="background-color: #fff3cd; border: 1px solid #ffeaa7; color: #856404; padding: 15px; border-radius: 4px; margin: 20px 0;">
  <p style="margin: 0;"><strong>Important:</strong> Your gallery will be available until <strong>{{expiry_date}}</strong>. After this date, the photos will be archived and will only be available upon request.</p>
</div>

<p>We hope you enjoy your photos!</p>

<p>Best regards,<br>
Your Photo Sharing Team</p>`,
      body_text_en: `Hello {{host_name}},

Your photo gallery "{{event_name}}" for {{event_date}} has been successfully created and is now online!

{{#if welcome_message}}
Personal message from your photographer:
{{welcome_message}}
{{/if}}

Your access data:
- Gallery link: {{gallery_link}}
- Password: {{gallery_password}}

Important: Your gallery will be available until {{expiry_date}}. After this date, the photos will be archived and will only be available upon request.

We hope you enjoy your photos!

Best regards,
Your Photo Sharing Team`
    });

  // 2. Expiration Warning - Match German version with urgency and styling
  await knex('email_templates')
    .where('template_key', 'expiration_warning')
    .update({
      subject_en: 'Your photo gallery expires soon',
      body_html_en: `
<h2>Hello {{host_name}},</h2>

<p>Your photo gallery <strong>{{event_name}}</strong> will expire in <strong style="color: #e74c3c; font-size: 18px;">{{days_remaining}} days</strong>!</p>

<div style="background-color: #fee; border: 1px solid #fcc; color: #c33; padding: 20px; border-radius: 8px; margin: 20px 0;">
  <p style="margin: 0; font-weight: bold; font-size: 16px;">⚠️ Important Notice</p>
  <p style="margin: 10px 0 0 0;">After {{expiry_date}}, your gallery will no longer be accessible online. The photos will be archived and will only be available upon special request.</p>
</div>

<p><strong>Don't miss out – download your photos now!</strong></p>

<div style="text-align: center; margin: 30px 0;">
  <a href="{{gallery_link}}" style="display: inline-block; padding: 14px 35px; background-color: #e74c3c; color: white; text-decoration: none; border-radius: 5px; font-weight: 600; font-size: 16px;">Visit Gallery Now</a>
</div>

<div style="background-color: #f9f9f9; padding: 15px; border-radius: 8px; margin: 20px 0;">
  <p style="margin: 0;"><strong>Quick reminder of your access data:</strong></p>
  <ul style="list-style: none; padding: 0; margin: 10px 0 0 0;">
    <li>Gallery link: <a href="{{gallery_link}}" style="color: #5C8762;">{{gallery_link}}</a></li>
    <li>Password: {{gallery_password}}</li>
  </ul>
</div>

<p>If you have any questions, please don't hesitate to contact us.</p>

<p>Best regards,<br>
Your Photo Sharing Team</p>`,
      body_text_en: `Hello {{host_name}},

Your photo gallery "{{event_name}}" will expire in {{days_remaining}} days!

⚠️ Important Notice
After {{expiry_date}}, your gallery will no longer be accessible online. The photos will be archived and will only be available upon special request.

Don't miss out – download your photos now!

Quick reminder of your access data:
- Gallery link: {{gallery_link}}
- Password: {{gallery_password}}

If you have any questions, please don't hesitate to contact us.

Best regards,
Your Photo Sharing Team`
    });

  // 3. Gallery Expired - Match German version with contact information
  await knex('email_templates')
    .where('template_key', 'gallery_expired')
    .update({
      subject_en: 'Your photo gallery has expired',
      body_html_en: `
<h2>Hello {{host_name}},</h2>

<p>Your photo gallery <strong>{{event_name}}</strong> expired on {{expiry_date}} and is no longer accessible online.</p>

<div style="background-color: #f9f9f9; border-left: 4px solid #5C8762; padding: 20px; margin: 20px 0; border-radius: 4px;">
  <h3 style="margin-top: 0;">Your photos are safely archived</h3>
  <p>Don't worry – your photos have been securely archived and are not lost. If you need access to your photos, please contact us:</p>
  <ul style="list-style: none; padding: 0;">
    <li style="margin-bottom: 8px;">📧 Email: <a href="mailto:{{support_email}}" style="color: #5C8762;">{{support_email}}</a></li>
    {{#if support_phone}}
    <li>📞 Phone: {{support_phone}}</li>
    {{/if}}
  </ul>
</div>

<p>Please have the following information ready when contacting us:</p>
<ul>
  <li>Event name: {{event_name}}</li>
  <li>Event date: {{event_date}}</li>
  <li>Expiry date: {{expiry_date}}</li>
</ul>

<p>We'll be happy to help you access your archived photos.</p>

<p>Best regards,<br>
Your Photo Sharing Team</p>`,
      body_text_en: `Hello {{host_name}},

Your photo gallery "{{event_name}}" expired on {{expiry_date}} and is no longer accessible online.

Your photos are safely archived
Don't worry – your photos have been securely archived and are not lost. If you need access to your photos, please contact us:

📧 Email: {{support_email}}
{{#if support_phone}}📞 Phone: {{support_phone}}{{/if}}

Please have the following information ready when contacting us:
- Event name: {{event_name}}
- Event date: {{event_date}}
- Expiry date: {{expiry_date}}

We'll be happy to help you access your archived photos.

Best regards,
Your Photo Sharing Team`
    });

  // 4. Archive Complete - Match German version with success message and details
  await knex('email_templates')
    .where('template_key', 'archive_complete')
    .update({
      subject_en: 'Your photo gallery has been successfully archived',
      body_html_en: `
<h2>Hello {{host_name}},</h2>

<p>Your photo gallery <strong>{{event_name}}</strong> has been successfully archived.</p>

<div style="background-color: #d4edda; border: 1px solid #c3e6cb; color: #155724; padding: 20px; border-radius: 8px; margin: 20px 0;">
  <p style="margin: 0; font-weight: bold;">✅ Archive successfully created</p>
  <p style="margin: 10px 0 0 0;">Your photos are now safely stored in our archive.</p>
</div>

<div style="background-color: #f9f9f9; padding: 20px; border-radius: 8px; margin: 20px 0;">
  <h3 style="margin-top: 0;">Archive details:</h3>
  <ul style="list-style: none; padding: 0;">
    <li style="margin-bottom: 8px;"><strong>Event:</strong> {{event_name}}</li>
    <li style="margin-bottom: 8px;"><strong>Archive date:</strong> {{archive_date}}</li>
    <li style="margin-bottom: 8px;"><strong>Number of photos:</strong> {{photo_count}}</li>
    <li><strong>Archive size:</strong> {{archive_size}}</li>
  </ul>
</div>

<p>If you need access to your archived photos in the future, please contact us at:</p>
<p style="margin-left: 20px;">
  📧 <a href="mailto:{{support_email}}" style="color: #5C8762;">{{support_email}}</a><br>
  {{#if support_phone}}📞 {{support_phone}}{{/if}}
</p>

<p>Thank you for using our photo sharing service!</p>

<p>Best regards,<br>
Your Photo Sharing Team</p>`,
      body_text_en: `Hello {{host_name}},

Your photo gallery "{{event_name}}" has been successfully archived.

✅ Archive successfully created
Your photos are now safely stored in our archive.

Archive details:
- Event: {{event_name}}
- Archive date: {{archive_date}}
- Number of photos: {{photo_count}}
- Archive size: {{archive_size}}

If you need access to your archived photos in the future, please contact us at:
📧 {{support_email}}
{{#if support_phone}}📞 {{support_phone}}{{/if}}

Thank you for using our photo sharing service!

Best regards,
Your Photo Sharing Team`
    });

  // 5. Test Email - Update to match German style
  await knex('email_templates')
    .where('template_key', 'test_email')
    .update({
      subject_en: 'Test Email - Photo Sharing Platform',
      body_html_en: `
<h2>Test Email</h2>

<p>This is a test email from your photo sharing platform.</p>

<div style="background-color: #d4edda; border: 1px solid #c3e6cb; color: #155724; padding: 15px; border-radius: 4px; margin: 20px 0;">
  <p style="margin: 0;"><strong>✅ Email configuration successful!</strong></p>
  <p style="margin: 10px 0 0 0;">Your email settings have been configured correctly and emails can be sent.</p>
</div>

<div style="background-color: #f9f9f9; padding: 15px; border-radius: 8px; margin: 20px 0;">
  <p style="margin: 0;"><strong>Configuration details:</strong></p>
  <ul style="margin: 10px 0 0 0;">
    <li>Timestamp: {{timestamp}}</li>
    <li>Sender: {{from_email}}</li>
  </ul>
</div>

<p>Best regards,<br>
Your Photo Sharing Team</p>`,
      body_text_en: `Test Email

This is a test email from your photo sharing platform.

✅ Email configuration successful!
Your email settings have been configured correctly and emails can be sent.

Configuration details:
- Timestamp: {{timestamp}}
- Sender: {{from_email}}

Best regards,
Your Photo Sharing Team`
    });
};

exports.down = async function(knex) {
  // Revert to previous simpler English templates
  await knex('email_templates')
    .where('template_key', 'gallery_created')
    .update({
      subject_en: 'Your Photo Gallery is Ready',
      body_html_en: '<h2>Hello,</h2><p>Your photo gallery "{{event_name}}" has been created.</p><p><strong>Access Link:</strong> <a href="{{gallery_link}}">{{gallery_link}}</a></p><p><strong>Password:</strong> {{gallery_password}}</p><p>The gallery will be available until {{expiry_date}}.</p>',
      body_text_en: 'Your photo gallery "{{event_name}}" has been created. Access Link: {{gallery_link}} Password: {{gallery_password}} The gallery will be available until {{expiry_date}}.'
    });

  await knex('email_templates')
    .where('template_key', 'expiration_warning')
    .update({
      subject_en: 'Gallery Expires in {{days_remaining}} Days',
      body_html_en: '<h2>Reminder</h2><p>Your photo gallery "{{event_name}}" will expire in {{days_remaining}} days.</p><p>Please download your photos before {{expiry_date}}.</p><p><a href="{{gallery_link}}">Access Gallery</a></p>',
      body_text_en: 'Your photo gallery "{{event_name}}" will expire in {{days_remaining}} days. Please download your photos before {{expiry_date}}. Access Gallery: {{gallery_link}}'
    });

  await knex('email_templates')
    .where('template_key', 'gallery_expired')
    .update({
      subject_en: 'Gallery Expired',
      body_html_en: '<h2>Gallery Expired</h2><p>Your photo gallery "{{event_name}}" has expired and is no longer accessible.</p><p>If you need access to your photos, please contact support.</p>',
      body_text_en: 'Your photo gallery "{{event_name}}" has expired and is no longer accessible. If you need access to your photos, please contact support.'
    });

  await knex('email_templates')
    .where('template_key', 'archive_complete')
    .update({
      subject_en: 'Gallery Archived',
      body_html_en: '<h2>Archive Complete</h2><p>Your gallery "{{event_name}}" has been archived.</p><p>Archive size: {{archive_size}}</p>',
      body_text_en: 'Your gallery "{{event_name}}" has been archived. Archive size: {{archive_size}}'
    });

  await knex('email_templates')
    .where('template_key', 'test_email')
    .update({
      subject_en: 'Test Email',
      body_html_en: '<p>This is a test email sent at {{timestamp}}.</p>',
      body_text_en: 'This is a test email sent at {{timestamp}}.'
    });
};