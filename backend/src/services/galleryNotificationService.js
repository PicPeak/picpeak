'use strict';

/**
 * Who hears that a gallery is ready, and the one place that tells them.
 *
 * A gallery has two kinds of recipient:
 *   - the inline customer email on the event row, which gets the standard
 *     `gallery_created` mail (link + password), and
 *   - the customer accounts assigned to it, which get `customer_gallery_assigned`
 *     (a link to their portal, in their own language, no password — the portal
 *     opens the gallery without one).
 *
 * Every action that announces a gallery — create, publish, send later, resend —
 * goes through notifyGalleryRecipients, so they all reach the same people. One
 * person entered in both places is told once (see resolveGalleryRecipients).
 */

const { db } = require('../database/db');
const logger = require('../utils/logger');
const { queueEmail } = require('./emailProcessor');
const { buildShareLinkVariants } = require('./shareLinkService');
const { getFrontendBaseUrl, getAbsoluteFrontendUrl } = require('../utils/frontendUrl');
const { hasColumnCached } = require('../utils/schemaCache');
const { formatBoolean } = require('../utils/dbCompat');
const { parseBooleanInput } = require('../utils/parsers');

/**
 * Can this assigned customer account actually receive — and act on — the
 * gallery notice? (#1235)
 *
 * Mirrored by the UI that decides whether to offer the button at all; the two
 * have to agree, or the admin gets an action that 400s, or worse, one that
 * reports success for a notice nobody can use.
 *
 * - `is_active`: compared loosely because SQLite stores it as 0/1 and a
 *   strict `!== false` lets 0 through.
 * - `can_sign_in`: a PASSIVE customer (password_hash IS NULL — see
 *   customerAccountsService.createDirect) is a real, active account that has
 *   simply never been invited. customer_gallery_assigned links to
 *   /customer/dashboard, and customerAuth rejects login without a hash, so
 *   mailing one sends a link to a door that will not open.
 * - the column is emitted by a raw SQL predicate, so it arrives as a boolean
 *   on Postgres and 0/1 on SQLite; `== false` and `=== 0` cover both, and
 *   undefined (older callers) stays permissive.
 */
function canReceiveGalleryNotice(account) {
  if (!account || !account.email) return false;
  if (account.is_active === false || account.is_active === 0) return false;
  if (account.can_sign_in === false || account.can_sign_in === 0) return false;
  return true;
}

const sameAddress = (a, b) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/** The name an admin recognises an account by. */
function accountLabel(account) {
  const full = [account.first_name, account.last_name].filter(Boolean).join(' ').trim();
  return account.display_name?.trim() || full || account.email;
}

/**
 * The accounts a gallery notice can reach. Empty while the customer portal is
 * off: the portal mail links to a dashboard that is not there.
 */
async function reachableAccountsForEvent(eventId) {
  const customerAccountsService = require('./customerAccountsService');
  if (!(await customerAccountsService.isCustomerPortalEnabled())) return [];
  const assigned = await customerAccountsService.getAssignmentsForEvent(eventId);
  return assigned.filter(canReceiveGalleryNotice);
}

/**
 * The given accounts a gallery notice could reach — the same rule as
 * reachableAccountsForEvent, for a gallery whose assignments are not written
 * yet. Creation decides from this whether the gallery is announced only
 * through the portal, so it can never decide that for an account the notice
 * would then skip.
 */
async function reachableAccountsByIds(ids) {
  if (!ids || ids.length === 0) return [];
  const customerAccountsService = require('./customerAccountsService');
  if (!(await customerAccountsService.isCustomerPortalEnabled())) return [];
  const rows = await db('customer_accounts')
    .whereIn('id', ids)
    .select('id', 'email', 'is_active', db.raw('(password_hash IS NOT NULL) as can_sign_in'));
  return rows.filter(canReceiveGalleryNotice);
}

/**
 * Whether the standard gallery email carries something the portal email does
 * not: the welcome message, or the client-access link and PIN (#172).
 */
function hasGalleryEmailOnlyContent(event) {
  const welcome = typeof event.welcome_message === 'string' && event.welcome_message.trim() !== '';
  const clientAccess = event.client_access_enabled === true || event.client_access_enabled === 1
    || event.client_access_enabled === '1' || event.client_access_enabled === 'true';
  return welcome || clientAccess;
}

/**
 * Who a gallery notice for this event goes to.
 *
 * One person entered both as the inline address and as an assigned account is
 * told once. The content decides which mail: the standard gallery email when
 * it carries something the portal email does not (welcome message, client
 * access), otherwise the portal email.
 *
 * `includeAccounts` is the caller's customers.events — the permission that
 * governs assigning accounts also governs mailing them, on every path.
 *
 * `fallbackFor` names the account the inline address was folded into, so the
 * notifier can still send the standard email when that account's notice is
 * skipped (draft, expired, archived) — the person is told once, not never.
 *
 * `preferPortal`: a mail with nothing the portal version lacks (the
 * "complete gallery" mail carries no welcome message or client access)
 * always folds one person into the account version.
 *
 * @returns {Promise<{ inlineEmail: string|null, accounts: object[], fallbackFor?: object }>}
 */
