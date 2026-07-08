/**
 * Incoming-mail intake (migration 128). Polls the configured IMAP mailbox
 * every minute, parses each unseen message, and drops PDF/image attachments
 * into the incoming-invoices inbox (inbound_documents, source='email').
 *
 * Gated by the `incomingMail` feature flag. Idempotent: each message is logged
 * in received_emails keyed by message-id (skip if seen); duplicate attachments
 * are caught downstream by the inbound_documents SHA-256 dedup. Handles
 * forwarded messages because mailparser flattens nested attachments.
 */
const fsp = require('fs').promises;
const path = require('path');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { getStoragePath } = require('../config/storage');
const expenseService = require('./expenseService');
const sanitizeHtml = require('sanitize-html');
const { isUniqueViolation } = require('../utils/dbErrors');

const ALLOWED_MIME = ['application/pdf', 'image/jpeg', 'image/png'];
let polling = false;

// Fail fast instead of hanging on a wrong host/port (e.g. IMAP pointed at an
// SMTP port). Without these, ImapFlow waits indefinitely and the HTTP request
// dies at the proxy as a 502 with no useful message.
const IMAP_TIMEOUTS = { connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 30000 };
// Look back this far so the Received log captures mail already read in another
// client (the unseen-only fetch missed those). Dedup by message-id keeps each
// poll cheap — only un-logged messages are downloaded + processed.
const LOOKBACK_DAYS = 90;

function makeImapClient(cfg) {
  return new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false, ...IMAP_TIMEOUTS });
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

async function saveAttachment(att) {
  const year = new Date().getFullYear();
  const dir = path.join(getStoragePath(), 'business-docs', 'inbound', String(year));
  await fsp.mkdir(dir, { recursive: true });
  const ext = path.extname(att.filename || '')
    || (att.contentType === 'application/pdf' ? '.pdf' : att.contentType === 'image/png' ? '.png' : '.jpg');
  const filePath = path.join(dir, `email-${Date.now()}-${Math.floor(Math.random() * 1e6)}${ext}`);
  await fsp.writeFile(filePath, att.content);
  return filePath;
}

/**
 * List the mailbox folders on the IMAP server so the UI can offer a
 * dropdown instead of a free-text path. Uses the saved config; an
 * `override` ({ host, port, secure, user, pass }) lets the admin detect
 * folders BEFORE saving. A masked/blank override password falls back to
 * the stored one. Returns [{ path, name, specialUse }] (specialUse like
 * '\\Inbox' lets the caller auto-select the inbox).
 */
