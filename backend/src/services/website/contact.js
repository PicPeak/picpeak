/**
 * Contact form of the public website (issue 2618).
 *
 * A submission becomes one message in Messages › Customers (received_emails,
 * account 'customers'), so the studio answers it like any other mail. It is
 * stored as plain text only — body_html stays NULL and the admin shows
 * body_text in a <pre> — so nothing a visitor types is ever rendered as
 * markup. The studio is told by mail (sendMails); the visitor gets a
 * confirmation only when the studio chose one and a spam check is on, and it
 * never repeats the message, so the form cannot carry text to a third party.
 *
 * Abuse guards: the route's per-IP limit, a honeypot field, a cap on all
 * submissions per day, and the form must exist on the published site.
 */
const crypto = require('crypto');
const { db, logActivity } = require('../../database/db');
const { toTimestamp } = require('../../utils/dateNormalize');
const logger = require('../../utils/logger');
const { publishedDocument } = require('./service');
const { META_BYTES } = require('../mailRetentionService');

const DAILY_CAP = Number(process.env.WEBSITE_CONTACT_DAILY_CAP || 1000);
const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const MESSAGE_ID_PREFIX = '<website-contact-';
// Characters, as the form's maxlength counts them.
const MESSAGE_MAX = 5000;

function clean(value, max) {
  if (typeof value !== 'string') return '';
  // Keep line breaks in the message; drop every other control character.
  // eslint-disable-next-line no-control-regex -- intentional: strips control chars from visitor input
  return value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, ' ').trim().slice(0, max);
}

/**
 * Validate a submission. Returns { ok: true, values } or { ok: false, reason }.
 * `reason` 'spam' is answered like a success, so a bot learns nothing.
 */
const LIMITS = { name: 160, email: 255, phone: 40, message: MESSAGE_MAX };

function validateSubmission(body) {
  if (body.company_website) return { ok: false, reason: 'spam' };
  // Too long is an error the visitor sees, not a message cut short.
  for (const [field, max] of Object.entries(LIMITS)) {
    if (typeof body[field] === 'string' && [...body[field].trim()].length > max) return { ok: false, reason: 'invalid' };
  }
  const values = {
    name: clean(body.name, LIMITS.name).replace(/\n/g, ' '),
    email: clean(body.email, LIMITS.email).replace(/\n/g, ''),
    phone: clean(body.phone, LIMITS.phone).replace(/\n/g, ' '),
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || '')) ? String(body.date) : '',
    message: clean(body.message, LIMITS.message),
  };
  if (!values.name || !values.message) return { ok: false, reason: 'invalid' };
  if (!EMAIL_PATTERN.test(values.email)) return { ok: false, reason: 'invalid' };
  return { ok: true, values };
}

/** The published page and contact block a submission names, or null. */
async function findForm(pageId, blockId) {
  const document = await publishedDocument();
  if (!document) return null;
  const page = document.pages.find((p) => p.id === pageId && !p.hidden);
  const block = page && page.blocks.find((b) => b.id === blockId && b.type === 'contact');
  return block ? { page, block } : null;
}

async function overDailyCap() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const row = await db('received_emails')
    .where('message_id', 'like', `${MESSAGE_ID_PREFIX}%`)
    .where('received_at', '>=', since)
    .count({ c: '*' }).first();
  return Number(row?.c || 0) >= DAILY_CAP;
}

const CAP_ACTIVITY = 'website_contact_cap_reached';

/**
 * The studio hears of a reached cap in the notification bell, once a day:
 * visitors are being turned away, which a log line alone would hide.
 */
async function tellStudioCapReached() {
  // created_at is the database's default (SQLite: zone-less text), so it is
  // compared as a timestamp, not as a string.
  const last = await db('activity_logs').where({ activity_type: CAP_ACTIVITY }).orderBy('id', 'desc').first('created_at');
  if (last && Date.now() - toTimestamp(last.created_at) < 24 * 60 * 60 * 1000) return;
  await logActivity(CAP_ACTIVITY, { cap: DAILY_CAP });
}

