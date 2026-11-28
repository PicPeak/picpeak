/**
 * Spam protection for the website's contact form (issue 2618): Friendly
 * Captcha or Google reCAPTCHA (v2, the keys of Settings › Security), chosen
 * for the website on its own. The widget is the provider's script, so a page
 * with a contact form allows exactly that provider's origins in its policy
 * (websiteCsp) while the captcha is on; every other page keeps
 * script-src 'none'. The answer is checked on the server for every message.
 */
const axios = require('axios');
const logger = require('../../utils/logger');

// The Friendly Captcha SDK, pinned to one version and its hashes (SRI), so
// the CDN can serve nothing else under these tags.
const FRIENDLY_SDK = {
  base: 'https://cdn.jsdelivr.net/npm/@friendlycaptcha/sdk@1.1.5/',
  module: { file: 'site.min.js', integrity: 'sha384-IjnkVA1tUgynJOJBJQu1X2RV8yNA63EfkLBhBVPo6wwESzkb/zGH1dX2r3wxjgNg' },
  compat: { file: 'site.compat.min.js', integrity: 'sha384-qLx6bp+i1AL11vTZQPURIwNd01JOJn/EVk85XIMxJSV/GtOVQ0EgFAO89N553SMu' },
};
const FRIENDLY_VERIFY = { global: 'https://global.frcapi.com/api/v2/captcha/siteverify', eu: 'https://eu.frcapi.com/api/v2/captcha/siteverify' };
const RECAPTCHA_VERIFY = 'https://www.google.com/recaptcha/api/siteverify';

// The form field each widget adds to the form.
const RESPONSE_FIELD = { friendly: 'frc-captcha-response', recaptcha: 'g-recaptcha-response' };

const BASE_POLICY = {
  'default-src': ['\'self\''],
  'frame-ancestors': ['\'none\''],
  'img-src': ['\'self\'', 'data:', 'https:'],
  'media-src': ['\'self\''],
  'style-src': ['\'self\'', '\'unsafe-inline\'', 'https:'],
  'font-src': ['\'self\'', 'https:', 'data:'],
  'object-src': ['\'none\''],
  'script-src': ['\'none\''],
  'form-action': ['\'self\''],
  'base-uri': ['\'none\''],
};
const PROVIDER_SOURCES = {
  // Friendly Captcha: the SDK frames its puzzle from *.frcapi.com (global or
  // EU servers); the SDK itself, read from the pinned file, makes no
  // requests and starts no workers on the page.
  friendly: {
    'script-src': [FRIENDLY_SDK.base],
    'frame-src': ['https://*.frcapi.com'],
    'connect-src': ['\'self\'', 'https://*.frcapi.com'],
  },
  // Google's CSP guidance for reCAPTCHA: its scripts, its frames, and the
  // widget's requests to www.google.com/recaptcha/.
  recaptcha: {
    'script-src': ['https://www.google.com/recaptcha/', 'https://www.gstatic.com/recaptcha/'],
    'frame-src': ['https://www.google.com/recaptcha/', 'https://recaptcha.google.com/recaptcha/'],
    'connect-src': ['\'self\'', 'https://www.google.com/recaptcha/'],
  },
};

/** The policy of a website page; `provider` only on a page whose contact form shows the captcha. */
function websiteCsp(provider = null) {
  const policy = { ...BASE_POLICY, ...(PROVIDER_SOURCES[provider] || {}) };
  return Object.entries(policy).map(([name, sources]) => `${name} ${sources.join(' ')}`).join('; ');
}

/** The widget inside the form, and the provider's script. Keys are checked shapes (contactSettings). */
function widgetHtml(captcha, { locale, esc }) {
  if (captcha.provider === 'friendly') {
    const endpoint = captcha.endpoint === 'eu' ? ' data-api-endpoint="eu"' : '';
    return `<div class="frc-captcha" data-sitekey="${esc(captcha.siteKey)}"${endpoint} data-start="focus" lang="${locale === 'de' ? 'de' : 'en'}"></div>`
      + `<script type="module" src="${FRIENDLY_SDK.base}${FRIENDLY_SDK.module.file}" integrity="${FRIENDLY_SDK.module.integrity}" crossorigin="anonymous" async defer></script>`
      + `<script nomodule src="${FRIENDLY_SDK.base}${FRIENDLY_SDK.compat.file}" integrity="${FRIENDLY_SDK.compat.integrity}" crossorigin="anonymous" async defer></script>`;
  }
  return `<div class="g-recaptcha" data-sitekey="${esc(captcha.siteKey)}"></div>`
    + `<script src="https://www.google.com/recaptcha/api.js?hl=${locale === 'de' ? 'de' : 'en'}" async defer></script>`;
}

/**
 * The site an answer was solved on, as the provider reports it, must be the
 * public site: an answer solved on another page (someone else's site using
 * the same key) is refused. Without a known public origin, or without a
 * site in the provider's answer, there is nothing to compare.
 */
async function solvedHere(solvedOn) {
  if (!solvedOn) return true;
  let expected = '';
  try { expected = new URL(await require('../../utils/frontendUrl').getFrontendBaseUrl()).hostname.toLowerCase(); } catch { return true; }
  let actual = String(solvedOn).toLowerCase();
  try { if (/^https?:\/\//.test(actual)) actual = new URL(actual).hostname; } catch { return false; }
  return actual === expected;
}

/**
 * Whether the answer a form carried is valid, asked of the provider, and
 * solved on this site. Fails closed: no answer, no key, a timeout or an
 * error is "no".
 */
async function verifyAnswer(captcha, body, { ip } = {}) {
  const answer = body && typeof body[RESPONSE_FIELD[captcha.provider]] === 'string' ? body[RESPONSE_FIELD[captcha.provider]] : '';
  if (!answer || answer.length > 20000 || !captcha.secret) return false;
  try {
    if (captcha.provider === 'friendly') {
      const { data } = await axios.post(FRIENDLY_VERIFY[captcha.endpoint === 'eu' ? 'eu' : 'global'],
        { response: answer, sitekey: captcha.siteKey },
        { headers: { 'X-API-Key': captcha.secret }, timeout: 8000, validateStatus: () => true });
      // Friendly Captcha v2 names the page's origin the puzzle was solved on.
      return Boolean(data && data.success === true) && await solvedHere(data.data && data.data.challenge && data.data.challenge.origin);
    }
    const params = new URLSearchParams({ secret: captcha.secret, response: answer });
    if (ip) params.set('remoteip', ip);
    const { data } = await axios.post(RECAPTCHA_VERIFY, params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 8000 });
    // reCAPTCHA names the hostname of the page it was solved on.
    return Boolean(data && data.success === true) && await solvedHere(data.hostname);
  } catch (error) {
    logger.warn('Website contact form: captcha check failed', { provider: captcha.provider, error: error.message });
    return false;
  }
}

module.exports = { websiteCsp, widgetHtml, verifyAnswer, RESPONSE_FIELD, FRIENDLY_VERIFY, _internal: { FRIENDLY_SDK } };
