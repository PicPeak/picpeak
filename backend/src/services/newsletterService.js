/**
 * newsletterService — CRM newsletter campaigns (issue #1264, Part B).
 *
 * Design in one line: **a campaign is a body plus a recipient rule; queueing
 * one writes ordinary `email_queue` rows.** Retry, `rendered_html`, `sent_at`
 * and `error_message` therefore come from the existing queue processor rather
 * than a parallel sender, and throttling is done by staggering `scheduled_at`
 * — the processor loop is untouched.
 *
 * Two rules the rest of the file exists to enforce:
 *
 *  1. **No raw HTML is ever stored.** Bodies are sanitized on write and again
 *     on render. The second pass is cheap and idempotent, and it means a row
 *     written by an older/buggier version of the sanitizer can't reach a
 *     recipient unsanitized.
 *
 *  2. **Opt-out is checked twice** — at queue time and again at send time.
 *     A customer who unsubscribes in the hour between the two is skipped and
 *     recorded as `skipped_opt_out`, not mailed.
 */

const crypto = require('crypto');
const sanitizeHtml = require('sanitize-html');

const { db, logActivity } = require('../database/db');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');
const { formatBoolean } = require('../utils/dbCompat');
const { sanitizeCSS } = require('../utils/cssSanitizer');
const { timingSafeEqualStr } = require('../utils/timingSafe');
const { getFrontendBaseUrl } = require('../utils/frontendUrl');

// A 200 KB body is already an absurd newsletter; the cap exists so a paste
// from a WYSIWYG suite full of base64 images can't put a multi-megabyte row
// in front of the sanitizer (and then in every queue row it renders into).
const MAX_BODY_BYTES = 200 * 1024;
const MAX_SUBJECT_LENGTH = 255;

const VALID_STATUSES = ['draft', 'queued', 'sending', 'sent', 'cancelled', 'failed'];
const VALID_RECIPIENT_MODES = ['all_active', 'manual'];

// Rate bounds. 20/min is deliberately conservative — SES allows 14/s but many
// shared hosts cap at 100/hour, and the cost of being slow is a campaign that
// takes an extra hour, while the cost of being fast is a blocked SMTP account.
const MIN_RATE_PER_MINUTE = 1;
const MAX_RATE_PER_MINUTE = 120;
const DEFAULT_RATE_PER_MINUTE = 20;

// ---------------------------------------------------------------------------
// Sanitizers
// ---------------------------------------------------------------------------

/**
 * The email-safe tag/attribute allowlist.
 *
 * Starts from the allowlist the manual composer already uses
 * (`adminEmail.js` POST /send) and adds what a newsletter layout actually
 * needs: table tags, `<center>`/`<font>`, and the presentational attributes
 * email clients still require because they don't do flexbox.
 *
 * Not present, on purpose: `script`, `iframe`, `object`, `embed`, `form`,
 * `input`, `style` (the tag — a campaign's CSS goes through `body_css`), and
 * every `on*` handler. sanitize-html drops unknown attributes, so event
 * handlers never need an explicit deny.
 */
const CAMPAIGN_ALLOWED_TAGS = sanitizeHtml.defaults.allowedTags.concat([
  'img', 'center', 'font',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'colgroup', 'col',
]);

const PRESENTATIONAL_ATTRS = [
  'align', 'valign', 'width', 'height', 'bgcolor', 'border',
  'cellpadding', 'cellspacing', 'colspan', 'rowspan',
];

const CAMPAIGN_ALLOWED_ATTRIBUTES = {
  ...sanitizeHtml.defaults.allowedAttributes,
  a: ['href', 'name', 'target', 'rel', 'style', 'class'],
  // No `srcset`: it takes a comma-separated URL list that the scheme filter
  // below does not police, which would be a way back to an http: or data:
  // source after `src` had been cleaned.
  img: ['src', 'alt', 'width', 'height', 'style', 'class', 'align', 'border'],
  table: [...PRESENTATIONAL_ATTRS, 'style', 'class', 'role'],
  td: [...PRESENTATIONAL_ATTRS, 'style', 'class'],
  th: [...PRESENTATIONAL_ATTRS, 'style', 'class'],
  tr: [...PRESENTATIONAL_ATTRS, 'style', 'class'],
  font: ['color', 'face', 'size'],
  '*': ['style', 'class'],
};

