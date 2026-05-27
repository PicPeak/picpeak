const express = require('express');
const nodemailer = require('nodemailer');
const { body, validationResult } = require('express-validator');
const { db, logActivity } = require('../database/db');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { wrapEmailHtml } = require('../services/emailProcessor');
const router = express.Router();

// Get email configuration
router.get('/config', adminAuth, requirePermission('email.view'), async (req, res) => {
  try {
    const config = await db('email_configs').first();
    
    if (!config) {
      return res.json({
        smtp_host: '',
        smtp_port: 587,
        smtp_secure: false,
        smtp_user: '',
        smtp_pass: '', // Don't send actual password
        from_email: '',
        from_name: '',
        tls_reject_unauthorized: true
      });
    }

    // Don't send the actual password
    res.json({
      ...config,
      smtp_pass: config.smtp_pass ? '********' : ''
    });
  } catch (error) {
    console.error('Email config fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch email configuration' });
  }
});

// Update email configuration
router.post('/config', [
  adminAuth,
  requirePermission('email.edit'),
  body('smtp_host').notEmpty().withMessage('SMTP host is required'),
  body('smtp_port').isInt({ min: 1, max: 65535 }).withMessage('Invalid port number'),
  body('from_email').isEmail().withMessage('Invalid from email address')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const {
      smtp_host,
      smtp_port,
      smtp_secure,
      smtp_user,
      smtp_pass,
      from_email,
      from_name,
      tls_reject_unauthorized
    } = req.body;

    // Validate SMTP host is not a private/internal address (SSRF protection)
    const { isPrivateIP } = require('../utils/networkValidation');
    if (isPrivateIP(smtp_host)) {
      return res.status(400).json({ error: 'SMTP host cannot point to a private or internal network address' });
    }

    // Check if config exists
    const existingConfig = await db('email_configs').first();
    
    const configData = {
      smtp_host,
      smtp_port: parseInt(smtp_port),
      smtp_secure: smtp_secure || false,
      smtp_user: smtp_user || '',
      from_email,
      from_name: from_name || 'Photo Sharing',
      tls_reject_unauthorized: tls_reject_unauthorized !== false, // Default to true
      updated_at: new Date()
    };

    // Only update password if provided and not masked
    if (smtp_pass && smtp_pass !== '********') {
      configData.smtp_pass = smtp_pass;
    }

    if (existingConfig) {
      await db('email_configs')
        .where('id', existingConfig.id)
        .update(configData);
    } else {
      await db('email_configs').insert(configData);
    }

    // Log activity
    await logActivity('email_config_updated', 
      { smtp_host, from_email }, 
      null, 
      { type: 'admin', id: req.admin.id, name: req.admin.username }
    );

    res.json({ message: 'Email configuration updated successfully' });
  } catch (error) {
    console.error('Email config update error:', error);
    res.status(500).json({ error: 'Failed to update email configuration' });
  }
});

