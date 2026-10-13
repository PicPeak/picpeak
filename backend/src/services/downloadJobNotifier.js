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
 * The request is remembered with its owner (guest or account), and the mail
 * only goes out while that owner still holds the address: a guest removed, an
 * account erased or deactivated, or an address changed since is not mailed.
 * Removal and erasure also delete the rows outright (forgetGuest,
 * forgetCustomer), so the address does not sit here until the job is swept.
 *
 * Not offered for a PIN-client's job (visibility scope 'hidden'): the link in
 * the mail opens the gallery at guest level, and the archive is only handed
 * to a client session.
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
// pg_advisory_xact_lock class for the per-address cap. 1074 and 1075 are
// taken, and 1076 by the guest-upload notice in the open PR 1949.
const ADDRESS_LOCK = 1077;

const normalise = (email) => String(email || '').trim().toLowerCase();

/**
 * Can a mail link lead back to this job? It opens the gallery through the
 * share link or the portal, which are guest level; a job built for a
 * PIN-client is refused there (the file route answers 404).
 */
const canMail = (job) => job.visibility_scope !== 'hidden';

/**
 * Who this requester is and the address they may be mailed at, or null.
 * Reads the session (req.guest from resolveGuest, the gallery grant) and
 * nothing else.
 */
async function recipientFor(req) {
  if (req.isAdminPreview) return null;
  if (req.viaCustomer) {
    const customerId = req.galleryAccess?.session?.customerId;
    if (!Number.isInteger(customerId)) return null;
    const account = await db('customer_accounts')
      .where({ id: customerId, is_active: formatBoolean(true) }).first('email');
    const email = normalise(account?.email);
    return email ? { email, customerId } : null;
  }
  if (req.guest?.emailVerified && req.guest.email) {
    return { email: normalise(req.guest.email), guestId: req.guest.id };
  }
  return null;
}

/**
 * Does the owner of this request still hold the address it was made with?
 *
 * With `trx` the owner row is share-locked on PostgreSQL until the caller
 * commits, which is what orders a new request against an erasure: the
 * erasure's write to the owner row waits for the insert and then deletes it
 * (forgetCustomer, forgetGuest), or the insert waits and finds the owner gone.
 */
async function stillHolds(recipient, trx) {
  const conn = trx || db;
  const read = (query) => (trx && trx.client.config.client === 'pg' ? query.forShare() : query).first('email');
  let owner;
  if (recipient.customer_account_id) {
    owner = await read(conn('customer_accounts')
      .where({ id: recipient.customer_account_id, is_active: formatBoolean(true) }));
  } else if (recipient.guest_id) {
    owner = await read(conn('gallery_guests')
      .where({ id: recipient.guest_id, is_deleted: formatBoolean(false) })
      .whereNotNull('email_verified_at'));
  }
  return !!owner && normalise(owner.email) === recipient.email;
}

/** Has this address already asked to be told about this job? */
async function isRequested(jobId, email) {
  return !!(await db('download_job_recipients').where({ job_id: jobId, email }).first('id'));
}

/**
 * Record that `recipient` (from recipientFor) wants the mail for `job`.
 * Returns 'requested', 'limit' when the address has used up its hour, or
 * 'gone' when the owner was erased or removed since the caller read it.
 *
 * The count and the insert are one step per address. Checked apart, parallel
 * requests for different jobs all read a count below the cap before any of
 * them inserted. SQLite has one pooled connection, so the transaction is
 * enough there; on PostgreSQL an advisory lock on the address holds the
 * others back, across replicas, until this one committed.
 */
