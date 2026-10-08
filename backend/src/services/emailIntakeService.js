/**
 * Incoming-mail intake (migration 128). Polls the configured IMAP mailbox
 * every minute, parses each unseen message, and drops PDF/image attachments
 * into the incoming-invoices inbox (inbound_documents, source='email').
 *
 * Gated by the `incomingMail` feature flag. Idempotent: each message is logged
 * in received_emails keyed by message-id (skip if seen); duplicate attachments
 * reuse verified owned SHA-256 files before the accounting record is made.
 * Admission and retention share database-fenced byte/rate budgets. Handles
 * forwarded messages because mailparser flattens nested attachments.
 */
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { db } = require('../database/db');
const logger = require('../utils/logger');
const expenseService = require('./expenseService');
const mailRetention = require('./mailRetentionService');
const sanitizeHtml = require('sanitize-html');
const { formatBoolean } = require('../utils/dbCompat');
const { isMaskedOrBlank, sameImapTarget, PasswordRequiredError } = require('../utils/mailCredentialTarget');
const { mailSocketOptions, smtpConnectionOptions } = require('../utils/mailConnection');

const ALLOWED_MIME = ['application/pdf', 'image/jpeg', 'image/png'];

// Resource caps for inbound mail (GHSA-2qf9). Anyone who can email the
// operator's mailbox reaches this code path unauthenticated, and nothing here
// used to bound message size, attachment count or attachment bytes. Defaults
// are generous for real supplier invoices; all three are env-overridable.
const numFromEnv = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isSafeInteger(n) && n > 0 && n <= 2 ** 32 ? n : fallback;
};
const MAX_MESSAGE_BYTES = numFromEnv('EMAIL_INTAKE_MAX_MESSAGE_BYTES', 25 * 1024 * 1024);
// received_emails.message_id is varchar(512) WITH a UNIQUE constraint. A sender
// can legally emit a Message-ID longer than that; the insert then throws, the
// catch path stores a synthetic err-<uid>-<now> key that can never match the
// dedup pass, and every poll re-downloads and re-parses the same message
// forever. Collapse anything overlong to a stable hash so the key always fits
// and always reproduces (GHSA-2qf9).
const MESSAGE_ID_MAX = 512;
const boundedMessageId = (raw, fallback) => {
  const value = String(raw || fallback || '').trim() || String(fallback || '');
  if (value.length <= MESSAGE_ID_MAX) return value;
  return `sha256:${require('crypto').createHash('sha256').update(value).digest('hex')}`;
};
const MAX_ATTACHMENTS = numFromEnv('EMAIL_INTAKE_MAX_ATTACHMENTS', 25);
const MAX_ATTACHMENT_BYTES = numFromEnv('EMAIL_INTAKE_MAX_ATTACHMENT_BYTES', 25 * 1024 * 1024);

let polling = false;

// Fail fast instead of hanging on a wrong host/port (e.g. IMAP pointed at an
// SMTP port). Without these, ImapFlow waits indefinitely and the HTTP request
// dies at the proxy as a 502 with no useful message.
const IMAP_TIMEOUTS = { connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 30000 };
// Look back this far so the Received log captures mail already read in another
// client (the unseen-only fetch missed those). Dedup by message-id keeps each
// poll cheap — only un-logged messages are downloaded + processed. Retention
// owns the number: it must never remove a row whose message is still in here.
const { LOOKBACK_DAYS } = mailRetention;

function makeImapClient(cfg) {
  const connection = mailSocketOptions('imap', cfg.host, cfg.port);
  return new ImapFlow({ host: connection.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth,
    tls: connection, logger: false, ...IMAP_TIMEOUTS });
}

