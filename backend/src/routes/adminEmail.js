const express = require('express');
const nodemailer = require('nodemailer');
const { body, query, validationResult } = require('express-validator');
const { db, logActivity } = require('../database/db');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
// Gate the NEW Messages routes on the `messaging` flag (per-route, NOT the whole
// /email mount — the pre-existing config/queue/received endpoints stay ungated).
const { requireFeatureFlag } = require('../middleware/requireFeatureFlag');
const messagingGate = requireFeatureFlag('messaging');
const { wrapEmailHtml, processEmailQueue } = require('../services/emailProcessor');
const { errorResponse } = require('../utils/routeHelpers');
const logger = require('../utils/logger');
const router = express.Router();

// Get email configuration
router.get('/config', adminAuth, requirePermission('email.view'), async (req, res) => {
  try {
    const config = await db('email_configs').first();
    
    if (!config) {
      return res.json({
        smtp_host: '',
        smtp_port: 587,
        smtp_secure: false,
        smtp_user: '',
        smtp_pass: '', // Don't send actual password
        from_email: '',
        from_name: '',
        tls_reject_unauthorized: true
      });
    }

    // Don't send the actual password
    res.json({
      ...config,
      smtp_pass: config.smtp_pass ? '********' : ''
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to fetch email configuration');
  }
});

// Update email configuration
router.post('/config', [
  adminAuth,
  requirePermission('email.edit'),
  body('smtp_host').notEmpty().withMessage('SMTP host is required'),
  body('smtp_port').isInt({ min: 1, max: 65535 }).withMessage('Invalid port number'),
  body('from_email').isEmail().withMessage('Invalid from email address')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const {
      smtp_host,
      smtp_port,
      smtp_secure,
      smtp_user,
      smtp_pass,
      from_email,
      from_name,
      tls_reject_unauthorized
    } = req.body;

    // Validate SMTP host is not a private/internal address (SSRF protection)
    const { isPrivateIP } = require('../utils/networkValidation');
    if (isPrivateIP(smtp_host)) {
      return res.status(400).json({ error: 'SMTP host cannot point to a private or internal network address' });
    }

    // Check if config exists
    const existingConfig = await db('email_configs').first();
    
    const configData = {
      smtp_host,
      smtp_port: parseInt(smtp_port),
      smtp_secure: smtp_secure || false,
      smtp_user: smtp_user || '',
      from_email,
      from_name: from_name || 'Photo Sharing',
      tls_reject_unauthorized: tls_reject_unauthorized !== false, // Default to true
      updated_at: new Date()
    };

    // Only update password if provided and not masked
    if (smtp_pass && smtp_pass !== '********') {
      configData.smtp_pass = smtp_pass;
    }

    if (existingConfig) {
      await db('email_configs')
        .where('id', existingConfig.id)
        .update(configData);
    } else {
      await db('email_configs').insert(configData);
    }

    // Refresh the cached transporter so the new SMTP settings take effect
    // immediately. Without this, a previously-initialised transporter stays
    // cached (the queue processor only re-inits when it's null), so changing
    // the email account had no effect until a backend restart — emails kept
    // failing against the old/empty config. initializeTransporter catches its
    // own errors and returns null, so this never throws; an invalid config
    // simply leaves the transporter null (surfaced via the Test-email button).
    const { initializeTransporter } = require('../services/emailProcessor');
    await initializeTransporter(true);

    // Log activity
    await logActivity('email_config_updated', 
      { smtp_host, from_email }, 
      null, 
      { type: 'admin', id: req.admin.id, name: req.admin.username }
    );

    res.json({ message: 'Email configuration updated successfully' });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to update email configuration');
  }
});

// ── Incoming mail (IMAP) config — a second block alongside outgoing SMTP ──
router.get('/incoming-config', adminAuth, requirePermission('email.view'), async (req, res) => {
  try {
    const c = await db('email_configs').first();
    res.json({
      imap_host: c?.imap_host || '',
      imap_port: c?.imap_port || 993,
      imap_secure: c?.imap_secure !== false,
      imap_user: c?.imap_user || '',
      imap_pass: c?.imap_pass ? '********' : '', // never send the real password
      imap_folder: c?.imap_folder || 'INBOX',
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to fetch incoming mail configuration');
  }
});

router.post('/incoming-config', [
  adminAuth,
  requirePermission('email.edit'),
  body('imap_host').notEmpty().withMessage('IMAP host is required'),
  body('imap_port').isInt({ min: 1, max: 65535 }).withMessage('Invalid port number'),
  // IMAP always needs a login (unlike SMTP relay) — the poller's
  // getImapConfig() returns null without a username, so require it.
  body('imap_user').notEmpty().withMessage('IMAP username is required'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { imap_host, imap_port, imap_secure, imap_user, imap_pass, imap_folder } = req.body;
    const { isPrivateIP } = require('../utils/networkValidation');
    if (isPrivateIP(imap_host)) {
      return res.status(400).json({ error: 'IMAP host cannot point to a private or internal network address' });
    }
    const existing = await db('email_configs').first();
    const data = {
      imap_host,
      imap_port: parseInt(imap_port),
      imap_secure: imap_secure || false,
      imap_user: imap_user || '',
      imap_folder: imap_folder || 'INBOX',
      updated_at: new Date(),
    };
    if (imap_pass && imap_pass !== '********') data.imap_pass = imap_pass;
    if (existing) await db('email_configs').where('id', existing.id).update(data);
    else await db('email_configs').insert(data);
    await logActivity('incoming_mail_config_updated', { imap_host }, null, { type: 'admin', id: req.admin.id, name: req.admin.username });
    res.json({ message: 'Incoming mail configuration updated successfully' });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to update incoming mail configuration');
  }
});

// Received-emails log (the IMAP poller's audit trail) — "Received emails" tab.
// List IMAP folders so the UI can offer a dropdown (auto-detect) instead of a
// free-text path. Accepts optional creds in the body to detect before saving;
// falls back to the stored config (and stored password when masked).
router.post('/incoming-config/folders', adminAuth, requirePermission('email.view'), async (req, res) => {
  try {
    const { imap_host, imap_port, imap_secure, imap_user, imap_pass } = req.body || {};
    if (imap_host) {
      const { isPrivateIP } = require('../utils/networkValidation');
      if (isPrivateIP(imap_host)) {
        return res.status(400).json({ error: 'IMAP host cannot point to a private or internal network address' });
      }
    }
    const emailIntakeService = require('../services/emailIntakeService');
    const folders = await emailIntakeService.listFolders(
      imap_host ? { host: imap_host, port: imap_port, secure: imap_secure, user: imap_user, pass: imap_pass } : undefined
    );
    res.json({ folders });
  } catch (error) {
    logger.error('IMAP folder detection error:', error);
    res.status(422).json({ error: `Could not connect to the mailbox (${error.message}). Check host, port (IMAP is usually 993) and credentials.` });
  }
});

// Test the incoming-mail connection: log in + open the configured folder and
// report message/unread counts. Accepts current form creds (test before save).
router.post('/incoming-config/test', adminAuth, requirePermission('email.view'), async (req, res) => {
  try {
    const { imap_host, imap_port, imap_secure, imap_user, imap_pass, imap_folder } = req.body || {};
    if (imap_host) {
      const { isPrivateIP } = require('../utils/networkValidation');
      if (isPrivateIP(imap_host)) {
        return res.status(400).json({ error: 'IMAP host cannot point to a private or internal network address' });
      }
    }
    const emailIntakeService = require('../services/emailIntakeService');
    const result = await emailIntakeService.testConnection(
      imap_host ? { host: imap_host, port: imap_port, secure: imap_secure, user: imap_user, pass: imap_pass, folder: imap_folder } : undefined
    );
    if (result && result.ok === false) {
      return res.status(400).json({ error: 'Incoming mail is not configured yet — enter host, username and password first.' });
    }
    res.json(result);
  } catch (error) {
    logger.error('IMAP connection test error:', error);
    res.status(422).json({ error: `Could not connect to the mailbox (${error.message}). Check host, port (IMAP is usually 993), credentials and folder.` });
  }
});

// End-to-end round-trip: send via SMTP to the IMAP mailbox, then confirm it
// arrives. Uses saved config for both sides (real passwords needed).
router.post('/incoming-config/roundtrip', adminAuth, requirePermission('email.send'), async (req, res) => {
  try {
    const emailIntakeService = require('../services/emailIntakeService');
    const result = await emailIntakeService.roundTripTest();
    if (result.ok) return res.json(result);
    const map = {
      smtp_unconfigured: 'Configure and save the outgoing SMTP settings first.',
      imap_unconfigured: 'Configure and save the incoming IMAP settings first.',
      recipient_not_email: `The IMAP username (“${result.recipient || ''}”) isn’t an email address, so the round-trip test can’t auto-address itself. Use a mailbox whose username is its email, or send a test email there manually and use “Test connection”.`,
      send_failed: `Could not send the test email${result.error ? `: ${result.error}` : ''}.`,
      not_received: 'The email was sent but did not arrive within 30s — possible delivery delay/greylisting. Check the Received emails tab in a moment.',
    };
    return res.status(result.reason === 'not_received' ? 504 : 400)
      .json({ error: map[result.reason] || 'Round-trip test failed.', sent: !!result.sent, recipient: result.recipient });
  } catch (error) {
    logger.error('Round-trip test error:', error);
    res.status(422).json({ error: `Round-trip test failed (${error.message}) — check both SMTP and IMAP settings.` });
  }
});

// Run the incoming-mail poller on demand (instead of waiting for the 60s loop)
// so the admin can verify ingestion + see why nothing arrived. Respects the
// incomingMail flag — a manual run still won't ingest when the feature is off.
router.post('/incoming-config/poll', adminAuth, requirePermission('email.view'), async (req, res) => {
  try {
    const emailIntakeService = require('../services/emailIntakeService');
    const result = await emailIntakeService.pollOnce();
    res.json(result); // { processed } or { skipped: 'disabled'|'unconfigured'|'busy' }
  } catch (error) {
    logger.error('Manual poll error:', error);
    res.status(422).json({ error: `Mailbox poll failed (${error.message}).` });
  }
});

router.get('/received', adminAuth, requirePermission('email.view'), async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
    const account = req.query.account ? String(req.query.account) : null;
    // mailbox_state filter: no param → active (+ legacy NULL); else exact.
    const state = ['archived', 'deleted'].includes(String(req.query.state)) ? String(req.query.state) : 'active';
    // Optional full-table search (sender / subject) so results aren't truncated
    // to the first page before matching.
    const q = req.query.q ? String(req.query.q).trim().slice(0, 255) : '';
    // 'accounting' matches legacy rows too (account_key was NULL before mig 154).
    const applyAccount = (qb) => {
      if (account === 'accounting') qb.where((b) => b.where('account_key', 'accounting').orWhereNull('account_key'));
      else if (account) qb.where('account_key', account);
      if (state === 'active') qb.where((b) => b.where('mailbox_state', 'active').orWhereNull('mailbox_state'));
      else qb.where('mailbox_state', state);
      if (q) qb.where((b) => b.where('from_address', 'like', `%${q}%`).orWhere('subject', 'like', `%${q}%`));
      return qb;
    };
    const countRow = await applyAccount(db('received_emails')).count({ c: '*' }).first();
    const total = parseInt(countRow?.c || 0, 10);
    // Bodies are excluded from the list (can be large); fetched per-message.
    const items = await applyAccount(db('received_emails'))
      .select('id', 'message_id', 'account_key', 'from_address', 'to_address', 'subject',
        'received_at', 'attachment_count', 'status', 'inbound_document_id', 'error')
      .orderBy('received_at', 'desc').limit(pageSize).offset((page - 1) * pageSize);
    res.json({ items, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to fetch received emails');
  }
});

// Single received email WITH its captured (server-sanitized) body — Messages
// reading pane. body_html was already sanitized on ingest; the viewer renders
// it in a script-less sandboxed iframe as well.
router.get('/received/:id', adminAuth, messagingGate, requirePermission('email.view'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await db('received_emails').where({ id }).first();
    if (!row) return res.status(404).json({ error: 'Email not found' });
    res.json(row);
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to fetch email');
  }
});

// Move an email between mailbox states: Archive / Delete (soft) or Restore
// (back to active). kind = 'queue' | 'received'. Delete is a soft move to the
// trash; the row is only removed for good by the DELETE handler below.
router.post('/item/:kind/:id/state', adminAuth, messagingGate, requirePermission('email.view'), async (req, res) => {
  try {
    const table = req.params.kind === 'received' ? 'received_emails' : req.params.kind === 'queue' ? 'email_queue' : null;
    if (!table) return res.status(400).json({ error: 'Invalid kind' });
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
    const state = String(req.body?.state || '');
    if (!['active', 'archived', 'deleted'].includes(state)) return res.status(400).json({ error: 'Invalid state' });
    const n = await db(table).where({ id }).update({ mailbox_state: state });
    if (!n) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to update email');
  }
});

// Permanently delete an email row — only offered from the Deleted folder.
router.delete('/item/:kind/:id', adminAuth, messagingGate, requirePermission('email.edit'), async (req, res) => {
  try {
    const table = req.params.kind === 'received' ? 'received_emails' : req.params.kind === 'queue' ? 'email_queue' : null;
    if (!table) return res.status(400).json({ error: 'Invalid kind' });
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
    await db(table).where({ id }).del();
    res.json({ ok: true });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to delete email');
  }
});

// Additional inbound mailboxes (beyond the primary accounting IMAP in
// email_configs) — e.g. the customer hello@ box. Passwords are masked out.
router.get('/accounts', adminAuth, messagingGate, requirePermission('email.view'), async (req, res) => {
  try {
    const rows = await db('mail_accounts').orderBy('id');
    res.json({ items: rows.map((a) => ({
      ...a,
      imap_pass: a.imap_pass ? '********' : '',
      smtp_pass: a.smtp_pass ? '********' : '',
    })) });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to load mail accounts');
  }
});

// Resolved sender/mailbox addresses for the Messages UI — so the sidebar shows
// the REAL configured addresses instead of hardcoded placeholders. Accounting =
// the primary IMAP login (rechnungen@); customers = the hello@ mailbox; the
// automated stream sends from the global SMTP from-address.
router.get('/identities', adminAuth, messagingGate, requirePermission('email.view'), async (req, res) => {
  try {
    const cfg = await db('email_configs').first();
    let customers = null;
    try {
      const cust = await db('mail_accounts').where({ account_key: 'customers' }).first();
      customers = cust?.imap_user || cust?.from_email || null;
    } catch (_) { customers = null; }
    res.json({
      automated: cfg?.from_email || null,
      accounting: cfg?.imap_user || null,
      customers,
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to load mail identities');
  }
});

// Upsert a mailbox by account_key. A masked password ('********') keeps the
// stored value so the admin never has to re-type it.
router.post('/accounts', adminAuth, messagingGate, requirePermission('email.edit'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.account_key) return res.status(400).json({ error: 'account_key is required' });
    // SSRF guard — mirror /config + /incoming-config: neither the IMAP nor the
    // SMTP host may point at a private/internal address.
    const { isPrivateIP } = require('../utils/networkValidation');
    if (b.imap_host && isPrivateIP(b.imap_host)) {
      return res.status(400).json({ error: 'IMAP host cannot point to a private or internal network address' });
    }
    if (b.smtp_host && isPrivateIP(b.smtp_host)) {
      return res.status(400).json({ error: 'SMTP host cannot point to a private or internal network address' });
    }
    const patch = {
      label: b.label || null,
      imap_host: b.imap_host || null,
      imap_port: b.imap_port ? parseInt(b.imap_port, 10) : 993,
      imap_secure: b.imap_secure !== false,
      imap_user: b.imap_user || null,
      imap_folder: b.imap_folder || 'INBOX',
      // Outgoing (SMTP) identity — replies from this mailbox send from here.
      smtp_host: b.smtp_host || null,
      smtp_port: b.smtp_port ? parseInt(b.smtp_port, 10) : 587,
      smtp_secure: b.smtp_secure === true,
      smtp_user: b.smtp_user || null,
      from_email: b.from_email || null,
      from_name: b.from_name || null,
      enabled: !!b.enabled,
      updated_at: new Date(),
    };
    if (b.imap_pass && b.imap_pass !== '********') patch.imap_pass = b.imap_pass;
    if (b.smtp_pass && b.smtp_pass !== '********') patch.smtp_pass = b.smtp_pass;
    const existing = await db('mail_accounts').where({ account_key: b.account_key }).first();
    if (existing) {
      await db('mail_accounts').where({ account_key: b.account_key }).update(patch);
    } else {
      await db('mail_accounts').insert({
        account_key: b.account_key,
        imap_pass: (b.imap_pass && b.imap_pass !== '********') ? b.imap_pass : '',
        smtp_pass: (b.smtp_pass && b.smtp_pass !== '********') ? b.smtp_pass : '',
        created_at: new Date(),
        ...patch,
      });
    }
    res.json({ ok: true });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to save mail account');
  }
});

// Test an inbound mailbox's IMAP connection (before or after saving). Resolves
// a masked/blank password from the stored row for the given account_key.
router.post('/accounts/test', adminAuth, messagingGate, requirePermission('email.view'), async (req, res) => {
  try {
    const b = req.body || {};
    const { isPrivateIP } = require('../utils/networkValidation');
    if (b.imap_host && isPrivateIP(b.imap_host)) {
      return res.status(400).json({ error: 'IMAP host cannot point to a private or internal network address' });
    }
    let pass = b.imap_pass;
    if ((!pass || pass === '********') && b.account_key) {
      const stored = await db('mail_accounts').where({ account_key: b.account_key }).first();
      pass = stored?.imap_pass || '';
    }
    const emailIntakeService = require('../services/emailIntakeService');
    const result = await emailIntakeService.testConnection({
      host: b.imap_host, port: b.imap_port, secure: b.imap_secure,
      user: b.imap_user, pass, folder: b.imap_folder || 'INBOX',
    });
    res.json(result);
  } catch (error) {
    res.status(422).json({ ok: false, error: `Mailbox test failed (${error.message}).` });
  }
});

// Test email configuration
router.post('/test', adminAuth, requirePermission('email.send'), async (req, res) => {
  try {
    const { test_email } = req.body;
    
    if (!test_email) {
      return res.status(400).json({ error: 'Test email address is required' });
    }

    // Get email config
    const config = await db('email_configs').first();
    
    if (!config) {
      return res.status(400).json({ error: 'Email configuration not found. Please configure SMTP settings first.' });
    }

    // Validate SMTP configuration
    if (!config.smtp_host || !config.smtp_port) {
      return res.status(400).json({ 
        error: 'Incomplete email configuration',
        details: 'SMTP host and port are required'
      });
    }
    
    // Check if password might be masked (this shouldn't happen when fetching from DB)
    if (config.smtp_pass === '********') {
      return res.status(400).json({
        error: 'Invalid email configuration',
        details: 'SMTP password appears to be masked. Please reconfigure your email settings.'
      });
    }

    // Create transporter with detailed logging
    const transportConfig = {
      host: config.smtp_host,
      port: parseInt(config.smtp_port),
      secure: config.smtp_secure === true || config.smtp_secure === 1,
      auth: config.smtp_user && config.smtp_pass ? {
        user: config.smtp_user,
        pass: config.smtp_pass
      } : undefined,
      tls: {
        // Allow ignoring SSL certificate errors when tls_reject_unauthorized is false
        rejectUnauthorized: config.tls_reject_unauthorized !== false
      },
      logger: process.env.NODE_ENV === 'development',
      debug: process.env.NODE_ENV === 'development'
    };

    logger.info('Creating email transporter with config:', {
      host: transportConfig.host,
      port: transportConfig.port,
      secure: transportConfig.secure,
      auth: transportConfig.auth ? 'configured' : 'none'
    });

    const transporter = nodemailer.createTransport(transportConfig);

    // Send test email with the same wrapper used for all other emails
    const subject = 'Test Email - Photo Sharing Platform';
    const testHtmlBody = `
      <h2>Test Email Successful!</h2>
      <p>This is a test email from your Photo Sharing platform.</p>
      <p>If you're seeing this, your email configuration is working correctly.</p>
      <hr>
      <p style="color: #666; font-size: 12px;">
        Sent from: ${config.from_email}<br>
        SMTP Host: ${config.smtp_host}<br>
        Time: ${new Date().toISOString()}
      </p>
    `;
    const wrappedHtml = await wrapEmailHtml(testHtmlBody, subject);

    await transporter.sendMail({
      from: `${config.from_name} <${config.from_email}>`,
      to: test_email,
      subject,
      html: wrappedHtml,
      text: 'Test Email Successful! Your email configuration is working correctly.'
    });

    res.json({ message: 'Test email sent successfully' });
  } catch (error) {
    logger.error('Test email error:', error);
    logger.error('Error stack:', error.stack);

    // Provide more specific error messages with translation keys
    let errorMessage = 'Error sending email';
    let errorKey = 'email.errors.sendFailed';
    let details = error.message;
    let detailsKey = 'email.errors.unknownError';

    if (error.code === 'ECONNREFUSED') {
      errorMessage = 'Failed to connect to SMTP server';
      errorKey = 'email.errors.connectionRefused';
      details = 'Please check your SMTP host and port settings';
      detailsKey = 'email.errors.checkHostPort';
    } else if (error.code === 'EAUTH') {
      errorMessage = 'SMTP authentication failed';
      errorKey = 'email.errors.authFailed';
      details = 'Please check your SMTP username and password';
      detailsKey = 'email.errors.checkCredentials';
    } else if (error.code === 'ESOCKET') {
      errorMessage = 'Network error connecting to SMTP server';
      errorKey = 'email.errors.networkError';
      details = 'Could not establish connection to SMTP server';
      detailsKey = 'email.errors.connectionFailed';
    } else if (error.code === 'ETIMEDOUT') {
      errorMessage = 'Connection to SMTP server timed out';
      errorKey = 'email.errors.timeout';
      details = 'The server took too long to respond. Please check your network and SMTP settings.';
      detailsKey = 'email.errors.timeoutDetails';
    } else if (error.code === 'ENOTFOUND') {
      errorMessage = 'SMTP server not found';
      errorKey = 'email.errors.serverNotFound';
      details = 'The SMTP host could not be resolved. Please verify the hostname.';
      detailsKey = 'email.errors.checkHostname';
    } else if (error.responseCode >= 500) {
      errorMessage = 'SMTP server error';
      errorKey = 'email.errors.serverError';
      details = `Server returned error code ${error.responseCode}`;
      detailsKey = 'email.errors.serverErrorDetails';
    } else if (error.responseCode >= 400) {
      errorMessage = 'Email rejected by server';
      errorKey = 'email.errors.rejected';
      details = error.response || 'The email was rejected. Check recipient address and settings.';
      detailsKey = 'email.errors.rejectedDetails';
    }

    res.status(500).json({
      error: errorMessage,
      errorKey: errorKey,
      details: details,
      detailsKey: detailsKey,
      code: error.code,
      responseCode: error.responseCode
    });
  }
});

// Flush the email queue now. Sends every pending email immediately,
// bypassing the business-hours floor (`scheduled_at`) — the escape hatch
// for "drain the queue before I take the server down for an update".
router.post('/flush-queue', adminAuth, requirePermission('email.send'), async (req, res) => {
  try {
    const summary = await processEmailQueue({ ignoreSchedule: true, limit: 1000 });
    try {
      await logActivity('email_queue_flushed',
        { processed: summary.processed, sent: summary.sent, failed: summary.failed },
        null,
        { type: 'admin', id: req.admin.id, name: req.admin.username }
      );
    } catch (_) { /* activity logging is best-effort */ }
    res.json({ message: 'Email queue flushed', ...summary });
  } catch (error) {
    logger.error('Flush email queue error:', error);
    res.status(500).json({ error: 'Failed to flush email queue', details: error.message });
  }
});

// Read-only "Sent emails" feed — paginated view of email_queue with
// filters (status, type, recipient search, date range). email_data is
// deliberately NOT returned (it can carry attachment paths / PII); the
// list only needs the envelope + delivery state. event_id is joined to
// events so the UI can link back to the source gallery when present.
router.get('/queue', adminAuth, requirePermission('email.view'), [
  query('status').optional({ values: 'falsy' }).isIn(['pending', 'sent', 'failed']),
  query('emailType').optional({ values: 'falsy' }).isString().isLength({ max: 64 }),
  query('origin').optional({ values: 'falsy' }).isIn(['system', 'manual']),
  query('state').optional({ values: 'falsy' }).isIn(['active', 'archived', 'deleted']),
  query('q').optional({ values: 'falsy' }).isString().isLength({ max: 255 }),
  query('from').optional({ values: 'falsy' }).isISO8601(),
  query('to').optional({ values: 'falsy' }).isISO8601(),
  query('page').optional({ values: 'falsy' }).isInt({ min: 1 }),
  query('pageSize').optional({ values: 'falsy' }).isInt({ min: 1, max: 100 }),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const page = req.query.page ? parseInt(req.query.page, 10) : 1;
    const pageSize = req.query.pageSize ? parseInt(req.query.pageSize, 10) : 25;

    const applyFilters = (qb) => {
      if (req.query.status) qb.where('email_queue.status', req.query.status);
      if (req.query.emailType) qb.where('email_queue.email_type', req.query.emailType);
      // 'system' includes legacy rows (origin was NULL before migration 155).
      if (req.query.origin === 'manual') qb.where('email_queue.origin', 'manual');
      else if (req.query.origin === 'system') qb.where((b) => b.where('email_queue.origin', 'system').orWhereNull('email_queue.origin'));
      // mailbox_state: default active (+ legacy NULL); Archived/Deleted folders pass it explicitly.
      const st = ['archived', 'deleted'].includes(String(req.query.state)) ? String(req.query.state) : 'active';
      if (st === 'active') qb.where((b) => b.where('email_queue.mailbox_state', 'active').orWhereNull('email_queue.mailbox_state'));
      else qb.where('email_queue.mailbox_state', st);
      if (req.query.from) qb.where('email_queue.created_at', '>=', new Date(req.query.from));
      if (req.query.to) qb.where('email_queue.created_at', '<=', new Date(req.query.to));
      if (req.query.q) {
        const term = `%${String(req.query.q).trim()}%`;
        qb.where(function () {
          this.where('email_queue.recipient_email', 'like', term)
            .orWhere('email_queue.email_type', 'like', term);
        });
      }
      return qb;
    };

    const [{ count }] = await applyFilters(db('email_queue')).count({ count: '*' });
    const total = parseInt(count, 10) || 0;

    const rows = await applyFilters(
      db('email_queue')
        .leftJoin('events', 'events.id', 'email_queue.event_id')
        .select(
          'email_queue.id',
          'email_queue.recipient_email',
          'email_queue.email_type',
          'email_queue.status',
          'email_queue.created_at',
          'email_queue.scheduled_at',
          'email_queue.sent_at',
          'email_queue.error_message',
          'email_queue.retry_count',
          'email_queue.origin',
          'email_queue.event_id',
          'events.event_name as event_name',
          'events.slug as event_slug'
        )
    )
      .orderBy('email_queue.created_at', 'desc')
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    const items = rows.map((r) => ({
      id: r.id,
      recipientEmail: r.recipient_email,
      emailType: r.email_type,
      status: r.status,
      createdAt: r.created_at,
      scheduledAt: r.scheduled_at,
      sentAt: r.sent_at,
      errorMessage: r.error_message,
      retryCount: r.retry_count,
      origin: r.origin || 'system',
      eventId: r.event_id,
      eventName: r.event_name || null,
      eventSlug: r.event_slug || null,
    }));

    res.json({
      items,
      pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 },
    });
  } catch (error) {
    logger.error('List email queue error:', error);
    res.status(500).json({ error: 'Failed to load email queue', details: error.message });
  }
});

