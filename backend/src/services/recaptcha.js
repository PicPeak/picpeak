const axios = require('axios');
const { db } = require('../database/db');

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
    console.warn('reCAPTCHA enabled but no secret key configured — blocking request');
    return false;
  }
  
  try {
    const response = await axios.post(
      'https://www.google.com/recaptcha/api/siteverify',
      null,
      {
        params: {
          secret: secretKey,
          response: token
        }
      }
    );
    
    return response.data.success === true;
  } catch (error) {
    console.error('reCAPTCHA verification error:', error);
    return false;
  }
}

module.exports = { verifyRecaptcha };