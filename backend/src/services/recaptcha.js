const axios = require('axios');
const { db } = require('../database/db');
const logger = require('../utils/logger');

/**
 * Google's answer for one solved challenge ({ success, hostname, … }), for
 * the site whose secret key this is. Throws when Google cannot be asked;
 * what that means is the caller's to decide.
 */
async function siteverify(secretKey, token, { ip } = {}) {
  const params = new URLSearchParams({ secret: secretKey, response: token });
  if (ip) params.set('remoteip', ip);
  const { data } = await axios.post('https://www.google.com/recaptcha/api/siteverify', params.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 8000 });
  return data || {};
}

async function verifyRecaptcha(token) {
  // Check if reCAPTCHA is enabled
  const settings = await db('app_settings')
    .whereIn('setting_key', ['security_enable_recaptcha', 'security_recaptcha_secret_key'])
    .select('setting_key', 'setting_value');
  
  const settingsMap = {};
  settings.forEach(setting => {
    try {
      settingsMap[setting.setting_key] = JSON.parse(setting.setting_value);
    } catch (e) {
      settingsMap[setting.setting_key] = setting.setting_value;
    }
  });
  
  const isEnabled = settingsMap.security_enable_recaptcha === true || 
                    settingsMap.security_enable_recaptcha === 'true';
  const secretKey = settingsMap.security_recaptcha_secret_key;
  
  // If reCAPTCHA is not enabled, always return true
  if (!isEnabled) {
    return true;
  }
  
  // If enabled but no token provided, fail
  if (!token) {
    return false;
  }
  
  // If no secret key configured, fail closed
  if (!secretKey) {
    logger.warn('reCAPTCHA enabled but no secret key configured — blocking request');
    return false;
  }
  
  try {
    return (await siteverify(secretKey, token)).success === true;
  } catch (error) {
    logger.error('reCAPTCHA verification error:', error);
    return false;
  }
}

module.exports = { verifyRecaptcha, siteverify };