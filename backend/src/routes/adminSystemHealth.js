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
const { getQueueProcessorStatus } = require('../services/emailProcessor');
const { toMillis } = require('../utils/queueTimestamps');
const { db } = require('../database/db');

const router = express.Router();

router.use(adminAuth);

const VALID_SCOPES = ['quote', 'contract', 'contract-signature', 'invoice'];

router.get(
  '/backup-integrity',
  requirePermission(['settings.view', 'system.view']),
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
  requirePermission(['settings.view', 'system.view']),
  handleAsync(async (req, res) => {
    const report = await getCoverageReport();
    return successResponse(res, { report });
  }),
);

/**
 * How long an email may sit due-but-unsent before it counts as waiting rather
 * than merely in flight. The processor wakes every 60s and takes 10 rows a
 * pass, so a genuine backlog of ~6000 clears inside this window — anything
 * still here has not been worked.
 */
const WAITING_EMAIL_GRACE_MS = 10 * 60 * 1000;

/**
 * Why the two time comparisons happen in JS (toMillis) and not in the WHERE
 * clause: SQLite orders INTEGER before TEXT regardless of value, so comparing
 * the ms-number this column really holds against a bound ISO string is true
 * for EVERY row -- a mail queued one second ago reads as ten minutes overdue,
 * and a scheduled_at years in the future reads as already due. Binding a Date
 * instead is no fix either, since knex hands sqlite3 a Date the same way and
 * jest's sandbox Dates stringify to "[object Object]" (see CLAUDE.md).
 *
 * The time filtering happens in JS, so the candidate rows have to be paged
 * rather than cut off with a single LIMIT: a queue holding a thousand
 * future-scheduled rows (split-payment invoices) would otherwise fill one page
 * with rows that all get filtered out and hide the due row behind them,
 * reporting an empty waiting list. Paging also removes the dependency on
 * ORDER BY created_at being meaningful, which it is not on SQLite when numeric
 * and text timestamps are mixed.
 *
 * WAITING_SCAN_MAX bounds the work: past it the response is explicitly a
 * sample, which the 200-row cap already made it.
 */
const WAITING_PAGE_SIZE = 500;
const WAITING_SCAN_MAX = 10000;
const WAITING_REPORT_LIMIT = 200;

const mapEmailRow = (r) => ({
  id: r.id,
  recipientEmail: r.recipient_email,
  emailType: r.email_type,
  status: r.status,
  retryCount: r.retry_count,
  errorMessage: r.error_message,
  createdAt: r.created_at,
});

/**
 * GET /api/admin/system-health/failures
 *
 * Surfaces background failures that would otherwise go unnoticed. v1
 * covers stuck/failed outbound emails: rows the queue processor has
 * given up on (status='failed') or exhausted its retries on
 * (status='pending' AND retry_count >= 3 — the processor only picks up
 * retry_count < 3). Trigger: a 14h window where 'quote_sent' template
 * errors left invoices unsent with no admin-visible signal.
 *
 * #1262 added the other half. A queue nobody is working produces no failures
 * at all: the rows sit at status='pending' with retry_count 0, matching
 * neither branch above, and the page reported "all clear" while not one email
 * had gone out. That happens whenever the processor never started, or every
 * pass returns early because the transport will not initialise. So the
 * response also carries emails that are DUE and still unsent
 * (`waitingEmails`), plus what the processor itself last did (`processor`).
 */
