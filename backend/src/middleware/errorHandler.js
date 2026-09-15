const { requestLogPath } = require('../utils/requestLogPath');
/**
 * Global error handler middleware.
 * Catches all errors and returns standardized responses.
 * Distinguishes between operational errors (expected) and programming errors (bugs).
 */

const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');

/**
 * Determines if an error is operational (expected) or a programming error (bug).
 * Operational errors are expected failures like validation errors, not found, etc.
 * Programming errors are bugs that should be logged and investigated.
 *
 * @param {Error} err - The error to check
 * @returns {boolean} True if operational error
 */
const isOperationalError = (err) => {
  return err instanceof AppError && err.isOperational;
};

/**
 * Formats error for development environment (includes stack trace).
 *
 * @param {Error} err - The error object
 * @returns {Object} Formatted error response
 */
const formatDevError = (err) => {
  return {
    error: err.message,
    code: err.code || 'INTERNAL_ERROR',
    stack: err.stack,
    ...(err.details && { details: err.details }),
    ...(err.field && { field: err.field })
  };
};

/**
 * Formats error for production environment (hides sensitive details).
 *
 * @param {Error} err - The error object
 * @param {boolean} isOperational - Whether this is an operational error
 * @returns {Object} Formatted error response
 */
const formatProdError = (err, isOperational) => {
  // For operational errors, show the message
  if (isOperational) {
    return {
      error: err.message,
      code: err.code || 'ERROR',
      ...(err.details && { details: err.details }),
      ...(err.field && { field: err.field })
    };
  }

  // For programming errors, hide details
  return {
    error: 'An unexpected error occurred',
    code: 'INTERNAL_ERROR'
  };
};

/**
 * Handles specific error types and converts them to AppError format.
 *
 * @param {Error} err - The error to handle
 * @returns {Error} Converted error or original error
 */
const handleKnownErrors = (err) => {
  // Handle Knex/Database errors
  if (err.code === 'SQLITE_CONSTRAINT' || err.code === '23505') {
    const { AppError } = require('../utils/errors');
    const error = new AppError('A record with this value already exists', 409, 'DUPLICATE_ENTRY');
    error.isOperational = true;
    return error;
  }

  // Handle JSON parsing errors
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    const { ValidationError } = require('../utils/errors');
    return new ValidationError('Invalid JSON in request body');
  }

  // Handle multer file upload errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    const { ValidationError } = require('../utils/errors');
    return new ValidationError('File size exceeds the maximum allowed limit');
  }

  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    const { ValidationError } = require('../utils/errors');
    return new ValidationError('Unexpected file field');
  }

  // CVE-2026-82333: multer 2.3.0's fieldArrayIndexLimit rejects multipart
  // field names with an oversized bracket array index (e.g. `a[99999999]`)
  // before the DoS-prone field parser runs. Without this mapping the
  // resulting MulterError has no .statusCode/.status and falls through to
  // a 500 here, so map it to a proper 400 like the other multer limits.
  if (err.code === 'LIMIT_FIELD_ARRAY_INDEX') {
    const { ValidationError } = require('../utils/errors');
    return new ValidationError('Field name array index too large');
  }

  return err;
};

/**
 * Global error handler middleware.
 * Must be registered last, after all routes.
 *
 * @param {Error} err - The error object
 * @param {Request} req - Express request object
 * @param {Response} res - Express response object
 * @param {Function} next - Express next function
 */
const errorHandler = (err, req, res, next) => {
  // If headers already sent, delegate to Express default handler
  if (res.headersSent) {
    return next(err);
  }

  // Convert known error types
  const error = handleKnownErrors(err);

  // Determine error status code
  const statusCode = error.statusCode || error.status || 500;
  const operational = isOperationalError(error);

  // Log the error
  const logContext = {
    url: requestLogPath(req.originalUrl),
    method: req.method,
    ip: req.ip,
    statusCode,
    errorCode: error.code,
    operational,
    // Same id the client gets in the response, so a reported failure can be
    // found in the log (middleware/requestId.js).
    ...(req.id && { requestId: req.id }),
    ...(req.admin && { adminId: req.admin.id }),
    ...(req.gallerySlug && { gallerySlug: req.gallerySlug })
  };

  if (operational) {
    // Operational errors are expected, log at warn level
    logger.warn('Operational error', {
      ...logContext,
      message: error.message
    });
  } else {
    // Programming errors are bugs, log at error level with stack.
    // errorClass is the driver/error code (e.g. SQLITE_BUSY, 42P01) or the
    // constructor name: enough to count failures by kind without logging
    // request content.
    logger.error('Unhandled error', {
      ...logContext,
      errorClass: error.code || error.name,
      message: error.message,
      stack: error.stack
    });
  }

  // Format and send response
  const isDev = process.env.NODE_ENV === 'development';
  const response = isDev ? formatDevError(error) : formatProdError(error, operational);

  res.status(statusCode).json(req.id ? { ...response, requestId: req.id } : response);
};

/**
 * 404 handler for undefined routes.
 * Should be registered after all routes but before errorHandler.
 *
 * @param {Request} req - Express request object
 * @param {Response} res - Express response object
 * @param {Function} next - Express next function
 */
const notFoundHandler = (req, res, next) => {
  const { NotFoundError } = require('../utils/errors');
  next(new NotFoundError('Route', requestLogPath(req.originalUrl)));
};

/**
 * Async handler that catches unhandled promise rejections.
 * Use this to wrap async route handlers.
 *
 * @param {Function} fn - Async function to wrap
 * @returns {Function} Wrapped function
 */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = {
  errorHandler,
  notFoundHandler,
  asyncHandler,
  isOperationalError
};
