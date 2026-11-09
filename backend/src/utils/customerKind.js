'use strict';

/**
 * Is a customer a business or a consumer? Consumer law (the 14-day
 * cancellation right) and the B2B late-payment notice turn on it (issue 2439).
 *
 * The admin can say so on the customer (customer_accounts.customer_kind,
 * migration 352). Left on automatic (null), a customer with a company name or
 * a VAT ID counts as a business, everyone else as a consumer.
 */

const CUSTOMER_KINDS = ['business', 'consumer'];

function isBusinessCustomer(customer) {
  if (!customer) return false;
  if (customer.customer_kind === 'business') return true;
  if (customer.customer_kind === 'consumer') return false;
  const filled = (v) => typeof v === 'string' && v.trim().length > 0;
  return filled(customer.company_name) || filled(customer.vat_id);
}

module.exports = { CUSTOMER_KINDS, isBusinessCustomer };