/** Connect with a hard ceiling, so a stuck TLS handshake can't hang forever. */
async function connectWithTimeout(client, ms = 12000) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('IMAP connection timed out')), ms); });
  try {
    await Promise.race([client.connect(), timeout]);
  } catch (err) {
    // Best-effort teardown if connect lost the race but is still pending.
    try { await client.logout(); } catch (_) { /* noop */ }
    try { client.close(); } catch (_) { /* noop */ }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function isEnabled() {
  const flag = await db('feature_flags').where({ key: 'incomingMail' }).first();
  return !!(flag && (flag.value === true || flag.value === 1 || flag.value === '1'));
}

async function getImapConfig() {
  const c = await db('email_configs').first();
  if (!c || !c.imap_host || !c.imap_user) return null;
  return {
    host: c.imap_host,
    port: c.imap_port || 993,
    secure: c.imap_secure !== false && c.imap_secure !== 0,
    auth: { user: c.imap_user, pass: c.imap_pass || '' },
    folder: c.imap_folder || 'INBOX',
  };
}

/**
 * The password for a caller-supplied connection. A masked or blank password
 * falls back to the stored one only when the connection targets the saved
 * server; anything else would send the stored password to a server the
 * caller chose.
 */
async function resolveOverridePassword(override) {
  if (!isMaskedOrBlank(override.pass)) return override.pass;
  const saved = await db('email_configs').first();
  const target = { imap_host: override.host, imap_port: override.port, imap_user: override.user, imap_secure: override.secure };
  if (saved && saved.imap_pass && sameImapTarget(saved, target)) return saved.imap_pass;
  throw new PasswordRequiredError('Enter the IMAP password: the saved password is only used for the server it was saved for.');
}

const saveAttachment = (att, claim) => mailRetention.saveAttachment(att, claim);

/**
 * List the mailbox folders on the IMAP server so the UI can offer a
 * dropdown instead of a free-text path. Uses the saved config; an
 * `override` ({ host, port, secure, user, pass }) lets the admin detect
 * folders BEFORE saving. A masked/blank override password falls back to
 * the stored one only for the saved server. Returns [{ path, name, specialUse }] (specialUse like
 * '\\Inbox' lets the caller auto-select the inbox).
 */
async function listFolders(override) {
  let cfg;
  if (override && override.host && override.user) {
    cfg = {
      host: override.host,
      port: override.port || 993,
      secure: override.secure !== false && override.secure !== 0,
      auth: { user: override.user, pass: await resolveOverridePassword(override) },
    };
  } else {
    cfg = await getImapConfig();
  }
  if (!cfg) return [];
  const client = makeImapClient(cfg);
  await connectWithTimeout(client);
  try {
    const list = await client.list();
    return (list || []).map((m) => ({ path: m.path, name: m.name, specialUse: m.specialUse || null }));
  } finally {
    await client.logout().catch(() => {});
  }
}

/**
 * Test the IMAP connection: log in, open the configured folder, and report
 * the message + unread counts. Non-destructive (marks nothing seen, ingests
 * nothing) — proves host/port/user/pass AND that the chosen folder opens.
 * Accepts an `override` ({ host, port, secure, user, pass, folder }) so the
 * admin can test before saving; a masked/blank password falls back to the
 * stored one only for the saved server.
 */
async function testConnection(override) {
  let cfg; let folder;
  if (override && override.host && override.user) {
    cfg = {
      host: override.host,
      port: override.port || 993,
      secure: override.secure !== false && override.secure !== 0,
      auth: { user: override.user, pass: await resolveOverridePassword(override) },
    };
    folder = override.folder || 'INBOX';
  } else {
    const c = await getImapConfig();
    if (!c) return { ok: false, error: 'unconfigured' };
    cfg = { host: c.host, port: c.port, secure: c.secure, auth: c.auth };
    folder = c.folder;
  }
  const client = makeImapClient(cfg);
  await connectWithTimeout(client);
  try {
    const status = await client.status(folder, { messages: true, unseen: true });
    return { ok: true, folder, messages: status.messages || 0, unseen: status.unseen || 0 };
  } finally {
    await client.logout().catch(() => {});
  }
}

/**
 * End-to-end round-trip test: send a uniquely-tagged email through the saved
 * SMTP (outgoing) config TO the IMAP mailbox, then poll IMAP until it arrives.
 * Proves the whole pipeline (outgoing delivery → incoming reception) in one
 * click. Uses SAVED config for both sides (real passwords needed to send +
 * read). Cleans up: the test message is deleted once found, so it never
 * reaches the accounting inbox.
 *
 * Returns { ok, seconds, recipient } on success, or { ok:false, sent, reason }.
 */
async function roundTripTest({ timeoutMs = 30000, intervalMs = 3000 } = {}) {
  const nodemailer = require('nodemailer');
  const crypto = require('crypto');
  const c = await db('email_configs').first();
  if (!c || !c.smtp_host || !c.smtp_port) return { ok: false, sent: false, reason: 'smtp_unconfigured' };
  if (!c.imap_host || !c.imap_user) return { ok: false, sent: false, reason: 'imap_unconfigured' };

  // Recipient = the mailbox we poll. imap_user is the mailbox address in the
  // typical setup (e.g. rechnungen@…). NOT hardcoded — but some hosts use a
  // non-email IMAP login, in which case we can't auto-address the test.
  const recipient = c.imap_user;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient || '')) {
    return { ok: false, sent: false, reason: 'recipient_not_email', recipient };
  }
  const token = `ppk-rt-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
  const subject = `picpeak round-trip test ${token}`;

  // 1) Send via the saved SMTP config (mirror the /test route's transport).
  try {
    const transporter = nodemailer.createTransport(smtpConnectionOptions({
      host: c.smtp_host,
      port: parseInt(c.smtp_port, 10),
      secure: c.smtp_secure === true || c.smtp_secure === 1,
      auth: c.smtp_user && c.smtp_pass ? { user: c.smtp_user, pass: c.smtp_pass } : undefined,
      tls: { rejectUnauthorized: c.tls_reject_unauthorized !== false },
    }));
    await transporter.sendMail({
      from: `${c.from_name || 'picpeak'} <${c.from_email || c.smtp_user}>`,
      to: recipient,
      subject,
      text: `This is an automated picpeak round-trip test. Token: ${token}. Safe to ignore — it is deleted automatically.`,
    });
  } catch (err) {
    return { ok: false, sent: false, reason: 'send_failed', error: err.message, code: err.code };
  }

  // 2) Poll IMAP for the tagged message until timeout.
  const cfg = await getImapConfig();
  const folder = cfg?.folder || 'INBOX';
  const client = makeImapClient(cfg);
  await connectWithTimeout(client);
  const started = Date.now();
  // Backoff (PR #622 nit 4): some IMAP servers throttle frequent SELECT/SEARCH.
  // Grow the gap ×1.5 (cap 8s) so a 30s test does ~5 polls, not ~10.
  let delay = intervalMs;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const lock = await client.getMailboxLock(folder);
      try {
        const uids = await client.search({ subject: token }, { uid: true });
        if (uids && uids.length) {
          await client.messageDelete(uids, { uid: true }).catch(() => {});
          return { ok: true, seconds: Math.round((Date.now() - started) / 1000), recipient };
        }
      } finally {
        lock.release();
      }
      if (Date.now() - started > timeoutMs) {
        return { ok: false, sent: true, reason: 'not_received', recipient };
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(Math.round(delay * 1.5), 8000);
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

// Sanitize an inbound HTML body before storing it. Inbound mail is untrusted,
// so this strips scripts/handlers/unknown schemes (the viewer ALSO renders it
// in a script-less sandboxed iframe — defense in depth). Remote images are kept
// (many legit emails embed them) but that is the only tracking-vector allowed.
function sanitizeBody(html) {
  if (!html) return null;
  try {
    return sanitizeHtml(html, {
      allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img']),
      allowedAttributes: {
        ...sanitizeHtml.defaults.allowedAttributes,
        img: ['src', 'alt', 'width', 'height'],
        '*': ['style'],
      },
      allowedSchemes: ['http', 'https', 'mailto', 'cid'],
    });
  } catch (_) {
    return null;
  }
}

/**
 * Poll ONE mailbox once and return the count of newly-processed messages.
 * `opts.accountKey` tags each received_emails row; `opts.routeToExpenses`
 * controls whether PDF/image attachments are dropped into the accounting inbox
 * (true for the primary rechnungen@ mailbox) or only logged with the body
 * (customer mail, e.g. hello@). The claim/dedup/stale-recovery logic is
 * identical for every mailbox.
 */
async function pollAccountOnce(cfg, { accountKey = 'accounting', routeToExpenses = true } = {}) {
  let client;
  let processed = 0;
  try {
    client = makeImapClient(cfg);
    await connectWithTimeout(client);
    const lock = await client.getMailboxLock(cfg.folder);
    /* eslint-disable no-await-in-loop */
    try {
      // 1) Candidate UIDs within the lookback window — regardless of \Seen, so
      //    mail already read elsewhere is still logged. Fall back to unseen-only
      //    if the server rejects a SINCE search.
      const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000);
      let uids = [];
      try { uids = (await client.search({ since }, { uid: true })) || []; } catch (_) { uids = []; }
      if (!uids.length) { try { uids = (await client.search({ seen: false }, { uid: true })) || []; } catch (_) { uids = []; } }

      // 2) Cheap envelope-only pass → uid + message-id (no source download).
      const candidates = [];
      if (uids.length) {
        // eslint-disable-next-line no-restricted-syntax
        // `size` rides along in the same cheap envelope pass, so an oversized
        // message can be rejected BEFORE its source is downloaded (GHSA-2qf9).
        for await (const m of client.fetch(uids, { uid: true, envelope: true, size: true }, { uid: true })) {
          candidates.push({
            uid: m.uid,
            size: Number(m.size) || 0,
            sender: m.envelope?.from?.[0]?.address || '<unknown>',
            messageId: boundedMessageId(
              m.envelope && m.envelope.messageId,
              `uid-${require('crypto').createHash('sha256').update(`${accountKey}\0${cfg.host}\0${cfg.auth.user}\0${cfg.folder}\0${client.mailbox?.uidValidity || 'unknown'}\0${m.uid}`).digest('hex')}`,
            ),
          });
        }
      }

      // 3) Drop ones we've already logged (so each poll only does new work).
      //    An expired message keeps a body-less row for as long as it can
      //    still be found here, so retention never causes a second import.
      const logged = new Set();
      for (let i = 0; i < candidates.length; i += 500) {
        const chunk = candidates.slice(i, i + 500).map((c) => c.messageId);
        const rows = await db('received_emails').whereIn('message_id', chunk).select('message_id');
        rows.forEach((r) => logged.add(r.message_id));
      }
      const fresh = candidates.filter((c) => !logged.has(c.messageId));

      // 4) Download + process each fresh message. A capacity or rate refusal
      //    stores nothing and leaves the message unread for a later poll;
      //    within this poll, do not ask again for what the same limit refuses.
      let refusedBytes = Infinity;
      const refusedSenders = new Set();
      for (const cand of fresh) {
        let messageId = cand.messageId;
        let claim = null;
        try {
          // Refuse oversized messages before download (GHSA-2qf9). Recorded
          // under the REAL message id — not a synthetic err-<uid>-<now> key —
          // so the step-3 dedup skips it on the next poll. Without that, the
          // same huge message was re-downloaded every poll interval forever,
          // and an OOM-kill/restart simply resumed the loop.
          const oversized = cand.size > MAX_MESSAGE_BYTES;
          const bytes = 2 * (cand.size > 0 ? cand.size : MAX_MESSAGE_BYTES) + mailRetention.META_BYTES
            + (routeToExpenses ? MAX_ATTACHMENTS * mailRetention.AUDIT_BYTES : 0);
          if (bytes >= refusedBytes || refusedSenders.has(cand.sender)) continue;
          const admission = await mailRetention.admit({
            messageId: cand.messageId, accountKey, sender: cand.sender, bytes,
            error: oversized ? `Message too large (${cand.size} bytes); limit is ${MAX_MESSAGE_BYTES}` : null,
          });
          if (admission.retry) {
            if (admission.limit === 'EMAIL_INTAKE_SENDER_PER_HOUR') refusedSenders.add(cand.sender);
            else if (admission.limit.endsWith('_BYTES')) refusedBytes = bytes;
            else break;
            continue;
          }
          if (admission.skip) {
            await client.messageFlagsAdd(cand.uid, ['\\Seen'], { uid: true });
            continue;
          }
          claim = admission;
          const one = await client.fetchOne(String(cand.uid), { source: true }, { uid: true });
          if (!one || !one.source) throw new Error('Message source unavailable');
          if (one.source.length > MAX_MESSAGE_BYTES) throw new Error('Downloaded message exceeds the message-size limit');
          const parsed = await simpleParser(one.source);
          messageId = boundedMessageId(parsed.messageId, cand.messageId);
          if (!(await mailRetention.rekey(claim, messageId))) {
            await client.messageFlagsAdd(cand.uid, ['\\Seen'], { uid: true });
            continue;
          }

          const bodyHtml = sanitizeBody(parsed.html || null);
          const bodyText = parsed.text || null;

          // Attachment handling. The accounting mailbox drops PDF/image
          // attachments into the incoming-invoices inbox (isolated so one bad
          // file can't prevent the audit row). Customer mailboxes only COUNT
          // attachments — they aren't supplier invoices.
          let inboundId = null;
          let count = 0;
          const attErrors = [];
          if (routeToExpenses) {
            const allowed = (parsed.attachments || []).filter((a) => ALLOWED_MIME.includes(a.contentType));
            // Cap attachment count AND cumulative bytes (GHSA-2qf9) — a single
            // in-limit message can still carry hundreds of attachments, each
            // written to disk by saveAttachment().
            const atts = [];
            let attBytes = 0;
            for (const att of allowed) {
              if (atts.length >= MAX_ATTACHMENTS) {
                attErrors.push(`Attachment limit reached (${MAX_ATTACHMENTS}); remaining attachments skipped`);
                break;
              }
              const size = att.content ? att.content.length : 0;
              if (attBytes + size > MAX_ATTACHMENT_BYTES) {
                attErrors.push(`Cumulative attachment size limit reached (${MAX_ATTACHMENT_BYTES} bytes); remaining attachments skipped`);
                break;
              }
              attBytes += size;
              atts.push(att);
            }
            await mailRetention.checkSize(claim, Buffer.byteLength(bodyHtml || '') + Buffer.byteLength(bodyText || ''), atts);
            for (const att of atts) {
              try {
                const filePath = await saveAttachment(att, claim);
                const doc = await expenseService.recordInboundDocument({ source: 'email', filePath, originalFilename: (att.filename || 'attachment').slice(0, 512), mimeType: att.contentType, mailClaim: claim }, null);
                inboundId = doc.id; count += 1;
              } catch (ae) {
                attErrors.push(ae.message);
                logger.error?.(`emailIntake: attachment "${att.filename}" failed: ${ae.message}`);
              }
            }
          } else {
            await mailRetention.checkSize(claim, Buffer.byteLength(bodyHtml || '') + Buffer.byteLength(bodyText || ''), []);
            count = (parsed.attachments || []).length;
          }

          // A malformed Date: header yields an Invalid Date, which throws on a
          // Postgres timestamp insert — coerce to now.
          const receivedAt = (parsed.date instanceof Date && !Number.isNaN(parsed.date.getTime())) ? parsed.date : new Date();
          const status = routeToExpenses
            ? (count > 0 ? 'ingested' : (attErrors.length ? 'error' : 'no_attachment'))
            : 'received';
          // Finalise the claimed row — every processed message ends up in the
          // Received log with its (sanitized) body, even attachment-less ones.
          await mailRetention.finish(claim, {
            from_address: ((parsed.from && parsed.from.text) || '').slice(0, 512) || null,
            to_address: ((parsed.to && parsed.to.text) || '').slice(0, 512) || null,
            subject: (parsed.subject || '').slice(0, 512) || null,
            received_at: receivedAt,
            attachment_count: count,
            status,
            inbound_document_id: inboundId,
            body_html: bodyHtml,
            body_text: bodyText,
            error: attErrors.length ? attErrors.join('; ').slice(0, 2000) : null,
          });
          await client.messageFlagsAdd(cand.uid, ['\\Seen'], { uid: true });
          processed += 1;
        } catch (e) {
          // Loud: this is exactly where a silent failure would hide a missing
          // Received row.
          logger.error?.(`emailIntake: message uid ${cand.uid} (${messageId}) failed: ${e.message}`);
          try {
            if (claim) await mailRetention.fail(claim, e);
          } catch (ie) {
            logger.error?.(`emailIntake: could not even write the error row (received_emails insert failing): ${ie.message}`);
          }
        }
      }
    } finally {
      lock.release();
    }
    /* eslint-enable no-await-in-loop */
    await client.logout();
  } catch (e) {
    logger.error?.(`emailIntake: poll failed (${accountKey}): ${e.message}`);
    try { await client?.close(); } catch (_e) { /* ignore */ }
  }
  return processed;
}

/**
 * Poll ALL configured inbound mailboxes once: the primary accounting IMAP
 * (email_configs) plus every enabled row in mail_accounts (e.g. hello@).
 * Safe to call repeatedly; self-skips when busy/off.
 */
async function pollOnce() {
  if (polling) return { skipped: 'busy' };
  polling = true;
  let processed = 0;
  let anyConfigured = false;
  try {
    await mailRetention.sweep();
    if (!(await isEnabled())) return { skipped: 'disabled' };
    // 1) Primary accounting mailbox — routes attachments to the invoices inbox.
    const acctCfg = await getImapConfig();
    if (acctCfg) {
      anyConfigured = true;
      processed += await pollAccountOnce(acctCfg, { accountKey: 'accounting', routeToExpenses: true });
    }
    // 2) Additional mailboxes (customers/hello@) — body captured, no expense
    //    routing. Guarded so a pre-migration DB simply polls the accounting box.
    let extras = [];
    try {
      if (await db.schema.hasTable('mail_accounts')) {
        extras = await db('mail_accounts').where({ enabled: formatBoolean(true) });
      }
    } catch (_) { extras = []; }
    for (const a of extras) {
      if (!a.imap_host || !a.imap_user) continue;
      anyConfigured = true;
      const cfg = {
        host: a.imap_host,
        port: a.imap_port || 993,
        secure: a.imap_secure !== false && a.imap_secure !== 0,
        auth: { user: a.imap_user, pass: a.imap_pass || '' },
        folder: a.imap_folder || 'INBOX',
      };
      // eslint-disable-next-line no-await-in-loop
      processed += await pollAccountOnce(cfg, { accountKey: a.account_key, routeToExpenses: false });
    }
  } finally {
    polling = false;
  }
  if (!anyConfigured) return { skipped: 'unconfigured' };
  return { processed };
}

/** Start the 1-minute poll loop (mirrors the outgoing queue cadence). */
const mailPoller = require('./scheduledTask').scheduledTask(pollOnce, { interval: 60000, initialDelay: 15000 });
function startIncomingMailPoller() { mailPoller.start(); }
const stopIncomingMailPoller = () => mailPoller.stop();

module.exports = { stopIncomingMailPoller, pollOnce, startIncomingMailPoller, listFolders, testConnection, roundTripTest, _internal: { getImapConfig, isEnabled, saveAttachment } };