function formatBody(values, page) {
  const lines = [
    `Name: ${values.name}`,
    `Email: ${values.email}`,
  ];
  if (values.phone) lines.push(`Phone: ${values.phone}`);
  if (values.date) lines.push(`Event date: ${values.date}`);
  lines.push(`Page: ${page.title} (/${page.isHome ? '' : page.slug})`, '', values.message);
  return lines.join('\n');
}

/**
 * Store a validated submission. Returns 'stored', or 'capped' when the daily
 * cap is reached (the visitor gets the error note, nothing is stored).
 */
async function storeSubmission(values, page) {
  if (await overDailyCap()) {
    logger.warn('Website contact form: daily cap reached, submission dropped');
    await tellStudioCapReached();
    return 'capped';
  }
  const now = new Date().toISOString();
  const body = formatBody(values, page);
  await db('received_emails').insert({
    message_id: `${MESSAGE_ID_PREFIX}${crypto.randomUUID()}@picpeak>`,
    account_key: 'customers',
    from_address: values.email,
    subject: `Website enquiry from ${values.name}`.slice(0, 300),
    received_at: now,
    attachment_count: 0,
    status: 'no_attachment',
    body_text: body,
    body_html: null,
    // Counted like an intake mail's body, so the mailbox's storage figures
    // include website messages.
    retained_bytes: META_BYTES + Buffer.byteLength(body),
    mailbox_state: 'active',
    created_at: now,
  });
  return 'stored';
}

// At most one confirmation a day to an address, whatever the senders do.
const CONFIRMATION_WINDOW_MS = 24 * 60 * 60 * 1000;

// email_queue.created_at comes back as a Date (PostgreSQL) or epoch ms
// (SQLite), so it is read with toMillis rather than compared in SQL.
async function confirmedRecently(email) {
  const { toMillis } = require('../../utils/queueTimestamps');
  const since = Date.now() - CONFIRMATION_WINDOW_MS;
  const rows = await db('email_queue').where({ email_type: 'website_contact_confirmation', recipient_email: email })
    .orderBy('id', 'desc').limit(5).select('created_at');
  return rows.some((row) => {
    const ms = toMillis(row.created_at);
    return ms !== null && ms >= since;
  });
}

/**
 * The mails of a stored message (contact settings): a notification to the
 * studio's recipients, with the message; and, when chosen and the spam check
 * is on, a confirmation to the visitor with their name and the studio's
 * fixed text, never the message. Best effort: the message is in the inbox
 * whatever happens here.
 */
async function sendMails(values, page, { captchaOn }) {
  const emailProcessor = require('../emailProcessor');
  const { mailSettings } = require('./contactSettings');
  const { getFrontendBaseUrl } = require('../../utils/frontendUrl');
  const { getAppSetting } = require('../../utils/appSettings');
  const settings = await mailSettings();
  const base = (await getFrontendBaseUrl().catch(() => '')) || '';
  const language = (await getAppSetting('general_default_language', 'en')) === 'de' ? 'de' : 'en';
  const path = page.isHome ? '/' : `/${page.slug}`;
  const studio = {
    sender_name: values.name,
    sender_email: values.email,
    sender_phone: values.phone,
    event_date: values.date,
    page_title: page.title,
    page_url: `${base}${path}`,
    message: values.message,
    inbox_link: `${base}/admin/messages`,
    __language: language,
  };
  for (const to of settings.recipients) {
    // eslint-disable-next-line no-await-in-loop -- a handful of recipients
    await emailProcessor.queueEmail(null, to, 'website_contact_admin', { ...studio });
  }
  if (settings.confirmation && captchaOn && !(await confirmedRecently(values.email))) {
    const name = (await getAppSetting('branding_company_name', '')) || '';
    await emailProcessor.queueEmail(null, values.email, 'website_contact_confirmation', {
      sender_name: values.name.slice(0, 60), business_name: typeof name === 'string' ? name : '', __language: language,
    });
  }
}

module.exports = { validateSubmission, findForm, storeSubmission, sendMails, EMAIL_PATTERN, DAILY_CAP, MESSAGE_MAX, _internal: { formatBody, overDailyCap } };