// Single queued/sent email WITH its rendered body — powers the Messages
// reading pane. `rendered_html` is the exact HTML that was sent (migration
// 119); rows sent before that migration have none. Attachment disk paths in
// `email_data` are never exposed — only the filenames, so the pane can list
// attachments without leaking storage paths (same PII posture as the list).
router.get('/queue/:id', adminAuth, messagingGate, requirePermission('email.view'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await db('email_queue')
      .leftJoin('events', 'events.id', 'email_queue.event_id')
      .select('email_queue.*', 'events.event_name as event_name', 'events.slug as event_slug')
      .where('email_queue.id', id)
      .first();
    if (!row) return res.status(404).json({ error: 'Email not found' });

    let cc = null;
    let attachments = [];
    try {
      const data = row.email_data ? JSON.parse(row.email_data) : {};
      if (data.cc) cc = Array.isArray(data.cc) ? data.cc.join(', ') : String(data.cc);
      if (Array.isArray(data.attachments)) {
        attachments = data.attachments
          .filter((a) => a && a.filename)
          .map((a) => ({ filename: a.filename, contentType: a.contentType || null }));
      }
    } catch (_) { /* malformed email_data → no cc/attachments, still return the body */ }

    res.json({
      id: row.id,
      recipientEmail: row.recipient_email,
      emailType: row.email_type,
      status: row.status,
      createdAt: row.created_at,
      scheduledAt: row.scheduled_at,
      sentAt: row.sent_at,
      errorMessage: row.error_message,
      retryCount: row.retry_count,
      eventId: row.event_id,
      eventName: row.event_name || null,
      eventSlug: row.event_slug || null,
      renderedHtml: row.rendered_html || null,
      cc,
      attachments,
    });
  } catch (error) {
    logger.error('Get email queue item error:', error);
    res.status(500).json({ error: 'Failed to load email', details: error.message });
  }
});

