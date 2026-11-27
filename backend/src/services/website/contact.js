/**
 * Contact form of the public website (issue 2618).
 *
 * A submission becomes one message in Messages › Customers (received_emails,
 * account 'customers'), so the studio answers it like any other mail. It is
 * stored as plain text only — body_html stays NULL and the admin shows
 * body_text in a <pre> — so nothing a visitor types is ever rendered as
 * markup. Nothing is sent: no confirmation mail, no forward, so the form can
 * never be used to mail a third party.
 *
 * Abuse guards: the route's per-IP limit, a honeypot field, a cap on all
 * submissions per day, and the form must exist on the published site.
 */
const crypto = require('crypto');
const { db } = require('../../database/db');
const logger = require('../../utils/logger');
const { publishedDocument } = require('./service');
const { META_BYTES } = require('../mailRetentionService');

const DAILY_CAP = Number(process.env.WEBSITE_CONTACT_DAILY_CAP || 200);
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

module.exports = { validateSubmission, findForm, storeSubmission, DAILY_CAP, MESSAGE_MAX, _internal: { formatBody, overDailyCap } };
