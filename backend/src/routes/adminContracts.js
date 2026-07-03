/**
 * Admin → Contracts Routes
 *
 * Endpoint mounted at /api/admin/contracts. Surface:
 *   GET    /                            list (filter + sort + paginate)
 *   POST   /                            create (status=draft, seeded with all active system blocks)
 *   GET    /:id                         detail (contract + included blocks)
 *   PUT    /:id                         update (block toggles + scalars; draft only)
 *   POST   /:id/send                    render PDF + mint token + queue email
 *   POST   /:id/cancel                  cancel (draft|sent)
 *   POST   /:id/countersign             admin in-browser counter-signature
 *   POST   /:id/upload-signed-pdf       attach wet-signed PDF (multer single)
 *   GET    /:id/pdf                     download / preview the system PDF
 *   GET    /:id/signed-pdf              download the wet-signed PDF (when present)
 *   GET    /:id/preview                 render fresh PDF for preview (no DB write)
 *   GET    /blocks                      list block library
 *   POST   /blocks                      create admin-authored block
 *   PUT    /blocks/:id                  update a block (system blocks: body remains editable)
 *   DELETE /blocks/:id                  delete an admin-authored block (system blocks refuse)
 *
 * Permissions: `contracts.view` for reads, `contracts.manage` for writes.
 * The global `contracts` feature flag is checked at the route layer.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { assertContractPdfPath } = require('../utils/safePath');
const { body, param, query } = require('express-validator');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const { validateFileType } = require('../utils/fileSecurityUtils');
const contractService = require('../services/contractService');
const contractBlocksService = require('../services/contractBlocksService');
const { db } = require('../database/db');

const router = express.Router();

// ----- feature flag gate (admin global) -------------------------------
async function requireContractsFlag(req, res, next) {
  try {
    const row = await db('feature_flags').where({ key: 'contracts' }).first();
    const enabled = row && (row.value === true || row.value === 1 || row.value === '1');
    if (!enabled) {
      return res.status(403).json({ error: 'Contracts feature is disabled', code: 'CONTRACTS_DISABLED' });
    }
    next();
  } catch (err) {
    next(err);
  }
}

router.use(adminAuth);
router.use(requireContractsFlag);

// ----- multer upload (wet-signed PDF) --------------------------------
const getStoragePath = () => process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');

const signedPdfStorage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = path.join(getStoragePath(), 'uploads/contracts/signed');
    fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.pdf';
    cb(null, `contract-${req.params.id}-${Date.now()}${ext}`);
  },
});

const signedPdfUpload = multer({
  storage: signedPdfStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf'];
    if (validateFileType(file.originalname, file.mimetype, allowed)) return cb(null, true);
    return cb(new Error('Only PDF files are allowed'));
  },
});

// ---------------------------------------------------------------------
// Transforms (snake_case DB → camelCase API)
// ---------------------------------------------------------------------

function transformContract(c, inclusions) {
  if (!c) return null;
  return {
    id: c.id,
    contractNumber: c.contract_number,
    customerAccountId: c.customer_account_id,
    // Migration 121 — Project Overview link (undefined on pre-121 DBs).
    projectId: c.project_id ?? null,
    customer: {
      email: c.customer_email,
      displayName: c.customer_display_name,
      firstName: c.customer_first_name,
      lastName: c.customer_last_name,
      companyName: c.customer_company_name,
      preferredLanguage: c.customer_preferred_language,
    },
    status: c.status,
    // Migration 140 — cross-document lineage UUID. See adminQuotes
    // transform for the same note; lets the lineage card fetch every
    // related doc in one query.
    dealUuid: c.deal_uuid || null,
    language: c.language,
    issueDate: c.issue_date,
    validUntil: c.valid_until,
    title: c.title,
    // Event snapshot fields (migration 130 in-place edit). Null when
    // the standalone contract didn't set them OR when the column
    // hasn't migrated yet on this install — the API surface stays
    // stable either way.
    eventName: c.event_name || null,
    eventDate: c.event_date || null,
    eventTimeStart: c.event_time_start || null,
    eventTimeEnd: c.event_time_end || null,
    introText: c.intro_text,
    outroText: c.outro_text,
    pdfPath: c.pdf_path,
    signedPdfPath: c.signed_pdf_path,
    // Audit defence: SHA-256 hashes of the on-disk PDFs computed at
    // each write. Either party can re-hash the PDF they hold and
    // compare against these to prove the file hasn't been tampered
    // with since we issued it.
    pdfSha256: c.pdf_sha256 || null,
    signedPdfSha256: c.signed_pdf_sha256 || null,
    // Migration 136 — surface the post-sign re-stamp failure marker so
    // the admin detail page can render a recovery banner. Null when
    // the most recent stamp succeeded (or the migration hasn't run on
    // this install — the front-end branches on truthiness).
    signedPdfRenderFailedAt: c.signed_pdf_render_failed_at || null,
    signedPdfRenderError: c.signed_pdf_render_error || null,
    sentAt: c.sent_at,
    signedByCustomerAt: c.signed_by_customer_at,
    signedByAdminAt: c.signed_by_admin_at,
    signedCustomerName: c.signed_customer_name,
    signedCustomerIp: c.signed_customer_ip,
    signedCustomerSignaturePath: c.signed_customer_signature_path,
    signedAdminName: c.signed_admin_name,
    signedAdminIp: c.signed_admin_ip,
    signedAdminSignaturePath: c.signed_admin_signature_path,
    createdByAdminId: c.created_by_admin_id,
    // Lineage back-pointers (migration 130). Surfaced so the
    // ContractDetailPage can render "Linked quote" + "Linked
    // invoices" panels alongside the existing block list. The
    // values are nullable when the back-pointers haven't been
    // populated (e.g. dev DB without the column migration; the
    // service writes them through hasColumn guards).
    sourceQuoteId: c.source_quote_id || null,
    convertedEventId: c.converted_event_id || null,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    inclusions: Array.isArray(inclusions)
      ? inclusions.map((inc) => ({
          id: inc.id,
          blockId: inc.block_id,
          section: inc.section,
          position: inc.position,
          included: inc.included === true || inc.included === 1 || inc.included === '1',
          block: {
            slug: inc.block_slug,
            name: inc.block_name,
            description: inc.block_description,
            bodyText: inc.block_body_text,
            bodyTextDe: inc.block_body_text_de,
            isSystem: inc.block_is_system === true || inc.block_is_system === 1 || inc.block_is_system === '1',
          },
          bodyTextSnapshot: inc.body_text_snapshot,
          bodyTextDeSnapshot: inc.body_text_de_snapshot,
        }))
      : undefined,
  };
}

function transformBlock(b) {
  if (!b) return null;
  return {
    id: b.id,
    slug: b.slug,
    section: b.section,
    name: b.name,
    description: b.description,
    bodyText: b.body_text,
    bodyTextDe: b.body_text_de,
    // Migration 131 — additional language bodies. Fall back to null
    // on schema-drift (column missing on a not-yet-migrated install)
    // so the field always exists on the JSON shape.
    bodyTextRu: b.body_text_ru ?? null,
    bodyTextPt: b.body_text_pt ?? null,
    bodyTextNl: b.body_text_nl ?? null,
    bodyTextFr: b.body_text_fr ?? null,
    isSystem: b.is_system === true || b.is_system === 1 || b.is_system === '1',
    isActive: b.is_active === true || b.is_active === 1 || b.is_active === '1',
    displayOrder: b.display_order,
    createdAt: b.created_at,
    updatedAt: b.updated_at,
  };
}

// ---------------------------------------------------------------------
// Block library — placed BEFORE /:id routes so 'blocks' isn't captured
// as an id (express-validator wouldn't matter, but Express order would).
// ---------------------------------------------------------------------

router.get(
  '/blocks',
  requirePermission('contracts.view'),
  [query('section').optional().isString(), query('includeInactive').optional().isBoolean()],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const blocks = await contractBlocksService.listBlocks({
      section: req.query.section,
      includeInactive: req.query.includeInactive === 'true' || req.query.includeInactive === true,
    });
    return successResponse(res, { blocks: blocks.map(transformBlock) });
  }),
);

router.post(
  '/blocks',
  requirePermission('contracts.manage'),
  [
    body('section').isString().isIn(contractBlocksService.ALLOWED_SECTIONS),
    body('name').isString().isLength({ min: 1, max: 128 }),
    body('bodyText').isString().isLength({ min: 1 }),
    body('bodyTextDe').optional({ nullable: true }).isString(),
    body('bodyTextRu').optional({ nullable: true }).isString(),
    body('bodyTextPt').optional({ nullable: true }).isString(),
    body('bodyTextNl').optional({ nullable: true }).isString(),
    body('bodyTextFr').optional({ nullable: true }).isString(),
    body('description').optional({ nullable: true }).isString().isLength({ max: 255 }),
    body('displayOrder').optional({ nullable: true }).isInt({ min: 0 }),
    body('isActive').optional().isBoolean(),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const block = await contractBlocksService.createBlock(req.body);
    return successResponse(res, { block: transformBlock(block) }, 201);
  }),
);

router.put(
  '/blocks/:id',
  requirePermission('contracts.manage'),
  [
    param('id').isInt({ min: 1 }),
    body('section').optional().isString().isIn(contractBlocksService.ALLOWED_SECTIONS),
    body('name').optional().isString().isLength({ min: 1, max: 128 }),
    body('bodyText').optional().isString().isLength({ min: 1 }),
    body('bodyTextDe').optional({ nullable: true }).isString(),
    body('bodyTextRu').optional({ nullable: true }).isString(),
    body('bodyTextPt').optional({ nullable: true }).isString(),
    body('bodyTextNl').optional({ nullable: true }).isString(),
    body('bodyTextFr').optional({ nullable: true }).isString(),
    body('description').optional({ nullable: true }).isString().isLength({ max: 255 }),
    body('displayOrder').optional({ nullable: true }).isInt({ min: 0 }),
    body('isActive').optional().isBoolean(),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const block = await contractBlocksService.updateBlock(parseInt(req.params.id, 10), req.body);
    return successResponse(res, { block: transformBlock(block) });
  }),
);

router.delete(
  '/blocks/:id',
  requirePermission('contracts.manage'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    await contractBlocksService.deleteBlock(parseInt(req.params.id, 10));
    return successResponse(res, { ok: true });
  }),
);

// ---------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------

router.get(
  '/',
  requirePermission('contracts.view'),
  [
    query('status').optional().isString(),
    query('customerAccountId').optional().isInt({ min: 1 }),
    query('q').optional().isString(),
    query('sort').optional().isIn(['newest', 'oldest', 'issue_asc', 'issue_desc', 'customer_asc', 'customer_desc']),
    query('page').optional().isInt({ min: 1 }),
    query('pageSize').optional().isInt({ min: 1, max: 200 }),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const filters = {};
    if (req.query.status) {
      filters.status = String(req.query.status).split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (req.query.customerAccountId) filters.customerAccountId = parseInt(req.query.customerAccountId, 10);
    if (req.query.q) filters.q = String(req.query.q);
    const page = parseInt(req.query.page, 10) || 1;
    const pageSize = parseInt(req.query.pageSize, 10) || 25;
    const result = await contractService.listContracts({
      filters,
      sort: req.query.sort || 'issue_desc',
      page,
      pageSize,
    });
    return successResponse(res, {
      contracts: result.rows.map((row) => transformContract(row)),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    });
  }),
);

router.post(
  '/',
  requirePermission('contracts.manage'),
  [
    body('customerAccountId').isInt({ min: 1 }),
    body('language').optional({ nullable: true }).isString().isLength({ max: 8 }),
    body('title').optional({ nullable: true }).isString().isLength({ max: 255 }),
    body('eventName').optional({ nullable: true }).isString().isLength({ max: 255 }),
    body('eventDate').optional({ nullable: true }).isISO8601(),
    body('eventTimeStart').optional({ nullable: true }).isString().isLength({ max: 8 }),
    body('eventTimeEnd').optional({ nullable: true }).isString().isLength({ max: 8 }),
    body('introText').optional({ nullable: true }).isString(),
    body('outroText').optional({ nullable: true }).isString(),
    body('issueDate').optional({ nullable: true }).isISO8601(),
    body('validUntil').optional({ nullable: true }).isISO8601(),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const id = await contractService.createContract(req.body, req.admin?.id);
    const data = await contractService.getContractById(id);
    return successResponse(res, { contract: transformContract(data.contract, data.inclusions) }, 201);
  }),
);

router.get(
  '/:id',
  requirePermission('contracts.view'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const data = await contractService.getContractById(parseInt(req.params.id, 10));
    if (!data) return res.status(404).json({ error: 'Contract not found' });
    return successResponse(res, { contract: transformContract(data.contract, data.inclusions) });
  }),
);

router.put(
  '/:id',
  requirePermission('contracts.manage'),
  [
    param('id').isInt({ min: 1 }),
    body('title').optional({ nullable: true }).isString().isLength({ max: 255 }),
    body('eventName').optional({ nullable: true }).isString().isLength({ max: 255 }),
    body('eventDate').optional({ nullable: true }).isISO8601(),
    body('eventTimeStart').optional({ nullable: true }).isString().isLength({ max: 8 }),
    body('eventTimeEnd').optional({ nullable: true }).isString().isLength({ max: 8 }),
    body('introText').optional({ nullable: true }).isString(),
    body('outroText').optional({ nullable: true }).isString(),
    body('language').optional({ nullable: true }).isString().isLength({ max: 8 }),
    body('issueDate').optional({ nullable: true }).isISO8601(),
    body('validUntil').optional({ nullable: true }).isISO8601(),
    body('blocks').optional().isArray(),
    body('blocks.*.blockId').optional().isInt({ min: 1 }),
    body('blocks.*.included').optional().isBoolean(),
    body('blocks.*.position').optional().isInt({ min: 0 }),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    await contractService.updateContract(parseInt(req.params.id, 10), req.body, req.admin?.id);
    const data = await contractService.getContractById(parseInt(req.params.id, 10));
    return successResponse(res, { contract: transformContract(data.contract, data.inclusions) });
  }),
);

router.post(
  '/:id/send',
  requirePermission('contracts.manage'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const result = await contractService.sendContract(parseInt(req.params.id, 10), req.admin?.id);
    return successResponse(res, result);
  }),
);

router.post(
  '/:id/cancel',
  requirePermission('contracts.manage'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const result = await contractService.cancelContract(parseInt(req.params.id, 10), req.admin?.id);
    return successResponse(res, result);
  }),
);

// Convert a fully-signed contract into an event + scheduled invoices.
// Delegates to quoteService via the contract's source_quote_id; refuses
// when source_quote_id is null (standalone contracts have no line items
// to replay).
router.post(
  '/:id/convert-to-event',
  requirePermission('contracts.manage'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const result = await contractService.convertToEvent(parseInt(req.params.id, 10), req.admin?.id);
    return successResponse(res, result, 200,
      result.alreadyConverted ? 'Already converted to event' : 'Contract converted to event');
  }),
);

// Convert a fully-signed contract into invoice(s) only — no event.
router.post(
  '/:id/convert-to-invoice',
  requirePermission('contracts.manage'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const result = await contractService.convertToInvoiceOnly(parseInt(req.params.id, 10), req.admin?.id);
    return successResponse(res, result, 200, 'Invoices created from contract');
  }),
);

// Re-render the signed PDF (when it's a system render, not a wet-
// signed upload) and resend the contract_fully_signed email to both
// parties. Recovery action for contracts where the initial dual-party
// send failed silently, or where the customer claims they didn't
// receive the email.
router.post(
  '/:id/resend-signed',
  requirePermission('contracts.manage'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const result = await contractService.rerenderAndResend(parseInt(req.params.id, 10), req.admin?.id);
    return successResponse(res, result, 200, 'Signed contract re-sent to both parties');
  }),
);

// Re-stamp one or both signature images on a contract whose original
// sign happened before the canvas worked correctly. The admin draws
// the missing signature(s) on the detail page; this endpoint persists
// the PNGs, updates signature_path columns, and re-renders the PDF.
// The customer's typed name + timestamp + IP stay untouched — only
// the image bound to those evidence fields gets refreshed.
router.post(
  '/:id/restamp-signatures',
  requirePermission('contracts.manage'),
  [
    param('id').isInt({ min: 1 }),
    body('customerSignatureDataUrl').optional({ nullable: true }).isString(),
    body('adminSignatureDataUrl').optional({ nullable: true }).isString(),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const result = await contractService.restampSignatures(
      parseInt(req.params.id, 10),
      {
        customerSignatureDataUrl: req.body.customerSignatureDataUrl || null,
        adminSignatureDataUrl: req.body.adminSignatureDataUrl || null,
      },
      req.admin?.id,
    );
    return successResponse(res, result, 200, 'Signatures re-stamped and PDF re-rendered');
  }),
);

router.post(
  '/:id/countersign',
  requirePermission('contracts.manage'),
  [
    param('id').isInt({ min: 1 }),
    body('name').isString().isLength({ min: 1, max: 255 }),
    body('signatureDataUrl').optional({ nullable: true }).isString(),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const ip = req.ip || req.headers['x-forwarded-for'] || null;
    const result = await contractService.recordAdminCountersignature(
      parseInt(req.params.id, 10),
      { name: req.body.name, ip, signatureDataUrl: req.body.signatureDataUrl },
      req.admin?.id,
    );
    return successResponse(res, result);
  }),
);

router.post(
  '/:id/upload-signed-pdf',
  requirePermission('contracts.manage'),
  [param('id').isInt({ min: 1 })],
  signedPdfUpload.single('file'),
  handleAsync(async (req, res) => {
    validateRequest(req);
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded', code: 'NO_FILE' });
    }
    const result = await contractService.attachSignedPdfUpload(
      parseInt(req.params.id, 10),
      req.file.path,
      'admin',
    );
    return successResponse(res, result);
  }),
);

router.get(
  '/:id/pdf',
  requirePermission('contracts.view'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const data = await contractService.getContractById(parseInt(req.params.id, 10));
    if (!data) return res.status(404).json({ error: 'Contract not found' });
    if (!data.contract.pdf_path) {
      return res.status(404).json({ error: 'PDF not yet rendered', code: 'PDF_MISSING' });
    }
    if (!fs.existsSync(data.contract.pdf_path)) {
      return res.status(404).json({ error: 'PDF file missing from disk', code: 'PDF_MISSING_ON_DISK' });
    }
    // Defence-in-depth: reject any path that resolves outside the
    // contract storage roots before we open the stream. Today the DB
    // paths are always written by the service layer, but a future
    // migration bug or hand-edited row should not turn this endpoint
    // into an arbitrary-file-read primitive.
    const safePath = assertContractPdfPath(data.contract.pdf_path);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${data.contract.contract_number}.pdf"`,
    );
    fs.createReadStream(safePath).pipe(res);
  }),
);

router.get(
  '/:id/signed-pdf',
  requirePermission('contracts.view'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const data = await contractService.getContractById(parseInt(req.params.id, 10));
    if (!data) return res.status(404).json({ error: 'Contract not found' });
    if (!data.contract.signed_pdf_path) {
      return res.status(404).json({ error: 'No signed PDF uploaded', code: 'SIGNED_PDF_MISSING' });
    }
    if (!fs.existsSync(data.contract.signed_pdf_path)) {
      return res.status(404).json({ error: 'Signed PDF missing from disk', code: 'SIGNED_PDF_MISSING_ON_DISK' });
    }
    const safePath = assertContractPdfPath(data.contract.signed_pdf_path);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${data.contract.contract_number}-signed.pdf"`,
    );
    fs.createReadStream(safePath).pipe(res);
  }),
);

// Audit trail — chronological activity_logs entries for this contract.
// Used by the AuditTrailCard on the admin detail page; read-only.
router.get(
  '/:id/audit-trail',
  requirePermission('contracts.view'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const entries = await contractService.getAuditTrail(parseInt(req.params.id, 10));
    return successResponse(res, { entries });
  }),
);

// Integrity check — re-hashes pdf_path + signed_pdf_path on disk and
// compares to the stored pdf_sha256 / signed_pdf_sha256 (migration
// 131). Lets the admin confirm a contract PDF on disk still matches
// what was issued, catching backup-corruption / manual-edit cases
// without needing to drop to a shell.
router.get(
  '/:id/verify-integrity',
  requirePermission('contracts.view'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const result = await contractService.verifyIntegrity(parseInt(req.params.id, 10));
    return successResponse(res, result);
  }),
);

router.get(
  '/:id/preview',
  requirePermission('contracts.view'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const buffer = await contractService.renderContractPdfBuffer(parseInt(req.params.id, 10));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="contract-preview.pdf"');
    return res.send(buffer);
  }),
);

module.exports = router;
