/**
 * Admin Accounting routes.
 *
 *   /inbound/*  → Incoming invoices (external supplier invoices). Gated by the
 *                 `incomingInvoices` flag. Disposition, supplier-payment and
 *                 re-bill all act on the document itself.
 *   /           → Expenses (internal). Gated by the `expenses` flag. Create
 *                 accepts an optional proof upload (required when the accounting
 *                 setting says so).
 *   /categories → expense categories. Gated by the `accounting` master.
 *
 * camelCase API; money in integer minor units.
 */
const express = require('express');
const { body, param, query } = require('express-validator');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const { createReadStream } = require('fs');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const { getStoragePath } = require('../config/storage');
const { assertPathInside } = require('../utils/safePath');
const { db } = require('../database/db');
const expenseService = require('../services/expenseService');
const expenseCategoriesService = require('../services/expenseCategoriesService');
const rasterizeService = require('../services/rasterizeService');

const router = express.Router();

const ALLOWED_MIME = ['application/pdf', 'image/jpeg', 'image/png'];

function diskUpload(subdir) {
  return multer({
    storage: multer.diskStorage({
      destination: async (_req, _file, cb) => {
        const dir = path.join(getStoragePath(), 'business-docs', subdir, String(new Date().getFullYear()));
        await fs.mkdir(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (_req, file, cb) => cb(null, `${subdir.split('/').pop()}-${Date.now()}${path.extname(file.originalname) || ''}`),
    }),
    limits: { fileSize: 15 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => (ALLOWED_MIME.includes(file.mimetype) ? cb(null, true) : cb(new Error('Only PDF, JPEG or PNG files are allowed'))),
  });
}
const inboundUpload = diskUpload('inbound');
const proofUpload = diskUpload('expenses/proof');

// Shared cached feature gate (PR #622 nit 2) — replaces the former local copy.
const { requireFeatureFlag } = require('../middleware/requireFeatureFlag');
const requireIncoming = requireFeatureFlag('incomingInvoices', 'INCOMING_INVOICES_DISABLED');
const requireExpenses = requireFeatureFlag('expenses', 'EXPENSES_DISABLED');
const requireAccounting = requireFeatureFlag('accounting', 'ACCOUNTING_DISABLED');

router.use(adminAuth);

const toInt = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : undefined; };

// ── Expense categories (accounting master) ──────────────────────────────────
router.get('/categories', requireAccounting, requirePermission('accounting.view'), handleAsync(async (_req, res) =>
  successResponse(res, { items: await expenseCategoriesService.list() })));

router.post('/categories', requireAccounting, requirePermission('accounting.manage'),
  [body('name').isString().isLength({ min: 1, max: 128 }), body('color').optional({ nullable: true }).isString()],
  handleAsync(async (req, res) => {
    validateRequest(req);
    return successResponse(res, { category: await expenseCategoriesService.create(req.body, req.admin.id) }, 201, 'Category created');
  }));

router.patch('/categories/:id', requireAccounting, requirePermission('accounting.manage'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    return successResponse(res, { category: await expenseCategoriesService.update(toInt(req.params.id), req.body) });
  }));

router.delete('/categories/:id', requireAccounting, requirePermission('accounting.manage'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    return successResponse(res, await expenseCategoriesService.remove(toInt(req.params.id)));
  }));

// ── Incoming invoices (external) ────────────────────────────────────────────
router.post('/inbound', requireIncoming, requirePermission('accounting.manage'),
  inboundUpload.single('file'),
  [body('source').optional().isIn(['upload', 'camera', 'email', 'manual'])],
  handleAsync(async (req, res) => {
    validateRequest(req);
    if (!req.file) return res.status(400).json({ error: 'No file uploaded', code: 'NO_FILE' });
    const document = await expenseService.recordInboundDocument({
      source: req.body.source || 'upload', filePath: req.file.path,
      originalFilename: req.file.originalname, mimeType: req.file.mimetype,
    }, req.admin.id);
    return successResponse(res, { document }, 201, 'Document captured');
  }));

router.get('/inbound', requireIncoming, requirePermission('accounting.view'),
  [query('status').optional().isString(), query('page').optional().isInt({ min: 1 }), query('pageSize').optional().isInt({ min: 1, max: 100 })],
  handleAsync(async (req, res) => { validateRequest(req); return successResponse(res, await expenseService.listInbound(req.query)); }));

