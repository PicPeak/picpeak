/**
 * Public → Contracts Routes
 *
 * Mounted at /api/public/contracts. NO authentication — the link in
 * the customer's signing email is the only secret.
 *
 * Surface:
 *   GET  /:token                  read-only contract view + included blocks
 *   POST /:token/sign             body: { name, signatureDataUrl?, accepted: true }
 *   POST /:token/upload-signed-pdf   multer single — customer uploads their wet-signed PDF
 *
 * No state mutation flows from /:token (GET) — only the two POST routes
 * affect the contract. IP is captured for the signature evidence /
 * upload audit row.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { body, param } = require('express-validator');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const { validateFileType } = require('../utils/fileSecurityUtils');
const contractService = require('../services/contractService');
const { getAppSetting } = require('../utils/appSettings');

// Normalise a Settings → Branding logo value (absolute URL, /-rooted path,
// or bare `uploads/...` filename) into a URL the public page can load.
function normalizeBrandingLogoUrl(raw) {
  const value = (raw && String(raw).trim()) || null;
  if (!value) return null;
  if (value.startsWith('/') || /^https?:\/\//i.test(value)) return value;
  return `/uploads/${value.replace(/^uploads\//, '')}`;
}
const { clientIpForAudit } = require('../utils/clientIp');
const { loadActionToken, preMulterTokenGuard } = require('../utils/publicTokenGuards');
const { db } = require('../database/db');

const router = express.Router();

const previewLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
});
const respondLimiter = rateLimit({
  windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
});

const getStoragePath = () => process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');

const signedPdfStorage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = path.join(getStoragePath(), 'uploads/contracts/signed');
    fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.pdf';
    cb(null, `contract-token-${req.params.token.slice(0, 12)}-${Date.now()}${ext}`);
  },
});

const signedPdfUpload = multer({
  storage: signedPdfStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    if (validateFileType(file.originalname, file.mimetype, ['application/pdf'])) return cb(null, true);
    return cb(new Error('Only PDF files are allowed'));
  },
});

/**
 * Public-safe projection of the contract. We deliberately omit:
 *   - intro/outro text remain visible (customer-facing by design)
 *   - admin notes (none on contracts today)
 *   - admin IP + signature paths (signed_*_path is admin-only)
 *
 * The IP / signature image paths are NEVER exposed publicly even after
 * signing — they're audit evidence.
 */
