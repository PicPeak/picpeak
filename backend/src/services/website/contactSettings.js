/**
 * The website's contact form settings (issue 2618), saved right away (not
 * part of the draft): the spam check, who hears of a new message, and the
 * visitor's confirmation. Friendly Captcha keeps its own site key and API
 * key (encrypted at rest, never sent back); reCAPTCHA uses the keys of
 * Settings › Security, whether or not the galleries use it.
 */
const { db } = require('../../database/db');
const { parseSettingValue } = require('../../utils/appSettings');
const { createSecretBox } = require('../../utils/secretBox');
const { AppError } = require('../../utils/errors');
const { clearWebsiteCache } = require('./cache');
const { EMAIL_PATTERN } = require('./contact');

const KEYS = {
  provider: 'website_captcha_provider',
  friendlySiteKey: 'website_captcha_friendly_sitekey',
  friendlyApiKey: 'website_captcha_friendly_api_key',
  friendlyEndpoint: 'website_captcha_friendly_endpoint',
  recipients: 'website_contact_recipients',
  confirmation: 'website_contact_confirmation',
};
const MAX_RECIPIENTS = 5;
const PROVIDERS = ['none', 'friendly', 'recaptcha'];
const SITE_KEY = /^[A-Za-z0-9_-]{8,100}$/;

const box = createSecretBox({ envKey: 'WEBSITE_SECRET_KEY', salt: 'picpeak-website-captcha', label: 'Website captcha', memoize: true });

async function read(keys) {
  const rows = await db('app_settings').whereIn('setting_key', keys);
  const out = {};
  rows.forEach((row) => { out[row.setting_key] = parseSettingValue(row.setting_value); });
  return out;
}

async function write(key, value) {
  const row = { setting_key: key, setting_value: JSON.stringify(value), setting_type: 'website', updated_at: new Date().toISOString() };
  await db('app_settings').insert(row).onConflict('setting_key').merge(['setting_value', 'updated_at']);
}

/** Where a new message goes when no recipients are set: the business, else the support address. */
async function defaultRecipient() {
  const { profile } = await require('../businessProfileService').getProfile().catch(() => ({ profile: null }));
  if (profile && profile.email) return profile.email;
  const s = await read(['branding_support_email']);
  return typeof s.branding_support_email === 'string' ? s.branding_support_email : '';
}

function recipientList(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string' && EMAIL_PATTERN.test(v)) : [];
}

/** What the admin sees: no secret, only whether one is set. */
async function readContactSettings() {
  const s = await read([...Object.values(KEYS), 'security_recaptcha_site_key', 'security_recaptcha_secret_key']);
  return {
    contact: {
      recipients: recipientList(s[KEYS.recipients]),
      defaultRecipient: await defaultRecipient(),
      confirmation: s[KEYS.confirmation] === true,
    },
    captcha: {
      provider: PROVIDERS.includes(s[KEYS.provider]) ? s[KEYS.provider] : 'none',
      friendly: {
        siteKey: typeof s[KEYS.friendlySiteKey] === 'string' ? s[KEYS.friendlySiteKey] : '',
        endpoint: s[KEYS.friendlyEndpoint] === 'eu' ? 'eu' : 'global',
        apiKeySet: Boolean(s[KEYS.friendlyApiKey]),
      },
      // Settings › Security holds these; the website only uses them.
      recaptchaReady: Boolean(s.security_recaptcha_site_key && s.security_recaptcha_secret_key),
    },
  };
}

/**
 * Save. `friendly.apiKey`: a new key, '' to remove it, absent to keep it.
 * A provider can be chosen only once its keys are there: a captcha the
 * server cannot check would refuse every message.
 */
