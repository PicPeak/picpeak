/**
 * Read-only VAT-code registry for the invoice / quote editors.
 *
 * Mounted at /api/admin/vat-codes. UN-gated by the `accounting` flag on purpose:
 * invoices need their preset VAT codes even when the accounting layer is off, so
 * the editor must be able to read the list regardless. Any authenticated admin
 * may read the (innocuous) tax-code list. MANAGEMENT (create/update/delete) stays
 * in the accounting-gated /api/admin/ledger routes — this is read-only.
 *
 *   GET /  [?direction=output|input]  → { items: [{ id, code, name, rate, direction }] }
 */
const express = require('express');
const { adminAuth } = require('../middleware/auth');
const { handleAsync, successResponse } = require('../utils/routeHelpers');
const ledgerService = require('../services/ledgerService');

const router = express.Router();

router.get('/', adminAuth, handleAsync(async (req, res) => {
  const items = await ledgerService.listVatCodes();
  const active = items.filter((v) => v.active !== false);
  const { direction } = req.query;
  const filtered = (direction === 'output' || direction === 'input')
    ? active.filter((v) => v.direction === direction)
    : active;
  return successResponse(res, {
    items: filtered.map((v) => ({
      id: v.id, code: v.code, name: v.name, rate: Number(v.rate) || 0, direction: v.direction,
    })),
  });
}));

module.exports = router;