async function request(job, recipient) {
  const { email } = recipient;
  const row = {
    job_id: job.id,
    email,
    guest_id: recipient.guestId ?? null,
    customer_account_id: recipient.customerId ?? null,
  };
  const outcome = await db.transaction(async (trx) => {
    if (trx.client.config.client === 'pg') {
      await trx.raw('SELECT pg_advisory_xact_lock(?, hashtext(?))', [ADDRESS_LOCK, email]);
      // Event row before the guest and job rows this touches: the order
      // gallery deletion takes them in (see notifyReady).
      if (!(await trx('events').where({ id: job.event_id }).forShare().first('id'))) return 'gone';
    }
    // The caller's read of the owner may predate an erasure that has already
    // deleted this owner's rows; inserting now would bring the address back.
    if (!(await stillHolds(row, trx))) return 'gone';
    if (await trx('download_job_recipients').where({ job_id: job.id, email }).first('id')) return 'requested';

    const since = new Date(Date.now() - HOUR_MS).toISOString();
    const recent = await trx('download_job_recipients')
      .where({ email }).where('created_at', '>', since).count({ n: '*' }).first();
    if (Number(recent?.n || 0) >= MAX_REQUESTS_PER_HOUR) return 'limit';

    await trx('download_job_recipients').insert({ ...row, created_at: new Date().toISOString() });
    return 'requested';
  });
  if (outcome !== 'requested') return outcome;

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
 * The job and its gallery, when its archive can be handed to someone right
 * now; null otherwise. Ready is not deliverable: the job may be past its
 * retention, the gallery may have expired, downloads been switched off or a
 * packaged photo hidden since. The file route refuses such an archive, so
 * nobody is told it is ready; the sweep removes the job and its recipients.
 */
async function deliverable(jobId) {
  const job = await db('download_jobs').where({ id: jobId }).first();
  if (!job || job.status !== 'ready') return null;
  if (new Date(job.expires_at).getTime() <= Date.now()) return null;
  const event = await db('events').where({ id: job.event_id }).first();
  if (!event) return null;
  if (!(await require('./downloadJobService').isDeliverableToAnyone(job, event))) return null;
  return { job, event };
}

/**
 * Asked by the queue processor right before it sends a download_ready mail:
 * why the mail no longer applies, or null. A queue that was held up can
 * reach the mail after the archive is gone, and the sweep that cancels such
 * mails only runs every 20 minutes; an address can change hands meanwhile.
 */
async function staleMailReason(emailData, recipientEmail) {
  const jobId = emailData?.__downloadJobId;
  if (jobId == null) return null;
  if (!(await deliverable(jobId))) return 'The prepared download is no longer available';
  // The same rule as when the mail was queued: only while the guest or
  // account that asked still holds this address (changed or deactivated since).
  const recipient = await db('download_job_recipients')
    .where({ job_id: jobId, email: normalise(recipientEmail) }).first();
  if (!recipient || !(await stillHolds(recipient))) {
    return 'The requester no longer holds this address';
  }
  return null;
}

/**
 * Mail everyone waiting on a job that just became ready. Safe to call more
 * than once and from more than one replica: a recipient is claimed with a
 * conditional update, and only the caller that wins the claim queues the mail.
 *
 * The claim and the queued mail commit together. Claimed first and queued
 * after, a failure (or a restart) in between left `notified_at` set with no
 * mail behind it, and every later pass skipped the recipient for good. A
 * recipient whose mail could not be queued stays unclaimed, and retryUnsent
 * picks it up on the next cleanup pass.
 */
async function notifyReady(jobId) {
  const waiting = await db('download_job_recipients').where({ job_id: jobId }).whereNull('notified_at');
  if (waiting.length === 0) return 0;

  const current = await deliverable(jobId);
  if (!current) return 0;
  const { job, event } = current;

  const { queueEmail } = require('./emailProcessor');
  const hoursLeft = Math.max(1, Math.round((new Date(job.expires_at).getTime() - Date.now()) / HOUR_MS));
  let sent = 0;
  for (const recipient of waiting) {
    try {
      if (!(await stillHolds(recipient))) {
        await db('download_job_recipients').where({ id: recipient.id }).del();
        continue;
      }
      // Everything that reads is done before the transaction: on SQLite it
      // holds the only connection.
      const data = {
        event_name: event.event_name,
        gallery_link: await galleryLink(event, recipient.email, job.token),
        available_hours: hoursLeft,
        // For staleMailReason, when the queue gets to this mail.
        __downloadJobId: job.id,
      };
      const queued = await db.transaction(async (trx) => {
        // Event row first on PostgreSQL, the order gallery deletion takes
        // (event, then the cascade down to these rows). Claiming first and
        // letting the queue insert's foreign key reach for the event after
        // could deadlock against it.
        if (trx.client.config.client === 'pg'
            && !(await trx('events').where({ id: event.id }).forShare().first('id'))) return false;
        const claimed = await trx('download_job_recipients')
          .where({ id: recipient.id }).whereNull('notified_at')
          .update({ notified_at: new Date().toISOString() });
        if (!claimed) return false;
        return queueEmail(event.id, recipient.email, 'download_ready', data, { trx });
      });
      if (queued) sent += 1;
    } catch (err) {
      logger.warn('download_ready mail could not be queued', { jobId, error: err.message });
    }
  }
  return sent;
}

/**
 * Second chance for recipients of finished jobs whose mail was not queued
 * (queueing failed, or the process stopped between "ready" and the notify
 * pass). Called by the cleanup pass, after the sweep.
 */
async function retryUnsent() {
  const rows = await db('download_job_recipients as r')
    .join('download_jobs as j', 'j.id', 'r.job_id')
    .where('j.status', 'ready').whereNull('r.notified_at')
    .distinct('r.job_id');
  let sent = 0;
  for (const row of rows) sent += await notifyReady(row.job_id);
  return sent;
}

/**
 * Customer erasure (customerAccountsService.eraseCustomer): drop the
 * account's requests, and any other request for its address. Runs inside the
 * erasure transaction, before the account row is anonymised (the address is
 * still the real one) and BEFORE it cancels the queued mail: a notify pass
 * that claimed a row first holds it until its mail is committed, so this
 * delete waits for it and the cancellation that follows sees that mail; one
 * that comes later finds no row to claim.
 */
async function forgetCustomer(trx, customerId, email) {
  // Take the account row first, so a request being recorded right now
  // (stillHolds) is either finished and deleted here, or waits and is refused.
  if (trx.client.config.client === 'pg') {
    await trx('customer_accounts').where({ id: customerId }).forUpdate().first('id');
  }
  return trx('download_job_recipients')
    .where({ customer_account_id: customerId }).orWhere({ email: normalise(email) }).del();
}

/**
 * A guest removed by an admin or by "forget me". Call it once the guest row
 * is soft-deleted (no new request, and no notify pass, accepts it from then
 * on), with the row as it was before its address was cleared. Their requests
 * go, and so does the
 * ready-mail already queued or sent to them for this gallery: nothing else
 * in the queue is addressed to a guest, so nothing else would scrub it.
 */
async function forgetGuest(guest) {
  await db('download_job_recipients').where({ guest_id: guest.id }).del();
  const email = normalise(guest.email);
  if (!email) return;
  const mails = () => db('email_queue')
    .where({ event_id: guest.event_id, email_type: 'download_ready' })
    .whereRaw('LOWER(recipient_email) = ?', [email]);
  await mails().where({ status: 'pending' }).update({ status: 'cancelled' });
  await mails().whereIn('status', ['sent', 'failed', 'cancelled']).update({
    recipient_email: `deleted-guest-${guest.id}@deleted.invalid`,
    email_data: JSON.stringify({ redacted: true, reason: 'guest_removed' }),
    rendered_html: null,
  });
}

/**
 * The sweep is about to remove these jobs: cancel their ready mails that have
 * not gone out yet (a queue held up for longer than the retention), which
 * would announce a download that no longer exists. The mail carries its job
 * in the link; email_data is a json column on PostgreSQL, hence the cast.
 */
async function cancelPendingMails(jobs) {
  for (const job of jobs) {
    await db('email_queue')
      .where({ event_id: job.event_id, email_type: 'download_ready', status: 'pending' })
      .whereRaw('CAST(email_data AS TEXT) LIKE ?', [`%${LINK_PARAM}=${job.token}%`])
      .update({ status: 'cancelled' });
  }
}

module.exports = {
  recipientFor, canMail, isRequested, request, notifyReady, retryUnsent, forgetCustomer, forgetGuest,
  cancelPendingMails, staleMailReason,
  MAX_REQUESTS_PER_HOUR, LINK_PARAM,
};
