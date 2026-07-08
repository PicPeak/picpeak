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

/**
 * gate_setup action — create the approval + email the admin. Called by the
 * engine when a gate node is reached. Best-effort on the email; the approval
 * row (and thus the inbox path) is always created.
 */
async function createApproval(ctx) {
  const { run, node } = ctx;
  const cfg = node.config || {};
  const raw = crypto.randomBytes(32).toString('hex');
  const expiresAt = cfg.timeoutDays
    ? new Date(Date.now() + Number(cfg.timeoutDays) * 86400000).toISOString()
    : null;

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
      await emailProcessor.queueEmail(
        ctx.vars?.eventId || null,
        adminEmail,
        cfg.emailType || 'workflow_approval',
        {
          prompt: cfg.prompt || 'A workflow needs your confirmation.',
          confirm_url: confirmUrl,
          deny_url: denyUrl,
          ...(ctx.vars?.emailData || {}),
        },
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

async function finalizeApproval(approval, decision, actorPatch) {
  if (!approval) return { ok: false, reason: 'not_found' };
  if (approval.status !== 'pending') return { ok: true, already: true, status: approval.status };
  if (approval.expires_at && new Date(approval.expires_at).getTime() < Date.now()) {
    await db('workflow_approvals').where({ id: approval.id }).update({ status: 'expired' });
    return { ok: false, reason: 'expired' };
  }
  const status = decision === 'confirm' ? 'confirmed' : 'denied';
  await db('workflow_approvals').where({ id: approval.id })
    .update({ status, acted_at: db.fn.now(), ...actorPatch });
  // Resume down the matching edge (handles 'confirm' | 'deny').
  await engine.resumeRun(approval.run_id, { decisionHandle: decision });
  return { ok: true, status };
}

/** Act on an approval via the emailed single-use token. */
async function actByToken(rawToken, decision) {
  const approval = await db('workflow_approvals').where({ token_hash: hashToken(rawToken) }).first();
  return finalizeApproval(approval, decision, { acted_via: 'email' });
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
  const expired = !!(a.expires_at && new Date(a.expires_at).getTime() < Date.now());
  return { found: true, status: a.status, prompt, expired };
}

/** Act on an approval from the admin webview inbox. */
async function actById(id, decision, adminId) {
  const approval = await db('workflow_approvals').where({ id }).first();
  return finalizeApproval(approval, decision, { acted_via: 'web', acted_by: adminId || null });
}

/** Pending approvals for the webview inbox, newest first, with workflow name. */
async function listPending(limit = 100) {
  return db('workflow_approvals as a')
    .join('workflow_runs as r', 'r.id', 'a.run_id')
    .join('workflows as w', 'w.id', 'r.workflow_id')
    .where('a.status', 'pending')
    .select(
      'a.id', 'a.type', 'a.payload', 'a.created_at', 'a.expires_at',
      'r.id as run_id', 'r.entity_type', 'r.entity_id',
      'w.id as workflow_id', 'w.name as workflow_name',
    )
    .orderBy('a.created_at', 'desc')
    .limit(limit);
}

module.exports = { hashToken, createApproval, actByToken, actById, listPending, peekApproval };
