/**
 * Route helper utilities for standardized request handling.
 * Provides async error wrapping, validation, and response formatting.
 */

const { validationResult } = require('express-validator');
const { ValidationError } = require('./errors');

/**
 * Wraps an async route handler to catch errors and pass them to the error handler.
 * Eliminates the need for try/catch blocks in every route.
 *
 * @param {Function} fn - Async route handler function
 * @returns {Function} Express middleware function
 *
 * @example
 * router.get('/events', handleAsync(async (req, res) => {
 *   const events = await eventService.getAll();
 *   res.json(events);
 * }));
 */
const handleAsync = (fn) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

/**
 * Validates the request using express-validator and throws ValidationError if invalid.
 * Should be called at the beginning of route handlers after validation middleware.
 *
 * @param {Request} req - Express request object
 * @throws {ValidationError} If validation fails
 *
 * @example
 * router.post('/events', [
 *   body('name').notEmpty(),
 *   body('date').isDate()
 * ], handleAsync(async (req, res) => {
 *   validateRequest(req);
 *   // ... rest of handler
 * }));
 */
const validateRequest = (req) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const errorDetails = errors.array().map(err => ({
      field: err.path || err.param,
      message: err.msg
    }));
    throw new ValidationError('Validation failed', errorDetails);
  }
};

/**
 * Sends a standardized success response.
 *
 * @param {Response} res - Express response object
 * @param {*} data - Data to send in the response
 * @param {number} [statusCode=200] - HTTP status code
 * @param {string} [message] - Optional success message
 *
 * @example
 * successResponse(res, { event }, 201, 'Event created successfully');
 */
const successResponse = (res, data, statusCode = 200, message = null) => {
  const response = message ? { message, ...data } : data;
  res.status(statusCode).json(response);
};

/**
 * Sends a standardized error response.
 * Note: Prefer throwing custom errors and letting the error handler format the response.
 *
 * @param {Response} res - Express response object
 * @param {string} message - Error message
 * @param {number} [statusCode=500] - HTTP status code
 * @param {string} [code] - Optional error code
 * @param {*} [details] - Optional additional error details
 *
 * @example
 * errorResponse(res, 'Invalid input', 400, 'VALIDATION_ERROR', { field: 'email' });
 */
const errorResponse = (res, message, statusCode = 500, code = null, details = null) => {
  const response = {
    error: message,
    ...(code && { code }),
    ...(details && { details })
  };
  res.status(statusCode).json(response);
};

/**
 * Creates a route handler with built-in validation.
 * Combines handleAsync and validateRequest for cleaner route definitions.
 *
 * @param {Function} fn - Async route handler function
 * @returns {Function} Express middleware function
 *
 * @example
 * router.post('/events', [
 *   body('name').notEmpty()
 * ], withValidation(async (req, res) => {
 *   const event = await eventService.create(req.body);
 *   successResponse(res, { event }, 201);
 * }));
 */
const withValidation = (fn) => {
  return handleAsync(async (req, res, next) => {
    validateRequest(req);
    return fn(req, res, next);
  });
};

/**
 * Extracts pagination parameters from query string with defaults.
 *
 * @param {Request} req - Express request object
 * @param {Object} [defaults] - Default values
 * @param {number} [defaults.page=1] - Default page number
 * @param {number} [defaults.limit=20] - Default items per page
 * @param {number} [defaults.maxLimit=100] - Maximum allowed limit
 * @returns {{ page: number, limit: number, offset: number }}
 *
 * @example
 * const { page, limit, offset } = getPagination(req);
 * const events = await db('events').limit(limit).offset(offset);
 */
const getPagination = (req, defaults = {}) => {
  const { page: defaultPage = 1, limit: defaultLimit = 20, maxLimit = 100 } = defaults;

  let page = parseInt(req.query.page, 10) || defaultPage;
  let limit = parseInt(req.query.limit, 10) || defaultLimit;

  // Ensure valid values
  page = Math.max(1, page);
  limit = Math.min(Math.max(1, limit), maxLimit);

  const offset = (page - 1) * limit;

  return { page, limit, offset };
};

/**
 * Creates a paginated response with metadata.
 *
 * @param {*} data - Data array
 * @param {number} total - Total count of items
 * @param {number} page - Current page
 * @param {number} limit - Items per page
 * @returns {Object} Paginated response object
 *
 * @example
 * const events = await db('events').limit(limit).offset(offset);
 * const total = await db('events').count('* as count').first();
 * res.json(paginatedResponse(events, total.count, page, limit));
 */
const paginatedResponse = (data, total, page, limit) => {
  const totalPages = Math.ceil(total / limit);
  return {
    data,
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasMore: page < totalPages
    }
  };
};

module.exports = {
  handleAsync,
  validateRequest,
  successResponse,
  errorResponse,
  withValidation,
  getPagination,
  paginatedResponse
};
