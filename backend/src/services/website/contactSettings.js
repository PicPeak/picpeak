/**
 * The website's contact form settings (issue 2618), saved right away (not
 * part of the draft): the spam check. Friendly Captcha keeps its own site
 * key and API key (encrypted at rest, never sent back); reCAPTCHA uses the
 * keys of Settings › Security, whether or not the galleries use it.
 */
const { db } = require('../../database/db');
const { parseSettingValue } = require('../../utils/appSettings');
const { createSecretBox } = require('../../utils/secretBox');
const { AppError } = require('../../utils/errors');
const { clearWebsiteCache } = require('./cache');

const KEYS = {
  provider: 'website_captcha_provider',
  friendlySiteKey: 'website_captcha_friendly_sitekey',
  friendlyApiKey: 'website_captcha_friendly_api_key',
  friendlyEndpoint: 'website_captcha_friendly_endpoint',
};
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

/** What the admin sees: no secret, only whether one is set. */
async function readContactSettings() {
  const s = await read([...Object.values(KEYS), 'security_recaptcha_site_key', 'security_recaptcha_secret_key']);
  return {
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
  if (provider !== undefined) await write(KEYS.provider, provider);
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

module.exports = { readContactSettings, writeContactSettings, activeCaptcha, KEYS };