// Test email configuration
router.post('/test', adminAuth, requirePermission('email.send'), async (req, res) => {
  try {
    const { test_email } = req.body;
    
    if (!test_email) {
      return res.status(400).json({ error: 'Test email address is required' });
    }

    // Get email config
    const config = await db('email_configs').first();
    
    if (!config) {
      return res.status(400).json({ error: 'Email configuration not found. Please configure SMTP settings first.' });
    }

    // Validate SMTP configuration
    if (!config.smtp_host || !config.smtp_port) {
      return res.status(400).json({ 
        error: 'Incomplete email configuration',
        details: 'SMTP host and port are required'
      });
    }
    
    // Check if password might be masked (this shouldn't happen when fetching from DB)
    if (config.smtp_pass === '********') {
      return res.status(400).json({
        error: 'Invalid email configuration',
        details: 'SMTP password appears to be masked. Please reconfigure your email settings.'
      });
    }

    // Create transporter with detailed logging
    const transportConfig = {
      host: config.smtp_host,
      port: parseInt(config.smtp_port),
      secure: config.smtp_secure === true || config.smtp_secure === 1,
      auth: config.smtp_user && config.smtp_pass ? {
        user: config.smtp_user,
        pass: config.smtp_pass
      } : undefined,
      tls: {
        // Allow ignoring SSL certificate errors when tls_reject_unauthorized is false
        rejectUnauthorized: config.tls_reject_unauthorized !== false
      },
      logger: process.env.NODE_ENV === 'development',
      debug: process.env.NODE_ENV === 'development'
    };

    console.log('Creating email transporter with config:', {
      host: transportConfig.host,
      port: transportConfig.port,
      secure: transportConfig.secure,
      auth: transportConfig.auth ? 'configured' : 'none'
    });

    const transporter = nodemailer.createTransport(transportConfig);

    // Send test email with the same wrapper used for all other emails
    const subject = 'Test Email - Photo Sharing Platform';
    const testHtmlBody = `
      <h2>Test Email Successful!</h2>
      <p>This is a test email from your Photo Sharing platform.</p>
      <p>If you're seeing this, your email configuration is working correctly.</p>
      <hr>
      <p style="color: #666; font-size: 12px;">
        Sent from: ${config.from_email}<br>
        SMTP Host: ${config.smtp_host}<br>
        Time: ${new Date().toISOString()}
      </p>
    `;
    const wrappedHtml = await wrapEmailHtml(testHtmlBody, subject);

    await transporter.sendMail({
      from: `${config.from_name} <${config.from_email}>`,
      to: test_email,
      subject,
      html: wrappedHtml,
      text: 'Test Email Successful! Your email configuration is working correctly.'
    });

    res.json({ message: 'Test email sent successfully' });
  } catch (error) {
    console.error('Test email error:', error);
    console.error('Error stack:', error.stack);

    // Provide more specific error messages with translation keys
    let errorMessage = 'Error sending email';
    let errorKey = 'email.errors.sendFailed';
    let details = error.message;
    let detailsKey = 'email.errors.unknownError';

    if (error.code === 'ECONNREFUSED') {
      errorMessage = 'Failed to connect to SMTP server';
      errorKey = 'email.errors.connectionRefused';
      details = 'Please check your SMTP host and port settings';
      detailsKey = 'email.errors.checkHostPort';
    } else if (error.code === 'EAUTH') {
      errorMessage = 'SMTP authentication failed';
      errorKey = 'email.errors.authFailed';
      details = 'Please check your SMTP username and password';
      detailsKey = 'email.errors.checkCredentials';
    } else if (error.code === 'ESOCKET') {
      errorMessage = 'Network error connecting to SMTP server';
      errorKey = 'email.errors.networkError';
      details = 'Could not establish connection to SMTP server';
      detailsKey = 'email.errors.connectionFailed';
    } else if (error.code === 'ETIMEDOUT') {
      errorMessage = 'Connection to SMTP server timed out';
      errorKey = 'email.errors.timeout';
      details = 'The server took too long to respond. Please check your network and SMTP settings.';
      detailsKey = 'email.errors.timeoutDetails';
    } else if (error.code === 'ENOTFOUND') {
      errorMessage = 'SMTP server not found';
      errorKey = 'email.errors.serverNotFound';
      details = 'The SMTP host could not be resolved. Please verify the hostname.';
      detailsKey = 'email.errors.checkHostname';
    } else if (error.responseCode >= 500) {
      errorMessage = 'SMTP server error';
      errorKey = 'email.errors.serverError';
      details = `Server returned error code ${error.responseCode}`;
      detailsKey = 'email.errors.serverErrorDetails';
    } else if (error.responseCode >= 400) {
      errorMessage = 'Email rejected by server';
      errorKey = 'email.errors.rejected';
      details = error.response || 'The email was rejected. Check recipient address and settings.';
      detailsKey = 'email.errors.rejectedDetails';
    }

    res.status(500).json({
      error: errorMessage,
      errorKey: errorKey,
      details: details,
      detailsKey: detailsKey,
      code: error.code,
      responseCode: error.responseCode
    });
  }
});