/**
 * Sanitize a campaign body. Idempotent — safe to run on already-clean HTML,
 * which is what lets the render path re-run it as a second line of defence.
 *
 * @param {string} html raw admin input
 * @returns {string} storable HTML
 */
function sanitizeCampaignBody(html) {
  if (html === null || html === undefined) return '';
  const input = String(html);
  if (Buffer.byteLength(input, 'utf8') > MAX_BODY_BYTES) {
    throw new AppError(
      `Newsletter body exceeds the ${Math.round(MAX_BODY_BYTES / 1024)} KB limit`,
      400
    );
  }

  return sanitizeHtml(input, {
    allowedTags: CAMPAIGN_ALLOWED_TAGS,
    allowedAttributes: CAMPAIGN_ALLOWED_ATTRIBUTES,
    // `cid:` is kept for parity with the manual composer (inline attachments).
    // `data:` is NOT allowed — a data: image is how an HTML-ish payload gets
    // smuggled past a tag allowlist in the clients that render it.
    allowedSchemes: ['http', 'https', 'mailto', 'cid'],
    allowedSchemesAppliedToAttributes: ['href', 'src'],
    // A relative URL in an email is broken anyway (there is no base), and
    // allowing it would let `//evil.example` through as protocol-relative.
    allowProtocolRelative: false,
    // Style attributes survive the tag pass; run their declarations through
    // the same CSS sanitizer the <style> block uses so `expression(`,
    // `behavior:` and external `url()` are stripped there too.
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: {
          ...attribs,
          // Mail clients open links in a browser; noopener/noreferrer costs
          // nothing and closes window.opener on the ones that use a tab.
          ...(attribs.href ? { rel: 'noopener noreferrer' } : {}),
        },
      }),
    },
  })
    // sanitize-html keeps the style ATTRIBUTE contents verbatim. Clean each.
    .replace(/style="([^"]*)"/gi, (match, css) => {
      const { sanitized } = sanitizeCSS(css);
      const cleaned = stripRemoteCssUrls(sanitized);
      return cleaned ? `style="${cleaned.replace(/"/g, '')}"` : '';
    });
}

/**
 * Remove every `url(...)` that is not an inline data: image.
 *
 * The shared `sanitizeCSS` *detects* a remote url() and prefixes it with a
 * `/* BLOCKED URL *\/` comment — but a CSS comment is stripped during
 * tokenization, so the declaration a mail client actually parses still
 * carries the live URL. Verified:
 *
 *   sanitizeCSS('.a{background:url(https://x/p.gif)}').sanitized
 *     → '.a{background:/* BLOCKED URL *\/ url(https://x/p.gif)}'
 *
 * In a newsletter that is a tracking pixel delivered to every recipient, so
 * this pass actually removes the token. Scoped to the newsletter path on
 * purpose: the same weakness affects gallery custom CSS, but changing shared
 * sanitizer behaviour is a separate change with its own blast radius.
 */
