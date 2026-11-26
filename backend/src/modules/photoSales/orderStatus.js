'use strict';

/**
 * Order status groups of photo_purchase_orders, shared by both checkout
 * providers, the reconciler and the admin views.
 */

/** Reserved and not yet settled: the checkout may still be paid. */
const OPEN = ['pending', 'creation_unknown', 'processing'];

/** Paid but refused by PicPeak: a refund is pending or failed. */
const REFUSING = ['refund_pending', 'refund_failed'];

module.exports = { OPEN, REFUSING };