router.get(
  '/failures',
  requirePermission(['settings.view', 'system.view']),
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

    // Deliberately mirrors the processor's own pickup predicate — pending,
    // under the retry cap, and past any scheduled_at — so a row listed here is
    // one it should already have taken. Rows over the cap are the `stuckEmails`
    // set above and must not be counted twice.
    //
    // Only the engine-safe half of that predicate runs in SQL; the two time
    // comparisons are done in JS — see utils/queueTimestamps.
    const now = Date.now();
    const dueBefore = now - WAITING_EMAIL_GRACE_MS;
    const isWaiting = (r) => {
      const scheduledAt = toMillis(r.scheduled_at);
      // Parked for later on purpose — split-payment invoices, the
      // business-hours floor. Not being sent yet is the point of those.
      if (scheduledAt !== null && scheduledAt > now) return false;
      const createdAt = toMillis(r.created_at);
      // An unreadable created_at cannot be judged overdue; leave it alone
      // rather than reporting every such row as waiting.
      if (createdAt === null) return false;
      // The grace window runs from the moment the row became DUE, not from
      // when it was queued. An invoice created three days ago and scheduled
      // until a minute ago has had one minute of the processor's attention,
      // not three days of it — measuring from created_at would report every
      // split-payment and business-hours mail as unworked the instant it came
      // due, which is most of what this panel would then be showing.
      const dueSince = scheduledAt === null ? createdAt : Math.max(createdAt, scheduledAt);
      return dueSince <= dueBefore;
    };

    const waitingEmails = [];
    let scanTruncated = false;
    let scanned = 0;
    for (let offset = 0; offset < WAITING_SCAN_MAX; offset += WAITING_PAGE_SIZE) {
      // eslint-disable-next-line no-await-in-loop
      const page = await db('email_queue')
        .where('status', 'pending')
        .where('retry_count', '<', 3)
        .orderBy('id', 'asc')
        .offset(offset)
        .limit(WAITING_PAGE_SIZE)
        .select('id', 'recipient_email', 'email_type', 'status', 'retry_count',
          'error_message', 'created_at', 'scheduled_at');
      if (page.length === 0) break;
      scanned += page.length;
      for (const row of page) {
        if (isWaiting(row)) waitingEmails.push(row);
        if (waitingEmails.length >= WAITING_REPORT_LIMIT) break;
      }
      if (waitingEmails.length >= WAITING_REPORT_LIMIT || page.length < WAITING_PAGE_SIZE) break;
      // Ran out of budget with rows still unread. A queue this size whose head
      // is all future-scheduled could be hiding a due row past the cap, so the
      // empty result below is "not found yet", not "none" — and the UI must
      // not turn it into an all-clear.
      if (offset + WAITING_PAGE_SIZE >= WAITING_SCAN_MAX) scanTruncated = true;
    }

    return successResponse(res, {
      stuckEmails: stuckEmails.map(mapEmailRow),
      waitingEmails: waitingEmails.map(mapEmailRow),
      processor: getQueueProcessorStatus(),
      counts: {
        stuckEmails: stuckEmails.length,
        waitingEmails: waitingEmails.length,
        pendingScanned: scanned,
      },
      // True when the pending queue was larger than this endpoint will read.
      scanTruncated,
    });
  }),
);

/**
 * POST /failures/email/:id/retry — re-queue a stuck email (status back to
 * pending, retry_count reset, error cleared, scheduled_at cleared so the
 * 60s processor picks it up on its next pass).
 *
 * Deliberately does NOT send the mail itself. An earlier revision flushed the
 * row here via processEmailQueue({ onlyId }), which reads better but races:
 * nothing claims a row before the transport is invoked, so a flush overlapping
 * the scheduled pass has both of them sending the same email. Saving 60
 * seconds is not worth a duplicate landing in a customer's inbox.
 *
 * That is also why waiting rows carry no actions at all — they are already
 * pending with retries and schedule clear, so this endpoint would rewrite them
 * to the state they are in and change nothing. What a waiting row needs is the
 * processor fixed, which the panel above it says.
 */
router.post(
  '/failures/email/:id/retry',
  requirePermission('system.manage'),
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
  requirePermission('system.manage'),
  handleAsync(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid id' });
    await db('email_queue').where({ id }).del();
    return successResponse(res, { dismissed: true });
  }),
);

module.exports = router;