async function resolveGalleryRecipients(event, { includeAccounts = true, preferPortal = false } = {}) {
  const reachable = includeAccounts ? await reachableAccountsForEvent(event.id) : [];
  const contact = event.customer_email || event.host_email || null;
  const samePerson = contact ? reachable.find((a) => sameAddress(a.email, contact)) : null;
  if (!samePerson) return { inlineEmail: contact, accounts: reachable };
  if (!preferPortal && hasGalleryEmailOnlyContent(event)) {
    return { inlineEmail: contact, accounts: reachable.filter((a) => a !== samePerson) };
  }
  return { inlineEmail: null, accounts: reachable, fallbackFor: { account: samePerson, email: contact } };
}

/**
 * The standard gallery_created payload for an event row. `password` is the
 * plaintext the admin just typed (#627); without one the mail carries the
 * legacy sentinel, as an API-only publish always has.
 */
async function galleryCreatedEmailData(event, { password, requirePassword } = {}) {
  const customerEmail = event.customer_email || event.host_email;
  const customerName = event.customer_name || event.host_name;
  const { shareUrl } = await buildShareLinkVariants({ slug: event.slug, shareToken: event.share_token });

  let galleryPassword;
  if (!requirePassword) galleryPassword = 'No password required';
  else if (password) galleryPassword = password;
  else galleryPassword = '(set at creation)';

  return {
    customer_name: customerName,
    customer_email: customerEmail,
    host_name: customerName || customerEmail.split('@')[0],
    event_name: event.event_name,
    event_date: event.event_date,
    gallery_link: shareUrl || `${await getFrontendBaseUrl()}/gallery/${event.slug}`,
    gallery_password: galleryPassword,
    expiry_date: event.expires_at ? new Date(event.expires_at).toISOString() : null,
    welcome_message: event.welcome_message || '',
  };
}

/**
 * Tell everyone a gallery is ready: the standard mail to the inline address,
 * the portal mail to each reachable account. A failure for one account is
 * logged and does not stop the others.
 *
 * @param {object} event the events row
 * @param {object} opts
 * @param {(email: string) => Promise<object>|object} opts.buildInlineEmailData
 *   the gallery_created payload; only called when that mail goes out
 * @param {object} [opts.recipients] a resolveGalleryRecipients result the
 *   caller already has, so both see the same set
 * @param {boolean} [opts.allowFallback=true] false when the standard email
 *   cannot carry a usable password (a generated one, none in the request):
 *   the folded-in address then gets no fallback rather than the
 *   "(set at creation)" sentinel
 * @returns {Promise<{ inlineEmail: string|null, accounts: object[] }>} who was
 *   actually queued
 */
async function notifyGalleryRecipients(event, { buildInlineEmailData, recipients, allowFallback = true } = {}) {
  const { inlineEmail, accounts, fallbackFor } = recipients || await resolveGalleryRecipients(event);

  // Each recipient on its own: a failure for one must not cost the others
  // their mail. Only what was actually queued is reported back — queueEmail
  // resolves false when it queued nothing.
  const queueInline = async (email) => {
    try {
      return (await queueEmail(event.id, email, 'gallery_created', await buildInlineEmailData(email))) === true
        ? email : null;
    } catch (err) {
      logger.warn('Gallery email to the customer email failed', { eventId: event.id, error: err.message });
      return null;
    }
  };
  let inlineQueued = inlineEmail ? await queueInline(inlineEmail) : null;

  const customerAccountsService = require('./customerAccountsService');
  const notified = [];
  for (const account of accounts) {
    try {
      if (await customerAccountsService.notifyCustomerOfNewAssignments(account.id, [event.id])) {
        notified.push(account);
      }
    } catch (err) {
      logger.warn('Gallery notice to customer account failed', {
        eventId: event.id, customerId: account.id, error: err.message,
      });
    }
  }

  // The inline address was folded into an account whose notice was skipped:
  // send the standard email instead, so the person is still told.
  if (fallbackFor && allowFallback && !notified.includes(fallbackFor.account)) {
    inlineQueued = await queueInline(fallbackFor.email);
  }

  return { inlineEmail: inlineQueued, accounts: notified };
}

/**
 * Whether assigned accounts are told about this gallery at all: not a draft,
 * not archived, not expired. The same rule notifyCustomerOfNewAssignments
 * applies in SQL (customerAccountsService), for a single event row here; an
 * expired gallery's portal link answers 410.
 */
function accountsAnnounceable(event, now = new Date()) {
  if (parseBooleanInput(event.is_draft, false) || parseBooleanInput(event.is_archived, false)) return false;
  if (!event.expires_at) return true;
  const expires = new Date(event.expires_at);
  return Number.isNaN(expires.getTime()) || expires > now;
}

