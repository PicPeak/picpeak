'use strict';

/**
 * Admin WhatsApp configuration routes (#640 part D).
 *
 *   GET  /api/admin/whatsapp/config — returns config with access_token masked
 *   PUT  /api/admin/whatsapp/config — upsert; masked tokens preserved
 *   POST /api/admin/whatsapp/test   — send a static test message to verify the
 *                                      Meta credentials + template approval
 *
 * Ported from filpgame/picpeak with a feature-flag gate via
 * `requireFeatureFlag('whatsapp')` and tighter validation on the enable path
 * (Phone Number ID, template name, AND access token all required to flip
 * `enabled=true`).
 */

const express = require('express');
const router = express.Router();
const { db, logActivity } = require('../database/db');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { requireFeatureFlag } = require('../middleware/requireFeatureFlag');
const { sendWhatsAppMessage } = require('../services/whatsappService');
const {
  buildComponents,
  parseTemplateParams,
  DEFAULT_TEMPLATE_PARAMS,
} = require('../services/whatsappProcessor');
const logger = require('../utils/logger');

// Gate everything behind the feature flag — operators who haven't enabled
// WhatsApp shouldn't see the routes (matches the accounting / contracts
// pattern). The Settings UI hides the tab as well; this is defence in depth.
router.use(requireFeatureFlag('whatsapp'));

router.get('/config', adminAuth, requirePermission('settings.view'), async (req, res) => {
  try {
    const config = await db('whatsapp_configs').first();
    if (!config) {
      return res.json({
        phone_number_id: '',
        waba_id: '',
        access_token: '',
        template_name: 'gallery_ready',
        template_language: '',
        template_params: DEFAULT_TEMPLATE_PARAMS,
        enabled: false,
      });
    }
    res.json({
      phone_number_id: config.phone_number_id,
      waba_id: config.waba_id,
      access_token: config.access_token ? '********' : '',
      template_name: config.template_name,
      template_language: config.template_language || '',
      template_params: parseTemplateParams(config.template_params),
      enabled: Boolean(config.enabled),
    });
  } catch (error) {
    logger.error('GET whatsapp-config error:', error);
    res.status(500).json({ error: 'Failed to load WhatsApp configuration' });
  }
});

router.put('/config', adminAuth, requirePermission('settings.edit'), async (req, res) => {
  try {
    const { phone_number_id, waba_id, access_token, template_name, template_language, template_params, enabled } = req.body;

    const existing = await db('whatsapp_configs').first();
    const isEnabled = Boolean(enabled);

    // Meta template-language codes are BCP-47 style: `ar`, `en_US`, `de_DE`,
    // `pt_BR`, etc. We accept arbitrary strings and pass through to Meta —
    // they'll return template_not_found_in_language (132001) if the code
    // doesn't match a registered template. No client-side allowlist because
    // Meta's supported-languages list changes.
    const normalizedTemplateLanguage = typeof template_language === 'string'
      ? template_language.trim().slice(0, 20)
      : '';

    // Template parameter selection (#647 follow-up). Round-trip through the
    // processor's sanitizer so unknown / duplicate / non-string keys are
    // dropped before persistence, and we always store the canonical JSON
    // array shape. Empty input falls back to the legacy 5-slot default so
    // existing installs keep working.
    const sanitizedTemplateParams = parseTemplateParams(template_params);

    const data = {
      phone_number_id: phone_number_id || '',
      waba_id: waba_id || '',
      template_name: template_name || 'gallery_ready',
      template_language: normalizedTemplateLanguage,
      template_params: JSON.stringify(sanitizedTemplateParams),
      enabled: isEnabled,
      updated_at: new Date(),
    };

    // Only persist the access_token when a real value (not the masked sentinel)
    // is supplied. This lets the admin PATCH everything else without re-entering
    // their long-lived Meta token every time.
    const hasNewToken = access_token && access_token !== '********';
    const hasStoredToken = existing && Boolean(existing.access_token);

    if (hasNewToken) {
      data.access_token = access_token;
    } else if (!existing && !hasNewToken) {
      // First-time insert without a real token — reject so we never store an
      // unusable enabled=true config.
      return res.status(400).json({ error: 'Access token is required when saving a new configuration' });
    }

    if (isEnabled) {
      if (!data.phone_number_id) {
        return res.status(400).json({ error: 'Phone Number ID is required to enable WhatsApp' });
      }
      if (!data.template_name) {
        return res.status(400).json({ error: 'Template name is required to enable WhatsApp' });
      }
      if (!hasNewToken && !hasStoredToken) {
        return res.status(400).json({ error: 'Access token is required to enable WhatsApp' });
      }
    }

    if (existing) {
      await db('whatsapp_configs').where('id', existing.id).update(data);
    } else {
      if (!data.access_token) data.access_token = '';
      await db('whatsapp_configs').insert(data);
    }

    await logActivity(
      'whatsapp_config_updated',
      { phone_number_id, enabled: isEnabled },
      null,
      { type: 'admin', id: req.admin.id, name: req.admin.username },
    );

    res.json({ success: true });
  } catch (error) {
    logger.error('PUT whatsapp-config error:', error);
    res.status(500).json({ error: 'Failed to save WhatsApp configuration' });
  }
});

router.post('/test', adminAuth, requirePermission('settings.edit'), async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    const config = await db('whatsapp_configs').first();
    if (!config || !config.phone_number_id || !config.access_token) {
      return res.status(400).json({ error: 'WhatsApp is not configured' });
    }

    // Use the configured template language so non-English templates can be
    // tested too (#647). Falls back to en_US for the default `gallery_ready`
    // shape that ships in English.
    const language = (config.template_language && config.template_language.trim()) || 'en_US';

    // Build the test components through the SAME path the production queue
    // uses, so the test message matches the admin's `template_params` shape
    // (#647 follow-up). With a 2-slot template (event_name + gallery_link)
    // we send exactly 2 positional values; with the default 5-slot shape
    // we send the legacy "PicPeak Test" payload. Static placeholder data —
    // the admin only needs to confirm credentials + template approval, not
    // the per-event substitution logic.
    const params = parseTemplateParams(config.template_params);
    const testData = {
      customer_name: 'PicPeak Test',
      event_name: 'Test Gallery',
      gallery_link: 'https://example.com/gallery/test',
      gallery_password: '',
      expiry_date: null,
    };
    const testComponents = buildComponents(testData, language, params);
    const result = await sendWhatsAppMessage(phone, config, language, testComponents);
    res.json({ success: true, messageId: result.messageId });
  } catch (error) {
    logger.error('WhatsApp test send error:', error);
    res.status(500).json({ error: error.message || 'Failed to send test message' });
  }
});

module.exports = router;
