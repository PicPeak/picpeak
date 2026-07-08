const { body, param, validationResult } = require('express-validator');
const validator = require('validator');
const { IDENTITY_PRESERVING_NORMALIZE_EMAIL } = require('./emailNormalization');

/**
 * Validation rules for feedback submission
 */
const feedbackValidationRules = {
  rating: [
    body('feedback_type').equals('rating'),
    body('rating')
      .isInt({ min: 1, max: 5 })
      .withMessage('Rating must be between 1 and 5'),
    body('guest_name')
      .optional()
      .trim()
      .isLength({ max: 100 })
      .withMessage('Name must be less than 100 characters'),
    body('guest_email')
      .optional()
      .trim()
      .isEmail()
      .normalizeEmail(IDENTITY_PRESERVING_NORMALIZE_EMAIL)
      .withMessage('Invalid email address')
  ],
  
  like: [
    body('feedback_type').equals('like'),
    body('guest_name')
      .optional()
      .trim()
      .isLength({ max: 100 }),
    body('guest_email')
      .optional()
      .trim()
      .isEmail()
      .normalizeEmail(IDENTITY_PRESERVING_NORMALIZE_EMAIL)
  ],
  
  favorite: [
    body('feedback_type').equals('favorite'),
    body('guest_name')
      .optional()
      .trim()
      .isLength({ max: 100 }),
    body('guest_email')
      .optional()
      .trim()
      .isEmail()
      .normalizeEmail(IDENTITY_PRESERVING_NORMALIZE_EMAIL)
  ],
  
  comment: [
    body('feedback_type').equals('comment'),
    body('comment_text')
      .trim()
      .notEmpty()
      .withMessage('Comment cannot be empty')
      .isLength({ min: 1, max: 1000 })
      .withMessage('Comment must be between 1 and 1000 characters')
      .customSanitizer(value => sanitizeComment(value)),
    body('guest_name')
      .optional()
      .trim()
      .isLength({ max: 100 })
      .withMessage('Name must be less than 100 characters'),
    body('guest_email')
      .optional()
      .trim()
      .isEmail()
      .normalizeEmail(IDENTITY_PRESERVING_NORMALIZE_EMAIL)
      .withMessage('Invalid email address')
  ]
};

/**
 * Sanitize comment text
 */
function sanitizeComment(text) {
  if (!text) return '';
  
  // Remove excessive whitespace
  text = text.replace(/\s+/g, ' ').trim();
  
  // Remove zero-width characters
  text = text.replace(/[\u200B-\u200D\uFEFF]/g, '');
  
  // Remove control characters
  text = text.replace(/[\x00-\x1F\x7F]/g, '');
  
  // Limit consecutive special characters
  text = text.replace(/([!?.]){4,}/g, '$1$1$1');
  
  // Remove script tags and other dangerous HTML (basic sanitization)
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '');
  text = text.replace(/<object[^>]*>[\s\S]*?<\/object>/gi, '');
  text = text.replace(/<embed[^>]*>/gi, '');
  
  return text;
}

/**
 * Validate feedback type parameter
 */
const validateFeedbackType = param('feedbackType')
  .isIn(['rating', 'like', 'comment', 'favorite'])
  .withMessage('Invalid feedback type');

/**
 * Validate photo ID parameter
 */
const validatePhotoId = param('photoId')
  .isInt({ min: 1 })
  .withMessage('Invalid photo ID');

/**
 * Validate event ID parameter
 */
const validateEventId = param('eventId')
  .isInt({ min: 1 })
  .withMessage('Invalid event ID');

/**
 * Get validation rules based on feedback type
 */
function getValidationRules(feedbackType) {
  return feedbackValidationRules[feedbackType] || [];
}

/**
 * Validation middleware for feedback submission
 */
