/**
 * Settings Service Layer
 * Handles all settings-related business logic
 *
 * @module services/settingsService
 */

const { db } = require('../database/db');
const { parseBooleanInput, parseNumberInput } = require('../utils/parsers');

/**
 * Get all settings
 * @returns {Promise<Object>}
 */
const getAllSettings = async () => {
  const settings = await db('settings').select('*');
  const settingsMap = {};

  for (const setting of settings) {
    settingsMap[setting.key] = parseSettingValue(setting.value, setting.type);
  }

  return settingsMap;
};

/**
 * Get a specific setting
 * @param {string} key - Setting key
 * @param {*} defaultValue - Default value if not found
 * @returns {Promise<*>}
 */
const getSetting = async (key, defaultValue = null) => {
  const setting = await db('settings').where('key', key).first();
  if (!setting) {
    return defaultValue;
  }
  return parseSettingValue(setting.value, setting.type);
};

/**
 * Get multiple settings by prefix
 * @param {string} prefix - Setting key prefix
 * @returns {Promise<Object>}
 */
const getSettingsByPrefix = async (prefix) => {
  const settings = await db('settings')
    .where('key', 'like', `${prefix}%`)
    .select('*');

  const settingsMap = {};
  for (const setting of settings) {
    settingsMap[setting.key] = parseSettingValue(setting.value, setting.type);
  }

  return settingsMap;
};

/**
 * Update a setting
 * @param {string} key - Setting key
 * @param {*} value - Setting value
 * @param {string} type - Value type (string, boolean, number, json)
 * @returns {Promise<Object>}
 */
const updateSetting = async (key, value, type = 'string') => {
  const serializedValue = serializeSettingValue(value, type);

  const exists = await db('settings').where('key', key).first();
  if (exists) {
    await db('settings').where('key', key).update({
      value: serializedValue,
      type,
      updated_at: new Date()
    });
  } else {
    await db('settings').insert({
      key,
      value: serializedValue,
      type,
      created_at: new Date(),
      updated_at: new Date()
    });
  }

  return { success: true, key, value };
};

/**
 * Update multiple settings
 * @param {Object} settings - Key-value pairs of settings
 * @returns {Promise<Object>}
 */
const updateSettings = async (settings) => {
  const trx = await db.transaction();

  try {
    for (const [key, value] of Object.entries(settings)) {
      const type = inferSettingType(value);
      const serializedValue = serializeSettingValue(value, type);

      const exists = await trx('settings').where('key', key).first();
      if (exists) {
        await trx('settings').where('key', key).update({
          value: serializedValue,
          type,
          updated_at: new Date()
        });
      } else {
        await trx('settings').insert({
          key,
          value: serializedValue,
          type,
          created_at: new Date(),
          updated_at: new Date()
        });
      }
    }

    await trx.commit();
    return { success: true, count: Object.keys(settings).length };
  } catch (error) {
    await trx.rollback();
    throw error;
  }
};

/**
 * Delete a setting
 * @param {string} key - Setting key
 * @returns {Promise<Object>}
 */
const deleteSetting = async (key) => {
  await db('settings').where('key', key).delete();
  return { success: true };
};

/**
 * Get public settings (safe to expose to frontend)
 * @returns {Promise<Object>}
 */
const getPublicSettings = async () => {
  const publicKeys = [
    'branding_site_name',
    'branding_logo_url',
    'branding_favicon_url',
    'branding_primary_color',
    'branding_accent_color',
    'general_default_expiration_days',
    'recaptcha_enabled',
    'recaptcha_site_key',
    'event_require_customer_name',
    'event_require_customer_email',
    'event_require_admin_email'
  ];

  const settings = await db('settings')
    .whereIn('key', publicKeys)
    .select('*');

  const settingsMap = {};
  for (const setting of settings) {
    settingsMap[setting.key] = parseSettingValue(setting.value, setting.type);
  }

  return settingsMap;
};

/**
 * Get branding settings
 * @returns {Promise<Object>}
 */
const getBrandingSettings = async () => {
  return await getSettingsByPrefix('branding_');
};

/**
 * Get email settings
 * @returns {Promise<Object>}
 */
const getEmailSettings = async () => {
  return await getSettingsByPrefix('email_');
};

/**
 * Get storage settings
 * @returns {Promise<Object>}
 */
const getStorageSettings = async () => {
  return await getSettingsByPrefix('storage_');
};

// Helper functions

/**
 * Parse a setting value based on type
 * @param {string} value - Raw value
 * @param {string} type - Value type
 * @returns {*}
 */
const parseSettingValue = (value, type) => {
  if (value === null || value === undefined) {
    return null;
  }

  switch (type) {
    case 'boolean':
      return parseBooleanInput(value, false);
    case 'number':
      return parseNumberInput(value, 0);
    case 'json':
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    default:
      return value;
  }
};

/**
 * Serialize a setting value for storage
 * @param {*} value - Value to serialize
 * @param {string} type - Value type
 * @returns {string}
 */
const serializeSettingValue = (value, type) => {
  if (value === null || value === undefined) {
    return null;
  }

  switch (type) {
    case 'boolean':
      return String(value === true || value === 'true' || value === 1);
    case 'number':
      return String(value);
    case 'json':
      return JSON.stringify(value);
    default:
      return String(value);
  }
};

/**
 * Infer setting type from value
 * @param {*} value - Value to infer type from
 * @returns {string}
 */
const inferSettingType = (value) => {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'object') return 'json';
  return 'string';
};

module.exports = {
  getAllSettings,
  getSetting,
  getSettingsByPrefix,
  updateSetting,
  updateSettings,
  deleteSetting,
  getPublicSettings,
  getBrandingSettings,
  getEmailSettings,
  getStorageSettings
};
