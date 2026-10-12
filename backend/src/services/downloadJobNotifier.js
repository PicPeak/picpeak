/**
 * "Email me when it is ready" for download jobs (issue 1733).
 *
 * A large archive can take minutes to build, and with a longer retention the
 * requester no longer has to wait in front of the dialog. They can ask for a
 * mail instead.
 *
 * SECURITY: the address is never taken from the request. An endpoint that
 * mails whatever address a gallery visitor types is a mail relay. The only
 * addresses used are ones the instance already holds for the requester:
 *
 *   - a guest identity whose address was verified (gallery_guests
 *     .email_verified_at, set when the guest entered the code mailed to it).
 *     The address typed at registration is NOT enough: anyone can type anyone's.
 *   - the customer account behind a customer-portal gallery session.
 *
 * Everyone else is simply not offered the option. On top of that an address
 * is capped per hour, and mailed once per job.
 *
 * The mail links to the gallery, never to the archive. Opening it goes through
 * the normal gallery access (password, expiry, revoked assignment), and the
 * gallery then offers the finished download. After a password change or an
 * expiry the link lands on the usual prompt or expired page.
 */

const { db } = require('../database/db');
const { formatBoolean } = require('../utils/dbCompat');
const logger = require('../utils/logger');

// Mails one address may ask for per hour, across all galleries.
const MAX_REQUESTS_PER_HOUR = 5;
const HOUR_MS = 60 * 60 * 1000;
// Carried on the gallery link; the gallery reads it and offers the job.
const LINK_PARAM = 'download_job';

const normalise = (email) => String(email || '').trim().toLowerCase();

/**
 * The address this requester may be mailed at, or null. Reads the session
 * (req.guest from resolveGuest, the gallery grant) and nothing else.
 */
async function recipientFor(req) {
  if (req.isAdminPreview) return null;
  if (req.viaCustomer) {
    const customerId = req.galleryAccess?.session?.customerId;
    if (!Number.isInteger(customerId)) return null;
    const account = await db('customer_accounts')
      .where({ id: customerId, is_active: formatBoolean(true) }).first('email');
    return normalise(account?.email) || null;
  }
  if (req.guest?.emailVerified && req.guest.email) return normalise(req.guest.email);
  return null;
}

/** Has this address already asked to be told about this job? */
async function isRequested(jobId, email) {
  return !!(await db('download_job_recipients').where({ job_id: jobId, email }).first('id'));
}

/**
 * Record that `email` wants the mail for `job`.
 * Returns 'requested', or 'limit' when the address has used up its hour.
 */
async function request(job, email) {
  if (await isRequested(job.id, email)) return 'requested';

  const since = new Date(Date.now() - HOUR_MS).toISOString();
  const recent = await db('download_job_recipients')
    .where({ email }).where('created_at', '>', since).count({ n: '*' }).first();
  if (Number(recent?.n || 0) >= MAX_REQUESTS_PER_HOUR) return 'limit';

  try {
    await db('download_job_recipients').insert({
      job_id: job.id, email, created_at: new Date().toISOString(),
    });
  } catch (err) {
    // Two tabs asking at once: the unique index kept one row, which is the point.
    if (!(await isRequested(job.id, email))) throw err;
  }

  // The build may have finished between the caller's read and this insert,
  // in which case its own notify pass ran before the row existed.
  const current = await db('download_jobs').where({ id: job.id }).first('status');
  if (current?.status === 'ready') await notifyReady(job.id);
  return 'requested';
}

async function galleryLink(event, email, token) {
  const { galleryLinkFor } = require('./galleryNotificationService');
  const { buildShareLinkVariants, getEventShareToken } = require('./shareLinkService');
  const { getAbsoluteFrontendUrl } = require('../utils/frontendUrl');

  const base = await getAbsoluteFrontendUrl();
  const shareToken = getEventShareToken(event);
  const shareUrl = shareToken
    ? (await buildShareLinkVariants({ slug: event.slug, shareToken })).shareUrl
    : `${base}/gallery/${encodeURIComponent(event.slug)}`;
  // A customer account gets the gallery in its portal, as in every other mail.
  const url = new URL(await galleryLinkFor(event, email, shareUrl), base);
  url.searchParams.set(LINK_PARAM, token);
  return url.toString();
}

/**
 * Mail everyone waiting on a job that just became ready. Safe to call more
 * than once and from more than one replica: a recipient is claimed with a
 * conditional update, and only the caller that wins the claim queues the mail.
 */
async function notifyReady(jobId) {
  const waiting = await db('download_job_recipients').where({ job_id: jobId }).whereNull('notified_at');
  if (waiting.length === 0) return 0;

  const job = await db('download_jobs').where({ id: jobId }).first();
  if (!job || job.status !== 'ready') return 0;
  const event = await db('events').where({ id: job.event_id }).first();
  if (!event) return 0;

  const { queueEmail } = require('./emailProcessor');
  const hoursLeft = Math.max(1, Math.round((new Date(job.expires_at).getTime() - Date.now()) / HOUR_MS));
  let sent = 0;
  for (const recipient of waiting) {
    const claimed = await db('download_job_recipients')
      .where({ id: recipient.id }).whereNull('notified_at')
      .update({ notified_at: new Date().toISOString() });
    if (!claimed) continue;
    try {
      const queued = await queueEmail(event.id, recipient.email, 'download_ready', {
        event_name: event.event_name,
        gallery_link: await galleryLink(event, recipient.email, job.token),
        available_hours: hoursLeft,
      });
      if (queued) sent += 1;
    } catch (err) {
      logger.warn('download_ready mail could not be queued', { jobId, error: err.message });
    }
  }
  return sent;
}

module.exports = { recipientFor, isRequested, request, notifyReady, MAX_REQUESTS_PER_HOUR, LINK_PARAM };