// Send a human-composed email from the Messages composer. The admin already
// edited the body (reply or document message), so it is sent as-is — no
// template render — after a sanitize pass. Recorded in email_queue as a
// 'manual' send so it surfaces under Customers > Sent.
router.post('/send', adminAuth, messagingGate, requirePermission('email.send'), async (req, res) => {
  try {
    const b = req.body || {};
    const to = String(b.to || '').trim();
    const subject = String(b.subject || '').trim();
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      return res.status(400).json({ error: 'A valid recipient email is required.' });
    }
    if (!subject) return res.status(400).json({ error: 'A subject is required.' });

    const sanitizeHtml = require('sanitize-html');
    // Match the stricter inbound sanitizeBody allowlist: no <style> tag, no
    // data: scheme — inline style/class attributes are enough for composed mail.
    const html = sanitizeHtml(String(b.html || ''), {
      allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img']),
      allowedAttributes: {
        ...sanitizeHtml.defaults.allowedAttributes,
        img: ['src', 'alt', 'width', 'height'],
        '*': ['style', 'class'],
      },
      allowedSchemes: ['http', 'https', 'mailto', 'cid'],
    });
    const cc = b.cc ? String(b.cc).trim() : null;
    const accountKey = b.accountKey ? String(b.accountKey) : undefined;

    const emailProcessor = require('../services/emailProcessor');
    const result = await emailProcessor.sendRawEmail({ to, cc, subject, html, accountKey });

    await db('email_queue').insert({
      recipient_email: to,
      email_type: 'manual_message',
      email_data: JSON.stringify({
        subject,
        cc: cc || undefined,
        replyToReceivedId: b.replyToReceivedId || undefined,
        messageId: result.messageId,
      }),
      status: 'sent',
      origin: 'manual',
      rendered_html: html,
      created_at: new Date(),
      sent_at: new Date(),
    });
    res.json({ ok: true });
  } catch (error) {
    logger.error('Manual send error:', error);
    res.status(500).json({ error: 'Failed to send message', details: error.message });
  }
});