// Helper: parse variables JSON safely
function parseVariables(template) {
  try {
    if (!template.variables) return [];
    if (typeof template.variables === 'object') return template.variables;
    return JSON.parse(template.variables);
  } catch (e) {
    console.warn('Failed to parse variables for template:', template.template_key, e.message);
    return [];
  }
}

// Helper: get translations for a template, with legacy column fallback
async function getTemplateTranslations(templateId, template) {
  const translations = {};
  try {
    const rows = await db('email_template_translations')
      .where('template_id', templateId)
      .select('language', 'subject', 'body_html', 'body_text');

    rows.forEach(row => {
      translations[row.language] = {
        subject: row.subject || '',
        body_html: row.body_html || '',
        body_text: row.body_text || '',
      };
    });
  } catch (error) {
    // Translations table might not exist yet (pre-migration)
    // Fall back to legacy columns
    if (template.subject_en !== undefined) {
      translations.en = {
        subject: template.subject_en || '',
        body_html: template.body_html_en || '',
        body_text: template.body_text_en || '',
      };
      translations.de = {
        subject: template.subject_de || '',
        body_html: template.body_html_de || '',
        body_text: template.body_text_de || '',
      };
    } else {
      translations.en = {
        subject: template.subject || '',
        body_html: template.body_html || '',
        body_text: template.body_text || '',
      };
    }
  }
  return translations;
}

// Get email templates
router.get('/templates', adminAuth, requirePermission('email.view'), async (req, res) => {
  try {
    const templates = await db('email_templates')
      .select('*')
      .orderBy('template_key');

    const formattedTemplates = [];
    for (const template of templates) {
      const translations = await getTemplateTranslations(template.id, template);
      formattedTemplates.push({
        id: template.id,
        template_key: template.template_key,
        variables: parseVariables(template),
        translations,
        // Categorisation + feature-flag link added by migration 098.
        // Older installs that haven't run the migration yet return
        // 'core' / null fall-backs so the frontend keeps working
        // without a hard dependency on the new columns.
        category: template.category || 'core',
        subcategory: template.subcategory || null,
        feature_flag: template.feature_flag || null,
        updated_at: template.updated_at,
      });
    }

    res.json(formattedTemplates);
  } catch (error) {
    console.error('Email templates fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch email templates' });
  }
});

// Get single template
router.get('/templates/:key', adminAuth, requirePermission('email.view'), async (req, res) => {
  try {
    const template = await db('email_templates')
      .where('template_key', req.params.key)
      .first();

    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    const translations = await getTemplateTranslations(template.id, template);

    res.json({
      id: template.id,
      template_key: template.template_key,
      variables: parseVariables(template),
      translations,
      // See list endpoint for the rationale on the || fallbacks.
      category: template.category || 'core',
      subcategory: template.subcategory || null,
      feature_flag: template.feature_flag || null,
      updated_at: template.updated_at,
    });
  } catch (error) {
    console.error('Email template fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch email template' });
  }
});

