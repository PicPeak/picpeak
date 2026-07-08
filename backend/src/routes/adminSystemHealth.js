/**
 * Admin → System Health
 *
 * Endpoint mounted at /api/admin/system-health. The "Backup
 * integrity" sub-endpoint is the on-demand verifier for CRM
 * document artefacts — confirms every `*_path` column on quotes /
 * contracts / invoices points at a file that actually exists on
 * disk and (where a `*_sha256` column is set) the file's bytes
 * still hash to the expected value.
 *
 * Per the design decisions locked with the maintainer:
 *   - On-demand only; no scheduler (D1)
 *   - Not auto-triggered after restore (D2)
 *   - Wet-upload contracts are hash-verified same as system-rendered (D3)
 *
 * Read-only. Returns a JSON report — never mutates DB or fs.
 */

const express = require('express');
const { query } = require('express-validator');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const { verifyDocumentArtefacts } = require('../services/backupIntegrityService');
const { getCoverageReport } = require('../services/backupCoverageService');
const { db } = require('../database/db');

const router = express.Router();

router.use(adminAuth);

const VALID_SCOPES = ['quote', 'contract', 'contract-signature', 'invoice'];

router.get(
  '/backup-integrity',
  requirePermission('settings.view'),
  [
    // CSV string like `?scope=contract,invoice`. Each member must be
    // one of the four known scopes. Empty / omitted means full scan.
    query('scope').optional({ values: 'falsy' }).isString().isLength({ max: 128 }),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    let scope;
    if (req.query.scope) {
      scope = String(req.query.scope)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      // Defense-in-depth: reject unknown scope tokens so a typo doesn't
      // silently scan everything when the caller wanted just one slice.
      const unknown = scope.filter((s) => !VALID_SCOPES.includes(s));
      if (unknown.length > 0) {
        return res.status(400).json({
          error: `Unknown scope(s): ${unknown.join(', ')}`,
          code: 'BACKUP_INTEGRITY_UNKNOWN_SCOPE',
          validScopes: VALID_SCOPES,
        });
      }
    }
    const report = await verifyDocumentArtefacts({ scope });
    return successResponse(res, { report });
  }),
);

/**
 * GET /api/admin/system-health/backup-coverage
 *
 * Stage C of the backup-hardening plan. Returns the data-driven
 * coverage report — what the next "Run Backup Now" will include /
 * skip / silently miss, plus the database-dump status block.
 *
 * Read-only, on-demand. No scope parameter — the report is cheap
 * (only top-level directory listing under STORAGE_PATH, no recursion).
 *
 * See backupCoverageService.js for the full rationale and the
 * coverage-classification rules.
 */
router.get(
  '/backup-coverage',
  requirePermission('settings.view'),
  handleAsync(async (req, res) => {
    const report = await getCoverageReport();
    return successResponse(res, { report });
  }),
);

/**
 * GET /api/admin/system-health/failures
 *
 * Surfaces background failures that would otherwise go unnoticed. v1
 * covers stuck/failed outbound emails: rows the queue processor has
 * given up on (status='failed') or exhausted its retries on
 * (status='pending' AND retry_count >= 3 — the processor only picks up
 * retry_count < 3). Trigger: a 14h window where 'quote_sent' template
 * errors left invoices unsent with no admin-visible signal.
 */
router.get(
  '/failures',
  requirePermission('settings.view'),
  handleAsync(async (req, res) => {
    const stuckEmails = await db('email_queue')
      .where(function () {
        this.where('status', 'failed')
          .orWhere(function () {
            this.where('status', 'pending').andWhere('retry_count', '>=', 3);
          });
      })
      .orderBy('created_at', 'desc')
      .limit(200)
      .select('id', 'recipient_email', 'email_type', 'status', 'retry_count', 'error_message', 'created_at');

    return successResponse(res, {
      stuckEmails: stuckEmails.map((r) => ({
        id: r.id,
        recipientEmail: r.recipient_email,
        emailType: r.email_type,
        status: r.status,
        retryCount: r.retry_count,
        errorMessage: r.error_message,
        createdAt: r.created_at,
      })),
      counts: { stuckEmails: stuckEmails.length },
    });
  }),
);

/**
 * POST /failures/email/:id/retry — re-queue a stuck email (status back to
 * pending, retry_count reset, error cleared, scheduled_at cleared so the
 * 60s processor picks it up on its next pass).
 */
router.post(
  '/failures/email/:id/retry',
  requirePermission('settings.edit'),
  handleAsync(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid id' });
    const updated = await db('email_queue').where({ id }).update({
      status: 'pending',
      retry_count: 0,
      error_message: null,
      scheduled_at: null,
    });
    if (!updated) return res.status(404).json({ error: 'Email not found' });
    return successResponse(res, { retried: true });
  }),
);

/**
 * DELETE /failures/email/:id — dismiss a stuck email (remove the row so
 * it stops surfacing). Use when the failure is understood + won't be sent.
 */
router.delete(
  '/failures/email/:id',
  requirePermission('settings.edit'),
  handleAsync(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid id' });
    await db('email_queue').where({ id }).del();
    return successResponse(res, { dismissed: true });
  }),
);

module.exports = router;