// Helper: parse variables JSON safely
function parseVariables(template) {
  try {
    if (!template.variables) return [];
    if (typeof template.variables === 'object') return template.variables;
    return JSON.parse(template.variables);
  } catch (e) {
    logger.warn('Failed to parse variables for template:', template.template_key, e.message);
    return [];
  }
}

// Helper: get translations for a template, with legacy column fallback
async function getTemplateTranslations(templateId, template) {
  const translations = {};
  try {
    const rows = await db('email_template_translations')
      .where('template_id', templateId)
      .select('language', 'subject', 'body_html', 'body_text');

    rows.forEach(row => {
      translations[row.language] = {
        subject: row.subject || '',
        body_html: row.body_html || '',
        body_text: row.body_text || '',
      };
    });
  } catch (error) {
    // Translations table might not exist yet (pre-migration)
    // Fall back to legacy columns
    if (template.subject_en !== undefined) {
      translations.en = {
        subject: template.subject_en || '',
        body_html: template.body_html_en || '',
        body_text: template.body_text_en || '',
      };
      translations.de = {
        subject: template.subject_de || '',
        body_html: template.body_html_de || '',
        body_text: template.body_text_de || '',
      };
    } else {
      translations.en = {
        subject: template.subject || '',
        body_html: template.body_html || '',
        body_text: template.body_text || '',
      };
    }
  }
  return translations;
}

