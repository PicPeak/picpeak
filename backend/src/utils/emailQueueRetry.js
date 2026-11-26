'use strict';

/**
 * How many times the email queue tries a row before leaving it pending as
 * retry-exhausted. The processor's pending query, the campaign bookkeeping,
 * the boot recovery of template-less rows and the admin health views all
 * read this one number.
 */
const EMAIL_MAX_ATTEMPTS = 3;

module.exports = { EMAIL_MAX_ATTEMPTS };
