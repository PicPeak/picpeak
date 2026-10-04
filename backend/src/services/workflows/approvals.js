/**
 * Workflow approval gates — the human-in-the-loop step.
 *
 * When the engine hits a `gate` node it calls the registered `gate_setup`
 * action, which creates a workflow_approvals row (single-use token stored as a
 * SHA-256 hash) and emails the admin a confirm/deny link. The run stays
 * `waiting` until the admin acts — via the email link (actByToken) or the
 * webview pending-approvals inbox (actById) — at which point the run resumes
 * down the matching confirm/deny edge.
 *
 * Internal/admin mail → sent immediately (respectBusinessHours: false).
 */
const crypto = require('crypto');
const { db } = require('../../database/db');
const logger = require('../../utils/logger');
const registry = require('./registry');
const engine = require('./engine');

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

// The emailed link is a bearer capability, so its lifetime is bounded on the
// server. The editor treats timeoutDays as optional and the shipped seeds omit
// it; a missing, zero or invalid value used to persist a NULL expiry and the
// link stayed valid for as long as the run waited.
const DEFAULT_APPROVAL_LIFETIME_DAYS = 14;
const MAX_APPROVAL_LIFETIME_DAYS = 90;

function approvalLifetimeDays(cfg) {
  const days = Number((cfg || {}).timeoutDays);
  if (!Number.isFinite(days) || days <= 0) return DEFAULT_APPROVAL_LIFETIME_DAYS;
  return Math.min(days, MAX_APPROVAL_LIFETIME_DAYS);
}

// A NULL or unreadable expiry fails closed: rows created before the lifetime
// became mandatory are refused instead of being valid forever (same rule as
// publicTokenGuards for quote/contract links).
function isExpired(approval) {
  if (!approval.expires_at) return true;
  const at = new Date(approval.expires_at).getTime();
  return !Number.isFinite(at) || at < Date.now();
}

/**
 * gate_setup action — create the approval + email the admin. Called by the
 * engine when a gate node is reached. Best-effort on the email; the approval
 * row (and thus the inbox path) is always created.
 */
async function createApproval(ctx) {
  const { run, node } = ctx;
  const cfg = node.config || {};
  const raw = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + approvalLifetimeDays(cfg) * 86400000).toISOString();

  await db('workflow_approvals').insert({
    run_id: run.id,
    node_key: node.node_key,
    type: cfg.type || 'payment_confirm',
    status: 'pending',
    token_hash: hashToken(raw),
    payload: JSON.stringify({ prompt: cfg.prompt || null, vars: ctx.vars || {} }),
    expires_at: expiresAt,
    created_at: db.fn.now(),
  });

  try {
    const { getFrontendBaseUrl } = require('../../utils/frontendUrl');
    const base = (await getFrontendBaseUrl()) || '';
    const confirmUrl = `${base}/api/public/workflow-approvals/${raw}/confirm`;
    const denyUrl = `${base}/api/public/workflow-approvals/${raw}/deny`;

    let adminEmail = ctx.vars?.adminEmail || null;
    if (!adminEmail) {
      const bp = await db('business_profile').where({ id: 1 }).first('email');
      adminEmail = bp?.email || null;
    }
    if (adminEmail) {
      const emailProcessor = require('../emailProcessor');
      const emailData = {
        prompt: cfg.prompt || 'A workflow needs your confirmation.',
        confirm_url: confirmUrl,
        deny_url: denyUrl,
        ...(ctx.vars?.emailData || {}),
      };
      // Attachments are file paths the mailer reads from disk; run vars can
      // come from a test-run payload, so they must never choose one (same
      // rule as the send_email action).
      delete emailData.attachments;
      await emailProcessor.queueEmail(
        ctx.vars?.eventId || null,
        adminEmail,
        cfg.emailType || 'workflow_approval',
        emailData,
        { respectBusinessHours: false }, // internal/admin → immediate
      );
    } else {
      logger.warn('[workflow] approval created but no admin email to notify', { runId: run.id });
    }
  } catch (e) {
    logger.error('[workflow] approval email failed', { runId: run.id, error: e.message });
  }

  return { approval: true };
}

registry.registerAction('gate_setup', createApproval);

/** The answer for a request that lost the race to another decision. */
async function alreadyDecided(approvalId) {
  const current = await db('workflow_approvals').where({ id: approvalId }).first('status');
  return { ok: true, already: true, status: current ? current.status : null };
}