// Get email templates
router.get('/templates', adminAuth, requirePermission('email.view'), async (req, res) => {
  try {
    // Self-heal: ensure the seeded event-reminder templates exist + are
    // backfilled with example content on already-migrated installs. The
    // function is idempotent and short-circuits via a module-level cache
    // after one successful pass, so this is free on subsequent calls.
    try {
      const { ensureEventReminderTemplatesSeeded } = require('../services/eventReminderTemplates');
      const log = require('../utils/logger');
      await ensureEventReminderTemplatesSeeded(db, log);
    } catch (_e) { /* non-fatal */ }

    const templates = await db('email_templates')
      .select('*')
      .orderBy('template_key');

    const formattedTemplates = [];
    for (const template of templates) {
      const translations = await getTemplateTranslations(template.id, template);
      formattedTemplates.push({
        id: template.id,
        template_key: template.template_key,
        variables: parseVariables(template),
        translations,
        // Categorisation + feature-flag link added by migration 098.
        // Older installs that haven't run the migration yet return
        // 'core' / null fall-backs so the frontend keeps working
        // without a hard dependency on the new columns.
        category: template.category || 'core',
        subcategory: template.subcategory || null,
        feature_flag: template.feature_flag || null,
        updated_at: template.updated_at,
      });
    }

    res.json(formattedTemplates);
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to fetch email templates');
  }
});

