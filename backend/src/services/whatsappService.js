'use strict';

/**
 * WhatsApp Business API client (#640 part D).
 *
 * Thin wrapper over Meta Graph API for sending template messages. The
 * processor is responsible for queueing + retries; this module is just the
 * HTTP call. Ported from filpgame/picpeak with a few cleanups:
 *   - Meta API version bumped to v20 (filpgame was on v19, deprecated in Q3 2026).
 *   - Timeout dropped to 8s — Meta typically responds in <1s; 10s was too long
 *     for the processor's per-message budget at 10/cycle.
 *   - Error surfaces include the Meta `error.code` so the processor can decide
 *     between retryable transients and permanent failures (template not
 *     approved, recipient opted out, etc.).
 */

const axios = require('axios');
const logger = require('../utils/logger');

const META_API_VERSION = process.env.WHATSAPP_META_API_VERSION || 'v20.0';
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`;
const REQUEST_TIMEOUT_MS = 8000;

/**
 * Normalise a phone number into Meta's expected `+E164` form.
 * Strips non-digits, prepends `+`. Rejects clearly-invalid inputs early so
 * the processor can mark the row permanently failed without a network call.
 */
function normalizePhone(phone) {
  if (!phone) throw new Error('Invalid phone number: null or empty');
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 10) {
    throw new Error(`Invalid phone number: too short after normalisation (${phone})`);
  }
  return `+${digits}`;
}

/**
 * Send one WhatsApp template message. `components` is an array of strings
 * mapped into the template's positional {{1}}…{{N}} body parameters.
 *
 * Returns `{ messageId }` on success. Throws on any non-2xx — the processor
 * catches and decides retry vs. fail based on the error code surfaced in the
 * thrown message.
 */
async function sendWhatsAppMessage(recipientPhone, config, languageCode, components) {
  const normalised = normalizePhone(recipientPhone);

  const payload = {
    messaging_product: 'whatsapp',
    to: normalised,
    type: 'template',
    template: {
      name: config.template_name,
      language: { code: languageCode },
      components: [
        {
          type: 'body',
          parameters: components.map((text) => ({ type: 'text', text: String(text || '') })),
        },
      ],
    },
  };

  try {
    const response = await axios.post(
      `${META_API_BASE}/${config.phone_number_id}/messages`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${config.access_token}`,
          'Content-Type': 'application/json',
        },
        timeout: REQUEST_TIMEOUT_MS,
      }
    );
    const messageId = response.data?.messages?.[0]?.id ?? 'unknown';
    logger.info(`WhatsApp message sent: ${messageId} → ${normalised}`);
    return { messageId };
  } catch (error) {
    const metaError = error.response?.data?.error;
    const metaCode = metaError?.code;
    const metaMessage = metaError?.message;
    const composed = metaCode
      ? `${metaMessage || error.message} (code=${metaCode})`
      : (metaMessage || error.message);
    logger.error('WhatsApp API error', {
      error: composed, phone: normalised, code: metaCode,
    });
    throw new Error(composed);
  }
}

module.exports = { normalizePhone, sendWhatsAppMessage };