async function writeContactSettings(input) {
  const body = input && typeof input === 'object' ? input : {};
  const captcha = body.captcha && typeof body.captcha === 'object' ? body.captcha : {};
  const friendly = captcha.friendly && typeof captcha.friendly === 'object' ? captcha.friendly : {};
  const provider = captcha.provider === undefined ? undefined : captcha.provider;
  if (provider !== undefined && !PROVIDERS.includes(provider)) throw new AppError('Unknown spam check', 400, 'CAPTCHA_PROVIDER');
  if (friendly.siteKey !== undefined && friendly.siteKey !== '' && !SITE_KEY.test(String(friendly.siteKey))) {
    throw new AppError('This is not a Friendly Captcha site key', 400, 'CAPTCHA_SITE_KEY');
  }
  if (friendly.apiKey !== undefined && (typeof friendly.apiKey !== 'string' || friendly.apiKey.length > 200 || /\s/.test(friendly.apiKey))) {
    throw new AppError('This is not a Friendly Captcha API key', 400, 'CAPTCHA_API_KEY');
  }
  if (friendly.endpoint !== undefined && !['global', 'eu'].includes(friendly.endpoint)) throw new AppError('Unknown endpoint', 400, 'CAPTCHA_ENDPOINT');
  const contact = body.contact && typeof body.contact === 'object' ? body.contact : {};
  if (contact.recipients !== undefined) {
    const list = Array.isArray(contact.recipients) ? contact.recipients.map((v) => String(v).trim()).filter(Boolean) : null;
    if (!list || list.length > MAX_RECIPIENTS || list.some((v) => v.length > 254 || !EMAIL_PATTERN.test(v))) {
      throw new AppError(`Up to ${MAX_RECIPIENTS} e-mail addresses`, 400, 'CONTACT_RECIPIENT');
    }
    contact.recipients = [...new Set(list)];
  }

  if (friendly.siteKey !== undefined) await write(KEYS.friendlySiteKey, String(friendly.siteKey));
  if (friendly.endpoint !== undefined) await write(KEYS.friendlyEndpoint, friendly.endpoint);
  if (friendly.apiKey !== undefined) await write(KEYS.friendlyApiKey, friendly.apiKey ? box.encryptSecret(friendly.apiKey) : '');

  const current = await readContactSettings();
  const chosen = provider === undefined ? current.captcha.provider : provider;
  if (chosen === 'friendly' && !(current.captcha.friendly.siteKey && current.captcha.friendly.apiKeySet)) {
    throw new AppError('Enter the Friendly Captcha site key and API key first', 400, 'CAPTCHA_NOT_READY');
  }
  if (chosen === 'recaptcha' && !current.captcha.recaptchaReady) {
    throw new AppError('Enter the reCAPTCHA keys under Settings › Security first', 400, 'CAPTCHA_NOT_READY');
  }
  // A confirmation goes to whatever address a visitor types: only with a
  // spam check on, and off again when the check is turned off.
  const confirmation = contact.confirmation === undefined ? current.contact.confirmation : contact.confirmation === true;
  if (confirmation && chosen === 'none') {
    if (contact.confirmation === true) throw new AppError('Turn on a spam check first', 400, 'CONFIRMATION_NEEDS_CAPTCHA');
  }
  if (provider !== undefined) await write(KEYS.provider, provider);
  if (contact.recipients !== undefined) await write(KEYS.recipients, contact.recipients);
  await write(KEYS.confirmation, confirmation && chosen !== 'none');
  // The contact forms on the cached pages show the widget, or not.
  clearWebsiteCache();
  return readContactSettings();
}

/**
 * The captcha the live contact forms show, with what the server needs to
 * check it; null while it is off or its keys are gone.
 */
async function activeCaptcha() {
  const s = await read([...Object.values(KEYS), 'security_recaptcha_site_key', 'security_recaptcha_secret_key']);
  if (s[KEYS.provider] === 'friendly' && s[KEYS.friendlySiteKey] && s[KEYS.friendlyApiKey]) {
    let secret = '';
    try { secret = box.decryptSecret(s[KEYS.friendlyApiKey]); } catch { return null; }
    return { provider: 'friendly', siteKey: s[KEYS.friendlySiteKey], endpoint: s[KEYS.friendlyEndpoint] === 'eu' ? 'eu' : 'global', secret };
  }
  if (s[KEYS.provider] === 'recaptcha' && s.security_recaptcha_site_key && s.security_recaptcha_secret_key) {
    return { provider: 'recaptcha', siteKey: String(s.security_recaptcha_site_key), secret: String(s.security_recaptcha_secret_key) };
  }
  return null;
}

/** Who hears of a new message, and whether the visitor gets a confirmation. */
async function mailSettings() {
  const s = await read([KEYS.recipients, KEYS.confirmation]);
  const recipients = recipientList(s[KEYS.recipients]);
  const fallback = recipients.length ? '' : await defaultRecipient();
  return { recipients: recipients.length ? recipients : [fallback].filter(Boolean), confirmation: s[KEYS.confirmation] === true };
}

module.exports = { readContactSettings, writeContactSettings, activeCaptcha, mailSettings, KEYS };