// Get single template
router.get('/templates/:key', adminAuth, requirePermission('email.view'), async (req, res) => {
  try {
    const template = await db('email_templates')
      .where('template_key', req.params.key)
      .first();

    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    const translations = await getTemplateTranslations(template.id, template);

    res.json({
      id: template.id,
      template_key: template.template_key,
      variables: parseVariables(template),
      translations,
      // See list endpoint for the rationale on the || fallbacks.
      category: template.category || 'core',
      subcategory: template.subcategory || null,
      feature_flag: template.feature_flag || null,
      updated_at: template.updated_at,
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to fetch email template');
  }
});

// Update email template translations
router.put('/templates/:key', [
  adminAuth,
  requirePermission('email.edit'),
], async (req, res) => {
  try {
    const template = await db('email_templates')
      .where('template_key', req.params.key)
      .first();

    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    const { translations } = req.body;

    if (!translations || typeof translations !== 'object') {
      return res.status(400).json({ error: 'translations object is required' });
    }

    // Upsert each language translation
    for (const [language, data] of Object.entries(translations)) {
      if (!data || typeof data !== 'object') continue;

      const existing = await db('email_template_translations')
        .where({ template_id: template.id, language })
        .first();

      const row = {
        subject: data.subject || '',
        body_html: data.body_html || '',
        body_text: data.body_text || '',
        updated_at: new Date(),
      };

      if (existing) {
        await db('email_template_translations')
          .where({ template_id: template.id, language })
          .update(row);
      } else {
        await db('email_template_translations').insert({
          template_id: template.id,
          language,
          ...row,
          created_at: new Date(),
        });
      }
    }

    // Update timestamp on parent template
    await db('email_templates')
      .where('id', template.id)
      .update({ updated_at: new Date() });

    // Also sync legacy columns for backward compatibility
    const enData = translations.en;
    const deData = translations.de;
    const legacyUpdate = { updated_at: new Date() };
    const columnInfo = await db('email_templates').columnInfo();

    if (enData && columnInfo.subject_en) {
      legacyUpdate.subject_en = enData.subject || '';
      legacyUpdate.body_html_en = enData.body_html || '';
      legacyUpdate.body_text_en = enData.body_text || '';
    }
    if (deData && columnInfo.subject_de) {
      legacyUpdate.subject_de = deData.subject || '';
      legacyUpdate.body_html_de = deData.body_html || '';
      legacyUpdate.body_text_de = deData.body_text || '';
    }

    await db('email_templates')
      .where('id', template.id)
      .update(legacyUpdate);

    // Log activity
    await logActivity('email_template_updated',
      { template_key: req.params.key, languages: Object.keys(translations) },
      null,
      { type: 'admin', id: req.admin.id, name: req.admin.username }
    );

    res.json({ message: 'Email template updated successfully' });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to update email template');
  }
});

// Create a new email template. Used by the ReminderTemplatesPage to
// mint a per-event-type reminder (template_key like
// `event_reminder_<slug_prefix>`). Idempotent at the API level — if
// the key already exists we return 409 so the caller knows to PUT
// instead.
router.post('/templates', [
  adminAuth,
  requirePermission('email.edit'),
], async (req, res) => {
  try {
    const {
      template_key: templateKey,
      translations,
      category,
      subcategory,
      feature_flag: featureFlag,
      variables,
    } = req.body;
    if (!templateKey || typeof templateKey !== 'string' || !/^[a-z0-9_]+$/.test(templateKey)) {
      return res.status(400).json({ error: 'template_key must be a snake_case identifier' });
    }
    if (!translations || typeof translations !== 'object') {
      return res.status(400).json({ error: 'translations object is required' });
    }

    const existing = await db('email_templates').where({ template_key: templateKey }).first();
    if (existing) {
      return res.status(409).json({
        error: 'Template already exists. Use PUT /templates/:key to update.',
        code: 'TEMPLATE_EXISTS',
      });
    }

    const cols = await db('email_templates').columnInfo();
    const enContent = translations.en || {};

    // Build the master row. The legacy single-row columns are populated
    // from EN so older readers that don't consult the translations
    // table still see something sensible.
    const masterRow = { template_key: templateKey };
    if (variables && 'variables' in cols) masterRow.variables = JSON.stringify(variables);
    if (category && 'category' in cols) masterRow.category = category;
    if (subcategory && 'subcategory' in cols) masterRow.subcategory = subcategory;
    if (featureFlag && 'feature_flag' in cols) masterRow.feature_flag = featureFlag;
    if ('created_at' in cols) masterRow.created_at = new Date();
    if ('updated_at' in cols) masterRow.updated_at = new Date();
    for (const colName of Object.keys(cols)) {
      if (colName === 'subject' || /^subject_[a-z]{2,3}$/i.test(colName)) {
        masterRow[colName] = enContent.subject || '';
      } else if (colName === 'body_html' || /^body_html_[a-z]{2,3}$/i.test(colName)) {
        masterRow[colName] = enContent.body_html || '';
      } else if (colName === 'body_text' || /^body_text_[a-z]{2,3}$/i.test(colName)) {
        masterRow[colName] = enContent.body_text || '';
      }
    }

    const inserted = await db('email_templates').insert(masterRow).returning('id');
    const templateId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];

    // Per-language rows in email_template_translations.
    const hasTranslations = await db.schema.hasTable('email_template_translations');
    if (hasTranslations && templateId) {
      for (const [language, content] of Object.entries(translations)) {
        if (!content || typeof content !== 'object') continue;
        await db('email_template_translations').insert({
          template_id: templateId,
          language,
          subject: content.subject || '',
          body_html: content.body_html || '',
          body_text: content.body_text || '',
          created_at: new Date(),
          updated_at: new Date(),
        });
      }
    }

    await logActivity('email_template_created',
      { template_key: templateKey, languages: Object.keys(translations) },
      null,
      { type: 'admin', id: req.admin.id, name: req.admin.username });

    return res.status(201).json({ template_key: templateKey, id: templateId });
  } catch (error) {
    return errorResponse(res, error, 500, 'Failed to create email template');
  }
});

// Preview email template
router.post('/templates/:key/preview', adminAuth, requirePermission('email.view'), async (req, res) => {
  try {
    const template = await db('email_templates')
      .where('template_key', req.params.key)
      .first();

    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    const { preview_data, language = 'en' } = req.body;

    // Get translation from translations table with fallback
    let translation = null;
    try {
      translation = await db('email_template_translations')
        .where({ template_id: template.id, language })
        .first();

      if (!translation && language !== 'en') {
        translation = await db('email_template_translations')
          .where({ template_id: template.id, language: 'en' })
          .first();
      }
    } catch (e) {
      // Fallback to legacy columns
    }

    let subject = '';
    let htmlContent = '';
    let textContent = '';

    if (translation) {
      subject = translation.subject || '';
      htmlContent = translation.body_html || '';
      textContent = translation.body_text || '';
    } else {
      // Legacy column fallback
      const subjectField = language === 'de' && template.subject_de ? 'subject_de' : 'subject_en';
      const htmlField = language === 'de' && template.body_html_de ? 'body_html_de' : 'body_html_en';
      const textField = language === 'de' && template.body_text_de ? 'body_text_de' : 'body_text_en';
      subject = template[subjectField] || template.subject || '';
      htmlContent = template[htmlField] || template.body_html || '';
      textContent = template[textField] || template.body_text || '';
    }

    if (preview_data) {
      const escapeHtml = (str) => String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');

      Object.keys(preview_data).forEach(key => {
        const regex = new RegExp(`{{${key}}}`, 'g');
        const escapedValue = escapeHtml(preview_data[key]);
        htmlContent = htmlContent.replace(regex, escapedValue);
        textContent = textContent.replace(regex, preview_data[key]);
        subject = subject.replace(regex, escapeHtml(preview_data[key]));
      });
    }

    // Wrap in the full styled email template with header/footer/logo
    const wrappedHtml = await wrapEmailHtml(htmlContent, subject, language);

    res.json({
      subject,
      body_html: wrappedHtml,
      body_text: textContent,
      language
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to preview email template');
  }
});

module.exports = router;