/**
 * `viaLink`: the emailed bearer token is what the lifetime bounds — a link
 * that outlived expires_at is refused and the row marked expired. The admin
 * inbox is authenticated and acts on the run itself, so it may still decide
 * an approval the link can no longer reach (a gate that waits longer than
 * the default lifetime would otherwise be stuck forever); it also takes an
 * approval a late link click already marked expired.
 */
async function finalizeApproval(approval, decision, actorPatch, { viaLink = false } = {}) {
  if (!approval) return { ok: false, reason: 'not_found' };
  const actionable = viaLink ? ['pending'] : ['pending', 'expired'];
  if (!actionable.includes(approval.status)) return { ok: true, already: true, status: approval.status };
  if (viaLink && isExpired(approval)) {
    const expired = await db('workflow_approvals').where({ id: approval.id, status: 'pending' })
      .update({ status: 'expired' });
    if (!expired) return alreadyDecided(approval.id);
    return { ok: false, reason: 'expired' };
  }
  // Master kill-switch: a decision must not record itself or resume a run
  // while workflows is off (the public link is reachable without the flag).
  // Fails closed when the flag cannot be read; the approval stays pending.
  if (!(await engine.workflowsEnabled())) return { ok: false, reason: 'disabled' };
  const status = decision === 'confirm' ? 'confirmed' : 'denied';
  // Compare-and-set on the pending status read above. The emailed link, the
  // inbox and a double click can all act at once; without the condition two
  // requests both passed the check and both resumed the run, so confirm and
  // deny could each run their branch (or one branch run twice).
  const decided = await db('workflow_approvals').where({ id: approval.id }).whereIn('status', actionable)
    .update({ status, acted_at: db.fn.now(), ...actorPatch });
  if (!decided) return alreadyDecided(approval.id);
  // Resume down the matching edge (handles 'confirm' | 'deny'). The flag is
  // read again inside resumeRun; when it flipped between the two reads the
  // decision is taken back, so the approval stays pending and usable rather
  // than decided on a run nothing will ever resume.
  if (await engine.resumeRun(approval.run_id, { decisionHandle: decision }) === 'disabled') {
    await db('workflow_approvals').where({ id: approval.id, status })
      .update({ status: 'pending', acted_at: null, acted_via: null, acted_by: null });
    return { ok: false, reason: 'disabled' };
  }
  return { ok: true, status };
}

/** Act on an approval via the emailed single-use token. */
async function actByToken(rawToken, decision) {
  const approval = await db('workflow_approvals').where({ token_hash: hashToken(rawToken) }).first();
  return finalizeApproval(approval, decision, { acted_via: 'email' }, { viaLink: true });
}

/**
 * Read-only lookup for the emailed token — used to render the confirm/deny
 * interstitial WITHOUT mutating state (so email-client prefetchers can't
 * advance the gate). Never resumes the run.
 */
async function peekApproval(rawToken) {
  const a = await db('workflow_approvals').where({ token_hash: hashToken(rawToken) }).first();
  if (!a) return { found: false };
  let prompt = null;
  try { prompt = (JSON.parse(a.payload || '{}') || {}).prompt || null; } catch (_) { /* ignore */ }
  return { found: true, status: a.status, prompt, expired: isExpired(a) };
}

/** Act on an approval from the admin webview inbox. */
async function actById(id, decision, adminId) {
  const approval = await db('workflow_approvals').where({ id }).first();
  return finalizeApproval(approval, decision, { acted_via: 'web', acted_by: adminId || null });
}

/**
 * Undecided approvals for the webview inbox, newest first, with workflow
 * name. An approval whose emailed link expired is still undecided and its
 * run still waits, so it stays in the inbox (see finalizeApproval).
 */
async function listPending(limit = 100) {
  return db('workflow_approvals as a')
    .join('workflow_runs as r', 'r.id', 'a.run_id')
    .join('workflows as w', 'w.id', 'r.workflow_id')
    .whereIn('a.status', ['pending', 'expired'])
    .select(
      'a.id', 'a.type', 'a.payload', 'a.created_at', 'a.expires_at',
      'r.id as run_id', 'r.entity_type', 'r.entity_id',
      'w.id as workflow_id', 'w.name as workflow_name',
    )
    .orderBy('a.created_at', 'desc')
    .limit(limit);
}

module.exports = { hashToken, createApproval, actByToken, actById, listPending, peekApproval };