/** The gallery in a customer's portal, which opens it without the password. */
async function portalEventLink(slug) {
  return `${await getAbsoluteFrontendUrl()}/customer/events/${encodeURIComponent(slug)}`;
}

/**
 * "Your complete gallery is ready" (issue 1562) to the same people the gallery
 * was announced to: the inline address and every reachable account.
 *
 * Accounts get the same `gallery_completed` mail, linked to the gallery in
 * their customer portal, which opens it without the password. One person in
 * both fields gets that account version (resolveGalleryRecipients with
 * `preferPortal`); this mail carries no welcome message or client access, so
 * there is nothing the account version would drop. If that account's mail is
 * not queued, the person gets the standard version instead. Accounts are not
 * told about a draft, archived or expired gallery (accountsAnnounceable).
 *
 * Account mails carry the account's preferred_language as `__language`
 * (as customerDocumentNotifications does); without it the gallery's language
 * would win, because emailProcessor.getRecipientLanguage checks the event
 * first.
 *
 * @param {object} event the events row
 * @param {object} opts
 * @param {boolean} opts.includeAccounts the caller's customers.events
 * @param {(to: { email: string, name: string, link: string }) => object} opts.buildEmailData
 * @returns {Promise<{ inlineEmail: string|null, accounts: object[] }>} who was queued
 */
async function notifyGalleryCompleted(event, { includeAccounts, buildEmailData }) {
  const { inlineEmail, accounts, fallbackFor } = await resolveGalleryRecipients(event, {
    includeAccounts: includeAccounts && accountsAnnounceable(event),
    preferPortal: true,
  });

  const queue = async (email, data) => {
    try {
      return (await queueEmail(event.id, email, 'gallery_completed', data)) === true;
    } catch (err) {
      logger.warn('gallery_completed mail could not be queued', { eventId: event.id, error: err.message });
      return false;
    }
  };
  const queueInline = async (email) => {
    const { shareUrl } = await buildShareLinkVariants({ slug: event.slug, shareToken: event.share_token });
    const name = event.customer_name || event.host_name || email.split('@')[0];
    return (await queue(email, buildEmailData({ email, name, link: shareUrl }))) ? email : null;
  };

  let inlineQueued = inlineEmail ? await queueInline(inlineEmail) : null;

  const notified = [];
  if (accounts.length > 0) {
    const portalLink = await portalEventLink(event.slug);
    for (const account of accounts) {
      const data = buildEmailData({ email: account.email, name: accountLabel(account), link: portalLink });
      data.__language = account.preferred_language || undefined;
      if (await queue(account.email, data)) notified.push(account);
    }
  }

  // The inline address was folded into an account whose mail was not queued:
  // send the standard version, so the person is still told.
  if (fallbackFor && !notified.includes(fallbackFor.account)) {
    inlineQueued = await queueInline(fallbackFor.email);
  }
  return { inlineEmail: inlineQueued, accounts: notified };
}

/**
 * The recipients as the admin UI shows them. Account names and addresses are
 * customers.view data — the routes that announce a gallery need only
 * events.edit or events.support — so without it only the count is given.
 */
function describeRecipients({ inlineEmail, accounts }, { withIdentities = false } = {}) {
  return {
    email: inlineEmail || null,
    account_count: accounts.length,
    accounts: withIdentities
      ? accounts.map((a) => ({ id: a.id, name: accountLabel(a), email: a.email }))
      : [],
  };
}

/** One line for logs and the legacy `recipient` field, on the same terms. */
function recipientSummary({ inlineEmail, accounts }, { withIdentities = false } = {}) {
  const parts = inlineEmail ? [inlineEmail] : [];
  if (withIdentities) parts.push(...accounts.map((a) => a.email));
  else if (accounts.length > 0) parts.push(`${accounts.length} customer account(s)`);
  return parts.join(', ');
}

/** Whether the event row can record a generated password (migration 264). */
async function hasPasswordGeneratedColumn() {
  return hasColumnCached('events', 'password_generated');
}

/**
 * Columns to write alongside a password an admin typed or was shown: from
 * then on somebody knows it, so it is no longer the generated one.
 */
async function passwordKnownColumns() {
  return (await hasPasswordGeneratedColumn()) ? { password_generated: formatBoolean(false) } : {};
}

module.exports = {
  canReceiveGalleryNotice,
  reachableAccountsByIds,
  resolveGalleryRecipients,
  hasGalleryEmailOnlyContent,
  galleryCreatedEmailData,
  notifyGalleryRecipients,
  notifyGalleryCompleted,
  accountsAnnounceable,
  portalEventLink,
  describeRecipients,
  recipientSummary,
  hasPasswordGeneratedColumn,
  passwordKnownColumns,
};