function publicContractView(contract, inclusions, customer, profile, locale, brandingLogoUrl, brandingLogoUrlDark) {
  const orderedSections = ['basics', 'scope', 'privacy', 'commercial', 'nda', 'closing'];
  const blocksBySection = {};
  for (const s of orderedSections) blocksBySection[s] = [];
  for (const inc of inclusions) {
    if (!(inc.included === true || inc.included === 1 || inc.included === '1')) continue;
    const bodyEn = inc.body_text_snapshot || inc.block_body_text || '';
    const bodyDe = inc.body_text_de_snapshot || inc.block_body_text_de || '';
    // 1) Strip the leading `**Title**\n` line — the block.name is
    //    already rendered above as a bold sub-heading, so a bold
    //    first line in the body would duplicate it.
    // 2) Strip remaining `**bold**` inline markers — the React sign
    //    page renders body as plain `whitespace-pre-line` text and
    //    has no inline-bold UI. The PDF path keeps them as bold
    //    runs via pdfService.renderBodyMarkdown.
    const body = (locale === 'de' ? (bodyDe || bodyEn) : (bodyEn || bodyDe))
      .replace(/^\s*\*\*[^*\n]+\*\*\s*\n+/, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1');
    if (!blocksBySection[inc.section]) continue;
    blocksBySection[inc.section].push({
      blockId: inc.block_id,
      section: inc.section,
      position: inc.position,
      name: inc.block_name,
      body,
    });
  }
  const sections = orderedSections
    .map((s) => ({ section: s, blocks: blocksBySection[s] }))
    .filter((s) => s.blocks.length > 0);

  return {
    contractNumber: contract.contract_number,
    status: contract.status,
    language: contract.language,
    issueDate: contract.issue_date,
    validUntil: contract.valid_until,
    title: contract.title,
    introText: contract.intro_text,
    outroText: contract.outro_text,
    sentAt: contract.sent_at,
    signedByCustomerAt: contract.signed_by_customer_at,
    signedByAdminAt: contract.signed_by_admin_at,
    signedCustomerName: contract.signed_customer_name,
    signedAdminName: contract.signed_admin_name,
    // The customer's own IP is fine to surface back — it's THEIR
    // identifier on the audit trail. The admin's IP is NOT exposed
    // publicly: it's a counter-party's identifier (operator's office /
    // home network) and shouldn't reach the customer's browser via
    // a token-only-secret endpoint. Admin sees their own IP on the
    // admin detail page; customer doesn't need it.
    signedCustomerIp: contract.signed_customer_ip || null,
    // signed_pdf_path itself is admin-only; we just flag presence so
    // the public page can show a "wet-signed copy attached" hint.
    hasSignedPdf: !!contract.signed_pdf_path,
    // SHA-256 of the on-disk PDFs — surfaced so the customer can
    // re-hash their downloaded copy and confirm it matches what
    // we issued. Audit-trail evidence #1 from the maintainer plan.
    pdfSha256: contract.pdf_sha256 || null,
    signedPdfSha256: contract.signed_pdf_sha256 || null,
    canSign: contract.status === 'sent',
    sections,
    recipient: customer ? {
      displayName: customer.display_name || [customer.first_name, customer.last_name].filter(Boolean).join(' '),
      companyName: customer.company_name,
      email: customer.email,
    } : null,
    issuer: profile ? {
      companyName: profile.company_name,
      addressLine1: profile.address_line1,
      postalCode: profile.postal_code,
      city: profile.city,
      email: profile.email,
      website: profile.website,
      // Light + dark branding logos (Settings → Branding), so the public
      // sign page renders the logo that reads in its resolved colour mode.
      // Mirrors publicQuotes — the print-only business_profile.logo_path is
      // intentionally NOT used here.
      logoUrl: normalizeBrandingLogoUrl(brandingLogoUrl),
      logoUrlDark: normalizeBrandingLogoUrl(brandingLogoUrlDark),
    } : null,
  };
}

router.get(
  '/:token',
  previewLimiter,
  [param('token').isString().isLength({ min: 64, max: 64 }).matches(/^[a-f0-9]+$/i)],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const tokenRow = await loadActionToken(req, res, {
      tableName: 'contract_action_tokens',
      token: req.params.token,
    });
    if (!tokenRow) return;
    const data = await contractService.getContractById(tokenRow.contract_id);
    if (!data) return res.status(404).json({ error: 'Contract not found' });
    const customer = await db('customer_accounts').where({ id: data.contract.customer_account_id }).first();
    const profile = await db('business_profile').where({ id: 1 }).first();
    // Surface the admin-tunable behaviour toggles on the view so the
    // React page can hide the upload-PDF section when disabled and
    // enforce the drawn-signature requirement client-side. The server
    // re-enforces both, so client tampering only changes the UX.
    const allowPdfUpload = (await getAppSetting('crm_contracts_allow_pdf_upload')) !== false;
    const requireDrawnSignature = (await getAppSetting('crm_contracts_require_drawn_signature')) === true;
    const brandingLogoUrl = await getAppSetting('branding_logo_url', null);
    const brandingLogoUrlDark = await getAppSetting('branding_logo_url_dark', null);
    const view = publicContractView(
      data.contract,
      data.inclusions,
      customer,
      profile,
      data.contract.language || 'de',
      brandingLogoUrl,
      brandingLogoUrlDark,
    );
    view.allowPdfUpload = allowPdfUpload;
    view.requireDrawnSignature = requireDrawnSignature;
    return successResponse(res, { contract: view });
  }),
);

router.post(
  '/:token/sign',
  respondLimiter,
  [
    param('token').isString().isLength({ min: 64, max: 64 }).matches(/^[a-f0-9]+$/i),
    body('name').isString().isLength({ min: 1, max: 255 }),
    body('accepted').isBoolean(),
    body('signatureDataUrl').optional({ nullable: true }).isString(),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    // Audit IP source: req.ip ONLY. See utils/clientIp.js for the
    // full rationale — reading X-Forwarded-For directly bypassed
    // Express's trust-proxy safety net and let direct (non-proxied)
    // POSTs spoof the audit IP, defeating the legal-evidence promise
    // of the contract signing flow. Operators whose nginx topology
    // needs different trust rules adjust `TRUST_PROXY` in server.js.
    const ip = clientIpForAudit(req);
    try {
      const result = await contractService.recordCustomerSignature({
        token: req.params.token,
        name: req.body.name,
        signatureDataUrl: req.body.signatureDataUrl,
        accepted: req.body.accepted === true,
        ip,
      });
      return successResponse(res, result);
    } catch (err) {
      if (err.status) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      throw err;
    }
  }),
);

// Server-side guard for the "allow PDF upload" toggle. When the admin
// turns it off in Settings → CRM behaviour → Contracts the public sign
// page hides the upload section, but a hand-crafted POST would still
// hit this route — refuse here too BEFORE multer reads the body so a
// disabled-toggle install never writes attacker bytes to disk.
async function uploadSignedPdfSettingGuard(req, res, next) {
  const allowPdfUpload = (await getAppSetting('crm_contracts_allow_pdf_upload')) !== false;
  if (!allowPdfUpload) {
    return res.status(403).json({
      error: 'Uploading a wet-signed PDF is disabled for this installation. Please sign in your browser instead.',
      code: 'UPLOAD_DISABLED',
    });
  }
  next();
}

