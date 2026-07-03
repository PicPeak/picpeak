/**
 * Custom error classes for standardized error handling across the application.
 * These errors are caught by the global error handler and converted to appropriate HTTP responses.
 */

/**
 * Base class for operational errors (expected errors that can occur during normal operation)
 */
class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      error: this.message,
      code: this.code,
      ...(process.env.NODE_ENV === 'development' && { stack: this.stack })
    };
  }
}

/**
 * Validation error - for invalid input data (400 Bad Request)
 */
class ValidationError extends AppError {
  constructor(message = 'Validation failed', details = null) {
    super(message, 400, 'VALIDATION_ERROR');
    this.details = details;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      ...(this.details && { details: this.details })
    };
  }
}

/**
 * Not found error - for resources that don't exist (404 Not Found)
 */
class NotFoundError extends AppError {
  constructor(resource = 'Resource', identifier = null) {
    const message = identifier
      ? `${resource} with identifier '${identifier}' not found`
      : `${resource} not found`;
    super(message, 404, 'NOT_FOUND');
    this.resource = resource;
    this.identifier = identifier;
  }
}

/**
 * Unauthorized error - for missing or invalid authentication (401 Unauthorized)
 */
class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

/**
 * Forbidden error - for insufficient permissions (403 Forbidden)
 */
class ForbiddenError extends AppError {
  constructor(message = 'Access denied') {
    super(message, 403, 'FORBIDDEN');
  }
}

/**
 * Conflict error - for resource conflicts (409 Conflict)
 */
class ConflictError extends AppError {
  constructor(message = 'Resource conflict', field = null) {
    super(message, 409, 'CONFLICT');
    this.field = field;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      ...(this.field && { field: this.field })
    };
  }
}

/**
 * Rate limit error - for too many requests (429 Too Many Requests)
 */
class RateLimitError extends AppError {
  constructor(message = 'Too many requests', retryAfter = null) {
    super(message, 429, 'RATE_LIMIT_EXCEEDED');
    this.retryAfter = retryAfter;
  }
}

/**
 * Service unavailable error - for maintenance mode or service issues (503 Service Unavailable)
 */
class ServiceUnavailableError extends AppError {
  constructor(message = 'Service temporarily unavailable') {
    super(message, 503, 'SERVICE_UNAVAILABLE');
  }
}

module.exports = {
  AppError,
  ValidationError,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  ConflictError,
  RateLimitError,
  ServiceUnavailableError
};
