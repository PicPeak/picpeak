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
const { getQueueProcessorStatus, processEmailQueue } = require('../services/emailProcessor');
const logger = require('../utils/logger');
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
 * A timestamp column as milliseconds, whatever the engine handed back.
 *
 * The three shapes are all real. Postgres returns a Date. SQLite stores what
 * `queueEmail` writes -- a JS Date, which the native binding turns into a
 * ms-number -- and hands back that number. Test fixtures and older rows carry
 * ISO strings.
 *
 * This has to happen in JS rather than in the WHERE clause. SQLite orders
 * INTEGER before TEXT regardless of value, so comparing a ms-number column
 * against a bound ISO string is true for EVERY row: a mail queued one second
 * ago reads as ten minutes overdue, and a scheduled_at years in the future
 * reads as already due. Binding a Date instead is no fix either, since knex
 * hands sqlite3 a Date the same way and jest's sandbox Dates stringify to
 * "[object Object]" (see CLAUDE.md).
 */
function toMillis(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const text = String(value).trim();
  if (text === '') return null;
  // A numeric string is epoch ms; anything else goes through Date.parse.
  const numeric = Number(text);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * How many pending rows to pull before filtering by time in JS. Everything
 * overdue sorts first, so the cap only bites on a queue with more than this
 * many pending rows -- at which point the 200-row response was already a
 * sample rather than a census.
 */
const WAITING_SCAN_LIMIT = 1000;

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
    // comparisons are done in JS, for the reason on toMillis above.
    const now = Date.now();
    const dueBefore = now - WAITING_EMAIL_GRACE_MS;
    const pendingRows = await db('email_queue')
      .where('status', 'pending')
      .where('retry_count', '<', 3)
      .orderBy('created_at', 'asc')
      .limit(WAITING_SCAN_LIMIT)
      .select('id', 'recipient_email', 'email_type', 'status', 'retry_count',
        'error_message', 'created_at', 'scheduled_at');

    const waitingEmails = pendingRows.filter((r) => {
      const scheduledAt = toMillis(r.scheduled_at);
      // Parked for later on purpose — split-payment invoices, the
      // business-hours floor. Not being sent yet is the point of those.
      if (scheduledAt !== null && scheduledAt > now) return false;
      const createdAt = toMillis(r.created_at);
      // An unreadable created_at cannot be judged overdue; leave it alone
      // rather than reporting every such row as waiting.
      if (createdAt === null) return false;
      return createdAt <= dueBefore;
    }).slice(0, 200);

    return successResponse(res, {
      stuckEmails: stuckEmails.map(mapEmailRow),
      waitingEmails: waitingEmails.map(mapEmailRow),
      processor: getQueueProcessorStatus(),
      counts: {
        stuckEmails: stuckEmails.length,
        waitingEmails: waitingEmails.length,
      },
    });
  }),
);

/**
 * POST /failures/email/:id/retry — re-queue an email and flush it now.
 *
 * The reset alone (pending, retries cleared, schedule cleared) is what a
 * FAILED row needs, but it is a no-op for a waiting row: those are already
 * pending at retry_count 0 with a null or past-due schedule, so the row came
 * back unchanged while the toast said it had been re-queued. Since the
 * commonest reason a row is waiting is that nothing is working the queue,
 * telling it to wait for the next pass is the one thing that will not help.
 *
 * So the reset is followed by a targeted flush — the same single-row path the
 * project cockpit uses (projectService.js). `ignoreSchedule` bypasses the
 * retry cap and the schedule, which is the point of an admin forcing a send.
 * The send is best-effort: a failure is already recorded on the row itself by
 * processEmailQueue, and the refreshed list will show it.
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

    let sent = 0;
    try {
      ({ sent } = await processEmailQueue({ ignoreSchedule: true, onlyId: id }));
    } catch (err) {
      logger.warn(`System health: flush of email ${id} failed: ${err.message}`);
    }
    return successResponse(res, { retried: true, sent: sent > 0 });
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