// Pending re-bills grouped by customer (per-event customers with categorised
// but not-yet-billed rebill/passthrough docs). Registered BEFORE /inbound/:id
// so the literal path isn't swallowed by the :id param matcher.
router.get('/inbound/pending-summary', requireIncoming, requirePermission('accounting.view'),
  handleAsync(async (_req, res) => successResponse(res, { items: await expenseService.listPendingRebillSummary() })));

// Bundle a customer's pending re-bills into one invoice (per-event only).
router.post('/inbound/bill-pending', requireIncoming, requirePermission('accounting.manage'),
  [body('customerAccountId').isInt({ min: 1 })],
  handleAsync(async (req, res) => { validateRequest(req); return successResponse(res, await expenseService.billPendingRebills(toInt(req.body.customerAccountId), req.admin.id), 201, 'Re-billed'); }));

router.get('/inbound/:id/file', requireIncoming, requirePermission('accounting.view'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const row = await db('inbound_documents').where({ id: toInt(req.params.id) }).first('file_path', 'mime_type');
    if (!row || !row.file_path) return res.status(404).json({ error: 'File not found', code: 'NO_FILE' });
    const safe = assertPathInside(row.file_path, [path.join(getStoragePath(), 'business-docs')]);
    const isPdf = (row.mime_type || '').includes('pdf');
    res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', isPdf ? 'attachment' : 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!isPdf) res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
    createReadStream(safe).pipe(res);
  }));

router.get('/inbound/:id/page/:n', requireIncoming, requirePermission('accounting.view'),
  [param('id').isInt({ min: 1 }), param('n').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const id = toInt(req.params.id);
    const row = await db('inbound_documents').where({ id }).first('file_path', 'mime_type', 'page_count');
    if (!row || !row.file_path) return res.status(404).json({ error: 'File not found', code: 'NO_FILE' });
    if (!(row.mime_type || '').includes('pdf')) return res.status(415).json({ error: 'Not a PDF', code: 'NOT_PDF' });
    const page = Math.min(Math.max(1, toInt(req.params.n)), row.page_count || 1);
    const srcPdf = assertPathInside(row.file_path, [path.join(getStoragePath(), 'business-docs')]);
    const pngPath = await rasterizeService.getRenderedPagePath(id, srcPdf, page);
    const safePng = assertPathInside(pngPath, [path.join(getStoragePath(), 'business-docs')]);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
    createReadStream(safePng).pipe(res);
  }));

router.get('/inbound/:id', requireIncoming, requirePermission('accounting.view'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => { validateRequest(req); return successResponse(res, { document: await expenseService.getInbound(toInt(req.params.id)) }); }));

router.patch('/inbound/:id', requireIncoming, requirePermission('accounting.manage'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => { validateRequest(req); return successResponse(res, { document: await expenseService.updateInbound(toInt(req.params.id), req.body, req.admin.id) }); }));

router.post('/inbound/:id/categorize', requireIncoming, requirePermission('accounting.manage'),
  [param('id').isInt({ min: 1 }), body('disposition').isIn(expenseService.DISPOSITIONS),
    body('customerAccountId').optional({ nullable: true }).isInt({ min: 1 }),
    body('eventId').optional({ nullable: true }).isInt({ min: 1 }),
    body('categoryId').optional({ nullable: true }).isInt({ min: 1 }),
    body('markupType').optional().isIn(expenseService.MARKUP_TYPES)],
  handleAsync(async (req, res) => { validateRequest(req); return successResponse(res, { document: await expenseService.categorizeInbound(toInt(req.params.id), req.body, req.admin.id) }, 200, 'Categorized'); }));

router.post('/inbound/:id/rebill', requireIncoming, requirePermission('accounting.manage'),
  [param('id').isInt({ min: 1 }), body('customerAccountId').isInt({ min: 1 }),
    body('eventId').optional({ nullable: true }).isInt({ min: 1 }), body('contractId').optional({ nullable: true }).isInt({ min: 1 }),
    body('markupType').optional().isIn(expenseService.MARKUP_TYPES)],
  handleAsync(async (req, res) => { validateRequest(req); return successResponse(res, await expenseService.rebillInbound(toInt(req.params.id), req.body, req.admin.id), 201, 'Re-billed'); }));