function stripRemoteCssUrls(css) {
  if (!css) return '';
  return String(css)
    .replace(/\/\*\s*BLOCKED URL\s*\*\//gi, '')
    .replace(/url\s*\(\s*(['"]?)([^)'"]*)\1\s*\)/gi, (match, _quote, target) =>
      (/^data:image\/(?:jpeg|jpg|png|gif|webp)/i.test(target.trim()) ? match : 'none'));
}

/**
 * Sanitize a campaign's optional `<style>` block. Delegates to the shared
 * cssSanitizer, which already blocks `@import`, `expression(`, `behavior:`,
 * `javascript:` and every `url()` that is not a `data:` image.
 *
 * That is STRICTER than the issue's "https: images only" note — the shared
 * sanitizer allows no remote `url()` at all. Kept as-is rather than loosened:
 * a remote CSS url() in mail is a tracking pixel by another name, and a
 * campaign's images belong in `<img>` tags where the scheme filter sees them.
 *
 * @returns {{ css: string, warnings: string[] }}
 */
function sanitizeCampaignCss(css) {
  if (!css) return { css: '', warnings: [] };
  const { sanitized, warnings } = sanitizeCSS(String(css));
  return { css: stripRemoteCssUrls(sanitized), warnings };
}

// ---------------------------------------------------------------------------
// Unsubscribe tokens
// ---------------------------------------------------------------------------

const UNSUB_PREFIX = 'newsletter-unsub:';

function unsubSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new AppError('JWT_SECRET is not configured', 500);
  return secret;
}

function unsubSignature(customerId) {
  return crypto
    .createHmac('sha256', unsubSecret())
    .update(`${UNSUB_PREFIX}${customerId}`)
    .digest('hex');
}

/**
 * A signed, non-expiring handle on one customer id.
 *
 * No table and no lookup by email, so the link carries no enumeration
 * surface: an attacker who changes the id gets a signature mismatch, and the
 * route answers identically either way.
 */
function unsubscribeToken(customerId) {
  const id = Number(customerId);
  if (!Number.isInteger(id) || id <= 0) throw new AppError('Invalid customer id', 400);
  return Buffer.from(`${id}.${unsubSignature(id)}`, 'utf8').toString('base64url');
}

/** @returns {number|null} the customer id, or null for anything tampered. */
function verifyUnsubscribeToken(token) {
  if (typeof token !== 'string' || !token) return null;
  let decoded;
  try {
    decoded = Buffer.from(token, 'base64url').toString('utf8');
  } catch (_) {
    return null;
  }
  const dot = decoded.indexOf('.');
  if (dot <= 0) return null;
  const idPart = decoded.slice(0, dot);
  const sigPart = decoded.slice(dot + 1);
  if (!/^\d+$/.test(idPart)) return null;
  const id = Number(idPart);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return timingSafeEqualStr(sigPart, unsubSignature(id)) ? id : null;
}

async function unsubscribeUrl(customerId) {
  const base = (await getFrontendBaseUrl()) || '';
  return `${base}/api/public/newsletter/unsubscribe/${unsubscribeToken(customerId)}`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Everything a campaign body may interpolate. Absent keys stay literal. */
function recipientVariables(customer, unsubUrl, supportEmail) {
  const first = customer.first_name || '';
  const last = customer.last_name || '';
  const display = customer.display_name || [first, last].filter(Boolean).join(' ').trim();
  return {
    customer_name: display || customer.company_name || customer.email || '',
    first_name: first,
    last_name: last,
    salutation: customer.salutation || '',
    company_name: customer.company_name || '',
    support_email: supportEmail || '',
    unsubscribe_url: unsubUrl,
  };
}

/**
 * Render one campaign for one recipient.
 *
 * Language order is customer → campaign → 'en': `preferred_language` is the
 * customer's own setting and beats the campaign default, matching how
 * getRecipientLanguage resolves transactional mail.
 *
 * @returns {{ subject: string, html: string, language: string }}
 */
async function renderForRecipient(campaign, customer, options = {}) {
  // Required lazily: emailProcessor requires businessProfileService, and
  // pulling it at module scope from here would make the require graph depend
  // on load order for no benefit.
  const { safeTemplateReplace, wrapEmailHtml, getSupportEmail } = require('./emailProcessor');

  const language = customer.preferred_language || campaign.language || 'en';
  const unsubUrl = options.unsubscribeUrl
    ?? (customer.id ? await unsubscribeUrl(customer.id) : '');
  const supportEmail = options.supportEmail ?? await getSupportEmail();
  const variables = recipientVariables(customer, unsubUrl, supportEmail);

  // Second sanitize pass — see the file header. Idempotent, so a body stored
  // by an older sanitizer is cleaned again on the way out.
  const safeBody = sanitizeCampaignBody(campaign.body_html || '');

  // Substitution happens AFTER sanitizing, with escaping on: a customer's own
  // company name is untrusted text and must not be able to inject markup by
  // riding in through a variable the sanitizer never saw.
  const body = safeTemplateReplace(safeBody, variables, { escapeHtml: true });
  const subject = safeTemplateReplace(campaign.subject || '', variables);

  const { css } = sanitizeCampaignCss(campaign.body_css);
  // Inline <style> ahead of the body. wrapEmailHtml emits its own <style> in
  // <head>; this one sits in the content cell, which is where the clients
  // that keep <style> at all will honour it. Clients that strip it fall back
  // to the inline style attributes the sanitizer preserved.
  const styled = css ? `<style type="text/css">${css}</style>\n${body}` : body;

  const html = await wrapEmailHtml(styled, subject, language);
  return { subject, html, language };
}

// ---------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------

const RECIPIENT_COLUMNS = [
  'id', 'email', 'salutation', 'first_name', 'last_name',
  'display_name', 'company_name', 'preferred_language',
];

/**
 * Who this campaign would actually reach.
 *
 * `skippedOptOut` is reported rather than silently dropped — an operator
 * about to mail 2 000 people should see that 43 of them said no.
 *
 * @returns {{ recipients: object[], skippedOptOut: number, skippedNoEmail: number }}
 */
async function resolveRecipients(campaign, conn = db) {
  const ids = parseRecipientIds(campaign);
  if (campaign.recipient_mode === 'manual' && ids.length === 0) {
    return { recipients: [], skippedOptOut: 0, skippedNoEmail: 0 };
  }

  const base = () => {
    const q = conn('customer_accounts').where('is_active', formatBoolean(true));
    if (campaign.recipient_mode === 'manual') q.whereIn('id', ids);
    return q;
  };

  const all = await base().select(RECIPIENT_COLUMNS.concat(['marketing_opt_out']));

  const recipients = [];
  const seen = new Set();
  let skippedOptOut = 0;
  let skippedNoEmail = 0;

  for (const row of all) {
    if (isOptedOut(row)) { skippedOptOut += 1; continue; }
    const email = (row.email || '').trim().toLowerCase();
    if (!email) { skippedNoEmail += 1; continue; }
    // Two customer rows can legitimately share a billing address; the same
    // person must still receive the newsletter once.
    if (seen.has(email)) continue;
    seen.add(email);
    recipients.push({ ...row, email });
  }

  return { recipients, skippedOptOut, skippedNoEmail };
}

function isOptedOut(row) {
  const v = row.marketing_opt_out;
  return v === true || v === 1 || v === '1' || v === 't';
}

function parseRecipientIds(campaign) {
  if (campaign.recipient_mode !== 'manual') return [];
  const raw = campaign.recipient_filter;
  if (!raw) return [];
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (_) {
    return [];
  }
  const ids = Array.isArray(parsed) ? parsed : parsed?.customerIds;
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}

// ---------------------------------------------------------------------------
// Queueing
// ---------------------------------------------------------------------------

function clampRate(rate) {
  const n = parseInt(rate, 10);
  if (!Number.isFinite(n)) return DEFAULT_RATE_PER_MINUTE;
  return Math.max(MIN_RATE_PER_MINUTE, Math.min(MAX_RATE_PER_MINUTE, n));
}

/**
 * Queue a draft campaign: one `email_queue` row per recipient, with
 * `scheduled_at` staggered so the send never bursts a provider.
 *
 * The whole thing is one transaction. A partial queue is the worst possible
 * outcome — half a customer list mailed, a campaign stuck in `queued`, and no
 * safe way to retry — so either every row lands or none does.
 */
async function queueCampaign(campaignId, adminId) {
  const campaign = await getCampaign(campaignId);
  if (campaign.status !== 'draft') {
    throw new AppError(`Campaign is ${campaign.status}, only a draft can be queued`, 409);
  }
  if (!campaign.subject || !String(campaign.body_html || '').trim()) {
    throw new AppError('Campaign needs a subject and a body before it can be queued', 400);
  }

  const { recipients, skippedOptOut } = await resolveRecipients(campaign);
  if (recipients.length === 0) {
    throw new AppError('Campaign has no recipients', 400);
  }

  const rate = clampRate(campaign.send_rate_per_minute);
  const now = Date.now();
  const queuedAt = new Date(now).toISOString();

  await db.transaction(async (trx) => {
    for (let i = 0; i < recipients.length; i += 1) {
      const customer = recipients[i];
      // Stagger: recipient N goes out in minute floor(N / rate). Everything
      // in the first minute is due immediately, so a small campaign behaves
      // exactly like any other queued mail.
      const scheduledAt = new Date(now + Math.floor(i / rate) * 60 * 1000).toISOString();

      const inserted = await trx('email_queue').insert({
        recipient_email: customer.email,
        email_type: 'newsletter',
        email_data: JSON.stringify({ campaignId: campaign.id, customerId: customer.id }),
        status: 'pending',
        origin: 'campaign',
        campaign_id: campaign.id,
        created_at: queuedAt,
        scheduled_at: scheduledAt,
      }).returning('id');
      const queueId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];

      await trx('email_campaign_recipients').insert({
        campaign_id: campaign.id,
        customer_account_id: customer.id,
        email: customer.email,
        email_queue_id: queueId,
        status: 'queued',
        created_at: queuedAt,
      });
    }

    await trx('email_campaigns').where({ id: campaign.id }).update({
      status: 'queued',
      recipient_count: recipients.length,
      sent_count: 0,
      failed_count: 0,
      send_rate_per_minute: rate,
      queued_at: queuedAt,
      updated_at: queuedAt,
    });
  });

  await logActivity('newsletter_queued', {
    campaignId: campaign.id,
    name: campaign.name,
    recipients: recipients.length,
    skippedOptOut,
    sendRatePerMinute: rate,
  }, null, { type: 'admin', id: adminId });

  logger.info('Newsletter campaign queued', {
    campaignId: campaign.id, recipients: recipients.length, rate, adminId,
  });

  return { queued: recipients.length, skippedOptOut, sendRatePerMinute: rate };
}

/**
 * Cancel a campaign: drop the queue rows that have not gone out yet.
 *
 * Already-sent rows stay exactly as they are — cancelling a campaign cannot
 * un-send mail, and pretending otherwise in the counts would be a lie the
 * operator might act on.
 */
async function cancel(campaignId, adminId) {
  const campaign = await getCampaign(campaignId);
  if (!['queued', 'sending'].includes(campaign.status)) {
    throw new AppError(`Campaign is ${campaign.status} and cannot be cancelled`, 409);
  }

  const result = await db.transaction(async (trx) => {
    const pending = await trx('email_queue')
      .where({ campaign_id: campaign.id, status: 'pending' })
      .select('id');
    const pendingIds = pending.map((r) => r.id);

    if (pendingIds.length > 0) {
      await trx('email_queue').whereIn('id', pendingIds).del();
      await trx('email_campaign_recipients')
        .where({ campaign_id: campaign.id })
        .whereIn('email_queue_id', pendingIds)
        .update({ status: 'cancelled' });
    }

    await trx('email_campaigns').where({ id: campaign.id }).update({
      status: 'cancelled',
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    return { cancelled: pendingIds.length };
  });

  await logActivity('newsletter_cancelled', {
    campaignId: campaign.id, name: campaign.name, cancelledRows: result.cancelled,
  }, null, { type: 'admin', id: adminId });

  return result;
}

// ---------------------------------------------------------------------------
// Queue-processor hook
// ---------------------------------------------------------------------------

/**
 * Called by `processEmailQueue` for a row carrying `campaign_id`, after the
 * send succeeded or failed. Updates the recipient row and rolls the campaign
 * counters.
 *
 * Best-effort by contract: a failure here must never turn a delivered email
 * into a failed queue row, so the caller swallows what this throws.
 */
async function recordRecipientResult(queueRow, { status, errorMessage = null } = {}) {
  const update = { status };
  if (status === 'sent') update.sent_at = new Date().toISOString();
  if (errorMessage) update.error_message = String(errorMessage).slice(0, 1000);

  await db('email_campaign_recipients')
    .where({ campaign_id: queueRow.campaign_id, email_queue_id: queueRow.id })
    .update(update);

  await recomputeCounts(queueRow.campaign_id);
}

/**
 * Roll `sent_count` / `failed_count` from the recipient rows and move the
 * campaign to a terminal status once nothing is pending.
 *
 * Counts are recomputed from the rows rather than incremented, so a retried
 * row or a concurrent processor pass can't double-count.
 */
async function recomputeCounts(campaignId) {
  const rows = await db('email_campaign_recipients')
    .where({ campaign_id: campaignId })
    .select('status');
  if (rows.length === 0) return null;

  const sent = rows.filter((r) => r.status === 'sent').length;
  const failed = rows.filter((r) => r.status === 'failed').length;
  const stillQueued = rows.filter((r) => r.status === 'queued').length;

  const update = {
    sent_count: sent,
    failed_count: failed,
    updated_at: new Date().toISOString(),
  };

  const campaign = await db('email_campaigns').where({ id: campaignId }).first();
  if (!campaign) return null;

  if (stillQueued > 0) {
    // First result in: the campaign is visibly working.
    if (campaign.status === 'queued') update.status = 'sending';
  } else if (['queued', 'sending'].includes(campaign.status)) {
    // Everything resolved. `failed` only when NOTHING got through — a
    // campaign that reached 1 990 of 2 000 people is a sent campaign with
    // ten failures, and calling it "failed" would misdirect the operator.
    update.status = sent > 0 ? 'sent' : 'failed';
    update.completed_at = new Date().toISOString();
  }

  await db('email_campaigns').where({ id: campaignId }).update(update);

  if (update.status === 'sent' || update.status === 'failed') {
    await logActivity('newsletter_completed', {
      campaignId, name: campaign.name, sent, failed,
    });
  }

  return { sent, failed, stillQueued, status: update.status || campaign.status };
}

/**
 * The send-time opt-out re-check (design rule 2).
 *
 * @returns {boolean} true when this row must NOT be sent.
 */
async function shouldSkipForOptOut(customerId) {
  if (!customerId) return false;
  const row = await db('customer_accounts')
    .where({ id: customerId })
    .select('marketing_opt_out', 'is_active')
    .first();
  if (!row) return false;
  if (isOptedOut(row)) return true;
  const active = row.is_active;
  return !(active === true || active === 1 || active === '1' || active === 't');
}

/** Mark a row the processor refused to send because consent was withdrawn. */
async function markSkippedOptOut(queueRow) {
  await db('email_campaign_recipients')
    .where({ campaign_id: queueRow.campaign_id, email_queue_id: queueRow.id })
    .update({ status: 'skipped_opt_out' });
  await db('email_queue').where({ id: queueRow.id }).update({
    status: 'cancelled',
    error_message: 'Recipient opted out of marketing email after the campaign was queued',
  });
  await recomputeCounts(queueRow.campaign_id);
}

// ---------------------------------------------------------------------------
// Opt-out
// ---------------------------------------------------------------------------

/**
 * Flip a customer's marketing consent.
 *
 * @param {'link'|'portal'|'admin'} source where the change came from
 * @returns {boolean} whether a row was actually updated
 */
async function setMarketingOptOut(customerId, optOut, source, actor = null) {
  const updated = await db('customer_accounts').where({ id: customerId }).update({
    marketing_opt_out: formatBoolean(Boolean(optOut)),
    marketing_opt_out_at: optOut ? new Date().toISOString() : null,
  });
  if (!updated) return false;

  await logActivity('customer_marketing_opt_out', {
    customerId, optOut: Boolean(optOut), source,
  }, null, actor);
  return true;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

async function getCampaign(id, conn = db) {
  const campaign = await conn('email_campaigns').where({ id }).first();
  if (!campaign) throw new AppError('Campaign not found', 404);
  return campaign;
}

/** Shape an admin-supplied payload into storable columns. */
function sanitiseCampaignPayload(payload = {}) {
  const out = {};

  if (payload.name !== undefined) {
    const name = String(payload.name || '').trim();
    if (!name) throw new AppError('Campaign name is required', 400);
    out.name = name.slice(0, 120);
  }
  if (payload.subject !== undefined) {
    const subject = String(payload.subject || '').trim();
    if (!subject) throw new AppError('Subject is required', 400);
    // CR/LF in a subject is header injection. nodemailer encodes it, but a
    // subject with a newline in it is malformed regardless — reject rather
    // than silently strip, so the admin sees what happened.
    if (/[\r\n]/.test(subject)) throw new AppError('Subject cannot contain line breaks', 400);
    if (subject.length > MAX_SUBJECT_LENGTH) {
      throw new AppError(`Subject cannot exceed ${MAX_SUBJECT_LENGTH} characters`, 400);
    }
    out.subject = subject;
  }
  if (payload.bodyHtml !== undefined) {
    out.body_html = sanitizeCampaignBody(payload.bodyHtml);
  }
  if (payload.bodyCss !== undefined) {
    out.body_css = sanitizeCampaignCss(payload.bodyCss).css;
  }
  if (payload.language !== undefined) {
    out.language = String(payload.language || 'en').trim().slice(0, 8) || 'en';
  }
  if (payload.recipientMode !== undefined) {
    const mode = String(payload.recipientMode || '');
    if (!VALID_RECIPIENT_MODES.includes(mode)) {
      throw new AppError('recipientMode must be all_active or manual', 400);
    }
    out.recipient_mode = mode;
  }
  if (payload.customerIds !== undefined) {
    const ids = Array.isArray(payload.customerIds)
      ? [...new Set(payload.customerIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
      : [];
    out.recipient_filter = ids.length ? JSON.stringify({ customerIds: ids }) : null;
  }
  if (payload.sendRatePerMinute !== undefined) {
    out.send_rate_per_minute = clampRate(payload.sendRatePerMinute);
  }

  return out;
}

async function createCampaign(payload, adminId) {
  const data = sanitiseCampaignPayload(payload);
  if (!data.name) throw new AppError('Campaign name is required', 400);
  if (!data.subject) throw new AppError('Subject is required', 400);

  const nowIso = new Date().toISOString();
  const inserted = await db('email_campaigns').insert({
    status: 'draft',
    recipient_mode: 'all_active',
    send_rate_per_minute: DEFAULT_RATE_PER_MINUTE,
    ...data,
    created_by_admin_id: adminId || null,
    created_at: nowIso,
    updated_at: nowIso,
  }).returning('id');
  const id = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];

  await logActivity('newsletter_created', { campaignId: id, name: data.name },
    null, { type: 'admin', id: adminId });

  return await getCampaign(id);
}

async function updateCampaign(id, payload, adminId) {
  const campaign = await getCampaign(id);
  if (campaign.status !== 'draft') {
    throw new AppError('Only a draft campaign can be edited', 409);
  }
  const data = sanitiseCampaignPayload(payload);
  if (Object.keys(data).length === 0) return campaign;

  data.updated_at = new Date().toISOString();
  await db('email_campaigns').where({ id }).update(data);

  await logActivity('newsletter_updated', {
    campaignId: id, fields: Object.keys(data).filter((k) => k !== 'updated_at'),
  }, null, { type: 'admin', id: adminId });

  return await getCampaign(id);
}

async function deleteCampaign(id, adminId) {
  const campaign = await getCampaign(id);
  if (!['draft', 'cancelled'].includes(campaign.status)) {
    throw new AppError(`A ${campaign.status} campaign cannot be deleted`, 409);
  }
  // Recipient rows cascade; queue rows for a cancelled campaign were already
  // deleted by cancel(), and sent ones are history that stays in the queue.
  await db('email_campaigns').where({ id }).del();
  await logActivity('newsletter_deleted', { campaignId: id, name: campaign.name },
    null, { type: 'admin', id: adminId });
  return { deleted: true };
}

/**
 * Send one test copy, rendered with sample data, without touching the queue
 * or the recipient table. `test_sent_at` is stamped so the list can show that
 * a campaign was proofed before it went out.
 */
async function sendTest(campaignId, toEmail, adminId) {
  const campaign = await getCampaign(campaignId);
  const { sendRawEmail } = require('./emailProcessor');

  const sample = {
    id: null,
    email: toEmail,
    salutation: 'Ms.',
    first_name: 'Alex',
    last_name: 'Sample',
    display_name: 'Alex Sample',
    company_name: 'Sample & Co',
    preferred_language: campaign.language,
  };
  // No real customer id, so no real unsubscribe token — the test mail gets a
  // dead link rather than one that would opt a stranger out.
  const { subject, html } = await renderForRecipient(campaign, sample, {
    unsubscribeUrl: `${(await getFrontendBaseUrl()) || ''}/api/public/newsletter/unsubscribe/test`,
  });

  await sendRawEmail({ to: toEmail, subject: `[Test] ${subject}`, html });

  await db('email_campaigns').where({ id: campaignId }).update({
    test_sent_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  await logActivity('newsletter_test_sent', { campaignId, to: toEmail },
    null, { type: 'admin', id: adminId });

  return { sent: true };
}

module.exports = {
  sanitizeCampaignBody,
  sanitizeCampaignCss,
  unsubscribeToken,
  verifyUnsubscribeToken,
  unsubscribeUrl,
  renderForRecipient,
  resolveRecipients,
  queueCampaign,
  cancel,
  recordRecipientResult,
  recomputeCounts,
  shouldSkipForOptOut,
  markSkippedOptOut,
  setMarketingOptOut,
  getCampaign,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  sendTest,
  // Exported for the routes' validators and the tests.
  clampRate,
  MAX_BODY_BYTES,
  MAX_SUBJECT_LENGTH,
  MIN_RATE_PER_MINUTE,
  MAX_RATE_PER_MINUTE,
  DEFAULT_RATE_PER_MINUTE,
  VALID_STATUSES,
  VALID_RECIPIENT_MODES,
};
