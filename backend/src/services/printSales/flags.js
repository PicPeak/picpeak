'use strict';

/**
 * Print sales need all three of these feature flags: print ordering builds
 * on album products and bills through the invoice code.
 */
const PRINT_SALES_FLAGS = ['printSales', 'albumProducts', 'bills'];

/** The route middleware for PRINT_SALES_FLAGS, one gate per flag. */
function requirePrintSalesFlags() {
  const { requireFeatureFlag } = require('../../middleware/requireFeatureFlag');
  return PRINT_SALES_FLAGS.map((flag) => requireFeatureFlag(flag));
}

module.exports = { PRINT_SALES_FLAGS, requirePrintSalesFlags };