router.post('/inbound/:id/supplier-payment', requireIncoming, requirePermission('accounting.manage'),
  [param('id').isInt({ min: 1 }), body('paid').isBoolean(), body('paymentMethod').optional({ nullable: true }).isIn(expenseService.PAYMENT_METHODS)],
  handleAsync(async (req, res) => { validateRequest(req); return successResponse(res, { document: await expenseService.markInboundSupplierPayment(toInt(req.params.id), req.body, req.admin.id) }); }));

// ── Expenses (internal) ─────────────────────────────────────────────────────
router.get('/', requireExpenses, requirePermission('accounting.view'),
  [query('kind').optional().isIn(expenseService.EXPENSE_KINDS), query('categoryId').optional().isInt({ min: 1 }),
    query('page').optional().isInt({ min: 1 }), query('pageSize').optional().isInt({ min: 1, max: 100 })],
  handleAsync(async (req, res) => { validateRequest(req); return successResponse(res, await expenseService.listExpenses(req.query)); }));

router.post('/', requireExpenses, requirePermission('accounting.manage'),
  proofUpload.single('proof'),
  [body('kind').optional().isIn(expenseService.EXPENSE_KINDS)],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const b = req.body;
    const payload = {
      kind: b.kind || 'amount',
      quantity: b.quantity !== undefined && b.quantity !== '' ? Number(b.quantity) : undefined,
      rateMinor: toInt(b.rateMinor),
      chfAmountMinor: toInt(b.chfAmountMinor),
      eventId: toInt(b.eventId) || null,
      categoryId: toInt(b.categoryId) || null,
      supplierName: b.supplierName || null,
      description: b.description || null,
      taxTreatment: b.taxTreatment,
    };
    const expense = await expenseService.createExpense(payload, req.admin.id, { receiptPath: req.file ? req.file.path : null });
    return successResponse(res, { expense }, 201, 'Expense created');
  }));

router.get('/:id/proof', requireExpenses, requirePermission('accounting.view'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const row = await db('expenses').where({ id: toInt(req.params.id) }).first('receipt_path');
    if (!row || !row.receipt_path) return res.status(404).json({ error: 'No proof', code: 'NO_PROOF' });
    const safe = assertPathInside(row.receipt_path, [path.join(getStoragePath(), 'business-docs')]);
    const isPdf = safe.toLowerCase().endsWith('.pdf');
    res.setHeader('Content-Type', isPdf ? 'application/pdf' : 'application/octet-stream');
    res.setHeader('Content-Disposition', isPdf ? 'attachment' : 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!isPdf) res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
    createReadStream(safe).pipe(res);
  }));

router.get('/:id', requireExpenses, requirePermission('accounting.view'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => { validateRequest(req); return successResponse(res, { expense: await expenseService.getExpense(toInt(req.params.id)) }); }));

router.patch('/:id', requireExpenses, requirePermission('accounting.manage'),
  proofUpload.single('proof'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const expense = await expenseService.updateExpense(toInt(req.params.id), req.body, req.admin.id, { receiptPath: req.file ? req.file.path : null });
    return successResponse(res, { expense });
  }));

// Add an expense onto a client invoice -> marks it invoiced (locks editing).
router.post('/:id/invoice', requireExpenses, requirePermission('accounting.manage'),
  [param('id').isInt({ min: 1 }), body('customerAccountId').isInt({ min: 1 }),
    body('eventId').optional({ nullable: true }).isInt({ min: 1 }), body('contractId').optional({ nullable: true }).isInt({ min: 1 }),
    body('markupType').optional().isIn(expenseService.MARKUP_TYPES)],
  handleAsync(async (req, res) => {
    validateRequest(req);
    return successResponse(res, await expenseService.rebillExpense(toInt(req.params.id), req.body, req.admin.id), 201, 'Expense invoiced');
  }));

// Mark an expense paid / settled (manual).
router.post('/:id/paid', requireExpenses, requirePermission('accounting.manage'),
  [param('id').isInt({ min: 1 }), body('paid').isBoolean(), body('paymentMethod').optional({ nullable: true }).isIn(expenseService.PAYMENT_METHODS)],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const expense = await expenseService.markExpensePaid(toInt(req.params.id), req.body, req.admin.id);
    return successResponse(res, { expense });
  }));

module.exports = router;