async function listFolders(override) {
  let cfg;
  if (override && override.host && override.user) {
    cfg = {
      host: override.host,
      port: override.port || 993,
      secure: override.secure !== false && override.secure !== 0,
      auth: { user: override.user, pass: override.pass || '' },
    };
    if (!cfg.auth.pass || cfg.auth.pass === '********') {
      const stored = await getImapConfig();
      cfg.auth.pass = stored?.auth?.pass || '';
    }
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
 * admin can test before saving; a masked/blank password falls back to stored.
 */
async function testConnection(override) {
  let cfg; let folder;
  if (override && override.host && override.user) {
    cfg = {
      host: override.host,
      port: override.port || 993,
      secure: override.secure !== false && override.secure !== 0,
      auth: { user: override.user, pass: override.pass || '' },
    };
    folder = override.folder || 'INBOX';
    if (!cfg.auth.pass || cfg.auth.pass === '********') {
      const stored = await getImapConfig();
      cfg.auth.pass = stored?.auth?.pass || '';
    }
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
  const transporter = nodemailer.createTransport({
    host: c.smtp_host,
    port: parseInt(c.smtp_port, 10),
    secure: c.smtp_secure === true || c.smtp_secure === 1,
    auth: c.smtp_user && c.smtp_pass ? { user: c.smtp_user, pass: c.smtp_pass } : undefined,
    tls: { rejectUnauthorized: c.tls_reject_unauthorized !== false },
  });
  try {
    await transporter.sendMail({
      from: `${c.from_name || 'picpeak'} <${c.from_email || c.smtp_user}>`,
      to: recipient,
      subject,
      text: `This is an automated picpeak round-trip test. Token: ${token}. Safe to ignore — it is deleted automatically.`,
    });
  } catch (err) {
    return { ok: false, sent: false, reason: 'send_failed', error: err.message };
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
  const client = makeImapClient(cfg);
  let processed = 0;
  try {
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
        for await (const m of client.fetch(uids, { uid: true, envelope: true }, { uid: true })) {
          candidates.push({ uid: m.uid, messageId: (m.envelope && m.envelope.messageId) || `uid-${cfg.folder}-${m.uid}` });
        }
      }

      // 3) Drop ones we've already logged (so each poll only does new work).
      const logged = new Set();
      for (let i = 0; i < candidates.length; i += 500) {
        const chunk = candidates.slice(i, i + 500).map((c) => c.messageId);
        const rows = await db('received_emails').whereIn('message_id', chunk).select('message_id');
        rows.forEach((r) => logged.add(r.message_id));
      }
      const fresh = candidates.filter((c) => !logged.has(c.messageId));

      // 4) Download + process each fresh message.
      for (const cand of fresh) {
        let messageId = cand.messageId;
        let claimKey = null;
        let claimed = false;
        try {
          const one = await client.fetchOne(String(cand.uid), { source: true }, { uid: true });
          if (!one || !one.source) continue;
          const parsed = await simpleParser(one.source);
          messageId = parsed.messageId || cand.messageId;
          // Claim key: a no-Message-ID mail still needs a non-null, per-message
          // key so two pollers converge — fall back to the mailbox uid.
          claimKey = messageId || `nomsgid-${cand.uid}`;

          // Fast-path: already processed. Recover a row left 'processing' by a
          // worker that crashed mid-ingest (>10 min) so the attachment isn't
          // orphaned — otherwise skip + mark seen.
          const existing = await db('received_emails').where({ message_id: claimKey }).first();
          if (existing) {
            const staleProcessing = existing.status === 'processing'
              && existing.created_at
              && (Date.now() - new Date(existing.created_at).getTime() > 10 * 60 * 1000);
            if (!staleProcessing) { await client.messageFlagsAdd(cand.uid, ['\\Seen'], { uid: true }); continue; }
            await db('received_emails').where({ id: existing.id }).del();
          }

          // CLAIM the message atomically BEFORE any ingest. The message_id UNIQUE
          // index (migration 128) makes this the real guard: if a second poller
          // (multi-replica / rolling deploy) already claimed it, the insert hits
          // the unique constraint and we skip cleanly — no double-ingest.
          try {
            await db('received_emails').insert({
              message_id: claimKey,
              account_key: accountKey,
              status: 'processing',
              attachment_count: 0,
              received_at: new Date(),
              created_at: new Date(),
            });
            claimed = true;
          } catch (ce) {
            if (isUniqueViolation(ce)) { await client.messageFlagsAdd(cand.uid, ['\\Seen'], { uid: true }); continue; }
            throw ce;
          }

          // Attachment handling. The accounting mailbox drops PDF/image
          // attachments into the incoming-invoices inbox (isolated so one bad
          // file can't prevent the audit row). Customer mailboxes only COUNT
          // attachments — they aren't supplier invoices.
          let inboundId = null;
          let count = 0;
          const attErrors = [];
          if (routeToExpenses) {
            const atts = (parsed.attachments || []).filter((a) => ALLOWED_MIME.includes(a.contentType));
            for (const att of atts) {
              try {
                const filePath = await saveAttachment(att);
                const doc = await expenseService.recordInboundDocument({ source: 'email', filePath, originalFilename: att.filename || 'attachment', mimeType: att.contentType }, null);
                inboundId = doc.id; count += 1;
              } catch (ae) {
                attErrors.push(ae.message);
                logger.error?.(`emailIntake: attachment "${att.filename}" failed: ${ae.message}`);
              }
            }
          } else {
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
          await db('received_emails').where({ message_id: claimKey }).update({
            from_address: ((parsed.from && parsed.from.text) || '').slice(0, 512) || null,
            to_address: ((parsed.to && parsed.to.text) || '').slice(0, 512) || null,
            subject: parsed.subject || null,
            received_at: receivedAt,
            attachment_count: count,
            status,
            inbound_document_id: inboundId,
            body_html: sanitizeBody(parsed.html || null),
            body_text: parsed.text || null,
            error: attErrors.length ? attErrors.join('; ').slice(0, 2000) : null,
          });
          await client.messageFlagsAdd(cand.uid, ['\\Seen'], { uid: true });
          processed += 1;
        } catch (e) {
          // Loud: this is exactly where a silent failure would hide a missing
          // Received row.
          logger.error?.(`emailIntake: message uid ${cand.uid} (${messageId}) failed: ${e.message}`);
          try {
            if (claimed && claimKey) {
              // We already claimed the row — mark it errored rather than orphan it.
              await db('received_emails').where({ message_id: claimKey })
                .update({ status: 'error', error: String(e.message).slice(0, 2000) });
            } else {
              await db('received_emails').insert({ message_id: `err-${cand.uid}-${Date.now()}`, account_key: accountKey, status: 'error', error: e.message, attachment_count: 0, received_at: new Date(), created_at: new Date() });
            }
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
    try { await client.close(); } catch (_e) { /* ignore */ }
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
  if (!(await isEnabled())) return { skipped: 'disabled' };
  polling = true;
  let processed = 0;
  let anyConfigured = false;
  try {
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
        extras = await db('mail_accounts').where({ enabled: true });
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
function startIncomingMailPoller() {
  const run = () => pollOnce().catch((e) => logger.error?.(`emailIntake: ${e.message}`));
  setTimeout(run, 15000); // first run shortly after boot
  setInterval(run, 60 * 1000);
  logger.info?.('Incoming-mail poller started (every 60s when enabled)');
}

module.exports = { pollOnce, startIncomingMailPoller, listFolders, testConnection, roundTripTest, _internal: { getImapConfig, isEnabled, saveAttachment } };
