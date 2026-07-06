/**
 * Admin → deals lineage endpoint.
 *
 * One UUID per customer engagement spans every quote, contract, and
 * invoice (migration 140). This route exposes the union: given a
 * deal_uuid, return every related document so the frontend's
 * DocumentLineageCard can render the full chain with a single query
 * instead of walking the legacy point-to-point FKs in JS.
 *
 * Read-only. The same `customers.view` permission used elsewhere for
 * lineage display is the gate here — anyone who can read a quote or
 * invoice detail page can read its deal lineage.
 *
 * Sibling routes (`/api/admin/quotes/:id/lineage`,
 * `/api/admin/contracts/:id/lineage`, `/api/admin/invoices/:id/lineage`)
 * also exist as conveniences so the frontend doesn't have to fetch
 * the deal_uuid first; they resolve and delegate to the same service.
 */

const express = require('express');
const { param, body } = require('express-validator');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { requireFeatureFlag } = require('../middleware/requireFeatureFlag');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const dealsService = require('../services/dealsService');
const invoiceService = require('../services/invoiceService');
const { db } = require('../database/db');

const router = express.Router();
router.use(adminAuth);

router.get(
  '/:uuid/documents',
  requirePermission('customers.view'),
  // UUID v4 format check — adminCalendar uses a similar pattern.
  // Length window 32–36 covers both hyphenated and non-hyphenated
  // forms; the service does the actual lookup.
  [param('uuid').isString().isLength({ min: 32, max: 36 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const result = await dealsService.getDealDocuments(req.params.uuid);
    return successResponse(res, result);
  }),
);

/**
 * Atomically reshape an installment plan after siblings have spawned.
 * Delegates to invoiceService.updateInstallmentPlan inside a transaction.
 * See that service function for the guard/reuse/grow/trim semantics.
 *
 * 400 — invalid input (validator or service-side percent sum / unknown
 *       trigger / single-invoice deal).
 * 404 — deal_uuid owns no invoices.
 * 409 — at least one sibling is past `scheduled`/`pending_delivery`, or
 *       the deal contains a Storno.
 */
router.put(
  '/:uuid/installment-plan',
  // Mutates invoices — gate on the bills flag like every other invoice
  // write path, so installment plans can't be reshaped with Bills off.
  requireFeatureFlag('bills', 'BILLS_DISABLED'),
  requirePermission('bills.manage'),
  [
    param('uuid').isString().isLength({ min: 32, max: 36 }),
    body('installments').isArray({ min: 1 }),
    body('installments.*.percent').isFloat({ min: 0, max: 100 }),
    body('installments.*.trigger').isIn([
      'quote_accepted', 'before_event', 'after_event', 'after_delivery', 'fixed_date',
    ]),
    body('installments.*.offset_days').isInt(),
    body('installments.*.label').optional({ values: 'falsy' }).isString().isLength({ max: 200 }),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const adminId = req.admin?.id;
    const result = await db.transaction((trx) => invoiceService.updateInstallmentPlan({
      trx,
      dealUuid: req.params.uuid,
      installments: req.body.installments,
      adminId,
    }));
    return successResponse(res, result);
  }),
);

module.exports = router;