// Update email template translations
router.put('/templates/:key', [
  adminAuth,
  requirePermission('email.edit'),
], async (req, res) => {
  try {
    const template = await db('email_templates')
      .where('template_key', req.params.key)
      .first();

    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    const { translations } = req.body;

    if (!translations || typeof translations !== 'object') {
      return res.status(400).json({ error: 'translations object is required' });
    }

    // Upsert each language translation
    for (const [language, data] of Object.entries(translations)) {
      if (!data || typeof data !== 'object') continue;

      const existing = await db('email_template_translations')
        .where({ template_id: template.id, language })
        .first();

      const row = {
        subject: data.subject || '',
        body_html: data.body_html || '',
        body_text: data.body_text || '',
        updated_at: new Date(),
      };

      if (existing) {
        await db('email_template_translations')
          .where({ template_id: template.id, language })
          .update(row);
      } else {
        await db('email_template_translations').insert({
          template_id: template.id,
          language,
          ...row,
          created_at: new Date(),
        });
      }
    }

    // Update timestamp on parent template
    await db('email_templates')
      .where('id', template.id)
      .update({ updated_at: new Date() });

    // Also sync legacy columns for backward compatibility
    const enData = translations.en;
    const deData = translations.de;
    const legacyUpdate = { updated_at: new Date() };
    const columnInfo = await db('email_templates').columnInfo();

    if (enData && columnInfo.subject_en) {
      legacyUpdate.subject_en = enData.subject || '';
      legacyUpdate.body_html_en = enData.body_html || '';
      legacyUpdate.body_text_en = enData.body_text || '';
    }
    if (deData && columnInfo.subject_de) {
      legacyUpdate.subject_de = deData.subject || '';
      legacyUpdate.body_html_de = deData.body_html || '';
      legacyUpdate.body_text_de = deData.body_text || '';
    }

    await db('email_templates')
      .where('id', template.id)
      .update(legacyUpdate);

    // Log activity
    await logActivity('email_template_updated',
      { template_key: req.params.key, languages: Object.keys(translations) },
      null,
      { type: 'admin', id: req.admin.id, name: req.admin.username }
    );

    res.json({ message: 'Email template updated successfully' });
  } catch (error) {
    console.error('Email template update error:', error);
    res.status(500).json({ error: 'Failed to update email template' });
  }
});

// Preview email template
router.post('/templates/:key/preview', adminAuth, requirePermission('email.view'), async (req, res) => {
  try {
    const template = await db('email_templates')
      .where('template_key', req.params.key)
      .first();

    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    const { preview_data, language = 'en' } = req.body;

    // Get translation from translations table with fallback
    let translation = null;
    try {
      translation = await db('email_template_translations')
        .where({ template_id: template.id, language })
        .first();

      if (!translation && language !== 'en') {
        translation = await db('email_template_translations')
          .where({ template_id: template.id, language: 'en' })
          .first();
      }
    } catch (e) {
      // Fallback to legacy columns
    }

    let subject = '';
    let htmlContent = '';
    let textContent = '';

    if (translation) {
      subject = translation.subject || '';
      htmlContent = translation.body_html || '';
      textContent = translation.body_text || '';
    } else {
      // Legacy column fallback
      const subjectField = language === 'de' && template.subject_de ? 'subject_de' : 'subject_en';
      const htmlField = language === 'de' && template.body_html_de ? 'body_html_de' : 'body_html_en';
      const textField = language === 'de' && template.body_text_de ? 'body_text_de' : 'body_text_en';
      subject = template[subjectField] || template.subject || '';
      htmlContent = template[htmlField] || template.body_html || '';
      textContent = template[textField] || template.body_text || '';
    }

    if (preview_data) {
      const escapeHtml = (str) => String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');

      Object.keys(preview_data).forEach(key => {
        const regex = new RegExp(`{{${key}}}`, 'g');
        const escapedValue = escapeHtml(preview_data[key]);
        htmlContent = htmlContent.replace(regex, escapedValue);
        textContent = textContent.replace(regex, preview_data[key]);
        subject = subject.replace(regex, escapeHtml(preview_data[key]));
      });
    }

    // Wrap in the full styled email template with header/footer/logo
    const wrappedHtml = await wrapEmailHtml(htmlContent, subject, language);

    res.json({
      subject,
      body_html: wrappedHtml,
      body_text: textContent,
      language
    });
  } catch (error) {
    console.error('Email template preview error:', error);
    res.status(500).json({ error: 'Failed to preview email template' });
  }
});

module.exports = router;