const validateFeedbackSubmission = [
  body('feedback_type')
    .isIn(['rating', 'like', 'comment', 'favorite'])
    .withMessage('Invalid feedback type'),
  
  // Conditional validation based on feedback type
  body('rating')
    .if(body('feedback_type').equals('rating'))
    .isInt({ min: 1, max: 5 })
    .withMessage('Rating must be between 1 and 5'),
  
  body('comment_text')
    .if(body('feedback_type').equals('comment'))
    .trim()
    .notEmpty()
    .withMessage('Comment cannot be empty')
    .isLength({ min: 1, max: 1000 })
    .withMessage('Comment must be between 1 and 1000 characters')
    .customSanitizer(value => sanitizeComment(value)),
  
  body('guest_name')
    .optional()
    .custom((value) => {
      // Allow empty or whitespace-only strings
      if (!value || value.trim() === '') return true;
      // If not empty, check length and pattern
      const trimmed = value.trim();
      if (trimmed.length > 100) throw new Error('Name must be less than 100 characters');
      if (!/^[a-zA-Z0-9\s\-'.]+$/.test(trimmed)) throw new Error('Name contains invalid characters');
      return true;
    }),
  
  body('guest_email')
    .optional()
    .custom((value) => {
      // Allow empty or whitespace-only strings
      if (!value || value.trim() === '') return true;
      // If not empty, validate as email
      if (!validator.isEmail(value.trim())) throw new Error('Invalid email address');
      return true;
    })
];

/**
 * Validation for feedback settings
 */
const validateFeedbackSettings = [
  body('feedback_enabled').optional().isBoolean(),
  body('allow_ratings').optional().isBoolean(),
  body('allow_likes').optional().isBoolean(),
  body('allow_comments').optional().isBoolean(),
  body('allow_favorites').optional().isBoolean(),
  body('require_name_email').optional().isBoolean(),
  body('moderate_comments').optional().isBoolean(),
  body('show_feedback_to_guests').optional().isBoolean(),
  body('identity_mode').optional().isIn(['simple', 'guest'])
    .withMessage('identity_mode must be "simple" or "guest"'),
  // Per-guest caps (#655). null / 0 = unlimited; positive integers enforced.
  // Upper bound is intentionally generous — operators occasionally run
  // "everyone, pick everything you like" galleries.
  body('max_favorites_per_guest')
    .optional({ nullable: true })
    .custom((v) => v === null || (Number.isInteger(v) && v >= 0 && v <= 10000))
    .withMessage('max_favorites_per_guest must be null or an integer between 0 and 10000'),
  body('max_likes_per_guest')
    .optional({ nullable: true })
    .custom((v) => v === null || (Number.isInteger(v) && v >= 0 && v <= 10000))
    .withMessage('max_likes_per_guest must be null or an integer between 0 and 10000'),
];

/**
 * Validation for word filters
 */
const validateWordFilter = [
  body('word')
    .trim()
    .notEmpty()
    .withMessage('Word cannot be empty')
    .isLength({ min: 2, max: 100 })
    .withMessage('Word must be between 2 and 100 characters'),
  body('severity')
    .optional()
    .isIn(['mild', 'moderate', 'severe'])
    .withMessage('Invalid severity level')
];

/**
 * Check validation results middleware
 */
const checkValidation = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: 'Validation failed',
      errors: errors.array()
    });
  }
  next();
};

/**
 * Validate guest identity requirements
 */
async function validateGuestRequirements(settings, guestData) {
  if (!settings.require_name_email) {
    return { valid: true };
  }
  
  const errors = [];
  
  // Check for name - handle both undefined and empty strings
  const name = guestData.guest_name;
  if (!name || (typeof name === 'string' && name.trim().length === 0)) {
    errors.push('Name is required');
  }
  
  // Check for email - handle both undefined and empty strings  
  const email = guestData.guest_email;
  if (!email || (typeof email === 'string' && email.trim().length === 0)) {
    errors.push('Email is required');
  } else if (email && typeof email === 'string' && !validator.isEmail(email.trim())) {
    errors.push('Valid email is required');
  }
  
  if (errors.length > 0) {
    return {
      valid: false,
      errors
    };
  }
  
  return { valid: true };
}

module.exports = {
  feedbackValidationRules,
  validateFeedbackType,
  validatePhotoId,
  validateEventId,
  validateFeedbackSubmission,
  validateFeedbackSettings,
  validateWordFilter,
  checkValidation,
  getValidationRules,
  sanitizeComment,
  validateGuestRequirements
};