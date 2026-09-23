const Joi = require('joi');
const eventTypes = require('./eventTypeService');
const { AppError } = require('../utils/errors');
const { normaliseEventTimeTriple } = require('./eventService');
const optionalText = Joi.string().allow('', null);
const schema = Joi.object({
  event_name: Joi.string().trim().min(1).max(255).required(),
  event_type: Joi.string().trim().min(1).max(255).required(),
  event_date: Joi.string().isoDate().raw().allow('', null),
  expires_at: Joi.string().isoDate().raw().allow('', null),
  expiration_days: Joi.number().integer().min(1).max(365),
  customer_email: Joi.string().email({ tlds: { allow: false } }).allow('', null),
  admin_email: Joi.string().email({ tlds: { allow: false } }).allow('', null),
  customer_name: optionalText,
  customer_phone: optionalText.max(32),
  password: Joi.string().max(1024).allow('', null),
  client_password: Joi.string().max(1024).allow('', null),
  color_theme: optionalText,
  welcome_message: optionalText,
  photo_cap: Joi.number().integer().min(1).allow(null),
  download_limit: Joi.number().integer().min(1).max(2147483647).allow(null),
  guest_name_mode: Joi.string().valid('off', 'optional', 'required'),
  image_quality: Joi.number().integer().min(1).max(100),
  protection_level: Joi.string().valid('basic', 'standard', 'enhanced', 'maximum'),
  hero_logo_size: Joi.string().valid('small', 'medium', 'large', 'xlarge').allow(null),
  hero_logo_position: Joi.string().valid('top', 'center', 'bottom'),
  customer_account_ids: Joi.array().items(Joi.number().integer().min(1)),
  ...Object.fromEntries(['is_draft', 'require_password', 'allow_downloads', 'allow_user_uploads',
    'disable_right_click', 'watermark_downloads', 'enable_devtools_protection', 'use_canvas_rendering',
    'feedback_enabled', 'allow_ratings', 'allow_likes', 'allow_comments', 'allow_favorites',
    'allow_reactions', 'allow_color_labels', 'require_name_email', 'moderate_comments',
    'show_feedback_to_guests', 'client_access_enabled', 'og_image_share_enabled', 'show_credits_to_guests']
    .map(key => [key, Joi.boolean().truthy(1, '1').falsy(0, '0')])),
  hero_logo_visible: Joi.boolean().truthy(1, '1').falsy(0, '0').allow(null),
}).unknown(true);

async function validateCreationInput(data) {
  const { value, error } = schema.validate(data, { abortEarly: false });
  if (error) {
    const err = new AppError('Invalid event', 400, 'EVENT_INVALID');
    // Never return Joi's submitted value/context: it can contain passwords.
    err.responseBody = { errors: error.details.map(item => ({ path: item.path.join('.'), msg: item.message })) };
    throw err;
  }
  if (!await eventTypes.isValidEventType(value.event_type)) throw new AppError('Invalid event type', 400, 'EVENT_TYPE_INVALID');
  normaliseEventTimeTriple(value); // Reject before password hashing or filesystem writes.
  return value;
}
module.exports = { validateCreationInput };