router.post(
  '/:token/upload-signed-pdf',
  respondLimiter,
  [param('token').isString().isLength({ min: 64, max: 64 }).matches(/^[a-f0-9]+$/i)],
  // CRITICAL ORDERING: setting guard + token guard run BEFORE multer.
  // Previously these checks lived after multer.single, which meant a
  // disabled-toggle install OR an expired/invalid token still cost a
  // disk write — captured tokens could be replayed to spam the disk
  // up to multer's 10 MB cap per request. Pre-multer rejection costs
  // a DB lookup and nothing more.
  uploadSignedPdfSettingGuard,
  preMulterTokenGuard('contract_action_tokens'),
  signedPdfUpload.single('file'),
  handleAsync(async (req, res) => {
    validateRequest(req);
    const tokenRow = req.publicTokenRow; // attached by preMulterTokenGuard
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded', code: 'NO_FILE' });
    }
    const result = await contractService.attachSignedPdfUpload(
      tokenRow.contract_id,
      req.file.path,
      'customer',
    );
    // Mark the token as used so the link can't be re-played.
    // IP storage is gated by the crm_contracts_store_ip setting so
    // privacy-strict operators can opt out — same toggle that gates
    // the in-browser-sign IP captures. See utils/clientIp.js for
    // why we trust req.ip only.
    const rawIp = clientIpForAudit(req);
    const storeIpEnabled = (await getAppSetting('crm_contracts_store_ip')) !== false;
    await db('contract_action_tokens').where({ id: tokenRow.id }).update({
      used_at: new Date(),
      used_action: 'uploaded_signed_pdf',
      used_ip: storeIpEnabled ? rawIp : null,
    });
    return successResponse(res, result);
  }),
);

/**
 * Public PDF download — token-scoped. Once the customer has signed,
 * they can re-fetch the signed copy from the same link rather than
 * waiting for the contract_fully_signed email (which only arrives
 * after admin counter-sign). Streams signed_pdf_path when present,
 * falls back to pdf_path. Returns 410 once the link has expired.
 *
 * Security note: this route deliberately honours `expires_at` now —
 * previous behaviour was "expired tokens still allow downloads, the
 * customer may need their signed copy after the window closes" but
 * that turned the token into a permanent unauthenticated download
 * URL once leaked (referer headers, browser history, email forward).
 * Customers needing a post-expiry copy receive the signed PDF in the
 * `contract_fully_signed` email, OR the admin can issue a fresh
 * download link via the admin detail page.
 *
 * Future enhancement (audit: "public token model rework"): swap the
 * long-lived contract token for a short-lived download sub-token
 * (~5 min) generated after sign, so the download URL itself never
 * embeds the long-lived secret. Tracked in the CRM backlog.
 */
router.get(
  '/:token/pdf',
  previewLimiter,
  [param('token').isString().isLength({ min: 64, max: 64 }).matches(/^[a-f0-9]+$/i)],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const tokenRow = await loadActionToken(req, res, {
      tableName: 'contract_action_tokens',
      token: req.params.token,
    });
    if (!tokenRow) return;
    const contract = await db('contracts').where({ id: tokenRow.contract_id }).first();
    if (!contract) return res.status(404).json({ error: 'Contract not found' });

    const fs = require('fs');
    const path = require('path');
    const { assertContractPdfPath } = require('../utils/safePath');
    const filePath = contract.signed_pdf_path || contract.pdf_path;
    // Content-Disposition: attachment + Referrer-Policy: no-referrer
    // so the long-lived contract token doesn't leak via referer
    // headers if the customer opens the PDF in an external viewer
    // that loads remote resources.
    res.set('Referrer-Policy', 'no-referrer');
    if (!filePath || !fs.existsSync(filePath)) {
      // Render on-demand so the link works even if the on-disk
      // file was wiped (cleanup, S3 sync, etc.).
      const contractService = require('../services/contractService');
      const buf = await contractService.renderContractPdfBuffer(contract.id);
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `attachment; filename="${contract.contract_number}.pdf"`);
      return res.send(buf);
    }
    // C.7 — defence-in-depth: reject if filePath resolves outside the
    // contract storage roots. The customer signing token is far less
    // privileged than an admin, so getting this wrong has higher blast
    // radius (a forged token could otherwise read any file the node
    // process has access to). assertContractPdfPath throws AppError
    // which the error middleware converts to a clean 403/404.
    const safePath = assertContractPdfPath(filePath);
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${path.basename(safePath)}"`);
    fs.createReadStream(safePath).pipe(res);
  }),
);

module.exports = router;
