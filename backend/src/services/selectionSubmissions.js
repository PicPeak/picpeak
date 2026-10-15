/**
 * Finish selection / approve edited photos (issue 1733, A1; migration 291).
 *
 * A guest hands over their picks (`selection`) or signs off the edited photos
 * (`approval`). Each is per guest: a registered guest by guest_id, anyone else
 * by the anonymous browser identity, the same rule that finds the viewer's
 * rows in photo_feedback. While a submission is active the feedback it covers
 * is frozen for that guest (LOCKED_TYPES); everything else stays writable.
 * An admin reopens it, which keeps the row as history and lifts the lock.
 *
 * The lock only holds if a hand-over and a feedback write of the same guest
 * never overlap: both run inside withViewerLock, each with its check and its
 * write in the one transaction.
 *
 * Does not require feedbackService: that module calls into this one from its
 * write path, so the caller passes the event's feedback settings in.
 */

const { db, logActivity } = require('../database/db');
const logger = require('../utils/logger');
const { isUniqueViolation } = require('../utils/dbErrors');
const { toUtcIso } = require('../utils/queueTimestamps');
const { applyPhotoVisibilityFilter, joinLivePhotos, wherePhotoProcessed } = require('../utils/photoVisibility');

const KINDS = ['selection', 'approval'];
const NOTE_MAX_LENGTH = 1000;
// First key of the PostgreSQL advisory lock; the second is the viewer's hash.
const VIEWER_LOCK_CLASS = 0x53656c53; // SelS

/** The feedback types a submission of each kind freezes. */
const LOCKED_TYPES = {
  selection: ['like', 'favorite'],
  approval: ['decision'],
};

function kindLocking(feedbackType) {
  return KINDS.find((kind) => LOCKED_TYPES[kind].includes(feedbackType)) || null;
}

/** Narrow a query to one viewer, as photo_feedback reads do. */
function scopeToViewer(query, { guestId, guestIdentifier }, table = null) {
  const column = (name) => (table ? `${table}.${name}` : name);
  return guestId
    ? query.where(column('guest_id'), guestId)
    : query.where(column('guest_identifier'), guestIdentifier);
}

/**
 * Run `work(trx)` with this viewer's hand-overs and locked feedback writes
 * held off until it commits. A like that overlapped a submission otherwise
 * passed the lock check, then landed after the count was stored.
 *
 * PostgreSQL: a transaction-scoped advisory lock on the viewer's identifier,
 * the key of the unique index, so other guests and other replicas' requests
 * for other guests never wait on it. SQLite has one connection, and the
 * transaction holds it: everything in `work` must go through `trx`, and
 * nothing in it may read through the global pool (hasColumnCached included).
 */
async function withViewerLock(eventId, viewer, work) {
  return db.transaction(async (trx) => {
    if (trx.client.config.client === 'pg') {
      await trx.raw('SELECT pg_advisory_xact_lock(?, hashtext(?))', [
        VIEWER_LOCK_CLASS, `${eventId}:${viewer.guestIdentifier}`,
      ]);
    }
    return work(trx);
  });
}

function present(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    submitted_at: toUtcIso(row.submitted_at),
    item_count: Number(row.item_count) || 0,
    note: row.note || null,
  };
}

async function activeSubmission(eventId, viewer, kind, executor = db) {
  return scopeToViewer(
    executor('selection_submissions').where({ event_id: eventId, kind }).whereNull('reopened_at'),
    viewer,
  ).first();
}

/**
 * Whether the registered guest of this request is gone by now. resolveGuest
 * ran before a merge or a deletion that may have finished since. Inside the
 * viewer's transaction, and before anything is read for them: FOR SHARE
 * waits for a merge in flight (it holds the guest rows FOR UPDATE) and keeps
 * the next one out until this transaction commits, so a merge can neither
 * move a submission onto this guest behind a write that has passed the lock
 * check, nor leave a new submission behind under a guest it has deleted.
 * SQLite serialises the transactions outright.
 */
async function guestGone(trx, guestId) {
  if (!guestId) return false;
  const guest = trx('gallery_guests').where({ id: guestId }).first('is_deleted');
  if (trx.client.config.client === 'pg') guest.forShare();
  const row = await guest;
  return !row || Boolean(row.is_deleted);
}

/**
 * The active submission that freezes this feedback type for this viewer, or
 * null. Called from feedbackService.submitFeedback before any write.
 */
async function lockFor(eventId, feedbackType, viewer, executor = db) {
  const kind = kindLocking(feedbackType);
  if (!kind) return null;
  return present(await activeSubmission(eventId, viewer, kind, executor));
}

/**
 * What counts as a pick in this gallery, and the cap on it. A capped type is
 * the selection (favourites first when both are capped); with no cap every
 * photo the guest liked or favourited is one pick.
 */
function selectionPicks(settings) {
  const favorites = Boolean(settings.allow_favorites);
  const likes = Boolean(settings.allow_likes);
  const favoriteCap = Number(settings.max_favorites_per_guest) || 0;
  const likeCap = Number(settings.max_likes_per_guest) || 0;
  if (favorites && favoriteCap > 0) return { types: ['favorite'], cap: favoriteCap };
  if (likes && likeCap > 0) return { types: ['like'], cap: likeCap };
  return { types: [favorites && 'favorite', likes && 'like'].filter(Boolean), cap: null };
}

/**
 * The viewer's feedback rows on the photos they can still see, as
 * /my-feedback lists them: a pick on a photo the client has since hidden is
 * not in the guest's count, so it is not in the one handed in either. Nor is
 * one on a photo back in processing (an admin retry), which the gallery list
 * leaves out until it is complete again; the row is kept and counts then.
 */
function visibleFeedback(eventId, viewer, executor) {
  return scopeToViewer(
    applyPhotoVisibilityFilter(
      wherePhotoProcessed(executor('photo_feedback')
        .modify(joinLivePhotos, 'photo_feedback.photo_id', 'photos.id')
        // Hidden rows are absent everywhere else, the cap included (#1150).
        .where({ 'photo_feedback.event_id': eventId, 'photo_feedback.is_hidden': false })),
      viewer.accessLevel,
    ),
    viewer,
    'photo_feedback',
  );
}

async function countPicks(eventId, viewer, types, executor = db) {
  if (types.length === 0) return 0;
  const row = await visibleFeedback(eventId, viewer, executor)
    .whereIn('photo_feedback.feedback_type', types)
    .countDistinct('photo_feedback.photo_id as count').first();
  return Number(row?.count) || 0;
}

async function countDecisions(eventId, viewer, executor = db) {
  const rows = await visibleFeedback(eventId, viewer, executor)
    .where('photo_feedback.feedback_type', 'decision')
    .groupBy('photo_feedback.decision').select('photo_feedback.decision').count('photo_feedback.id as count');
  const counts = { approved: 0, rejected: 0 };
  for (const row of rows) {
    if (row.decision in counts) counts[row.decision] = Number(row.count) || 0;
  }
  return counts;
}

/** The viewer's own state per kind, for GET /:slug/selection. */
async function getState(eventId, settings, viewer, executor = db) {
  const enabled = Boolean(settings.feedback_enabled);
  const picks = selectionPicks(settings);
  const selectionOn = enabled && picks.types.length > 0;
  const canSubmitSelection = selectionOn && Boolean(settings.allow_selection_submit);
  const canSubmitApproval = enabled && Boolean(settings.allow_decisions);
  // The counter shows where it means something: a cap to count against, or a
  // selection to hand in.
  const counter = selectionOn && (picks.cap !== null || canSubmitSelection);

  const [used, decisions, selection, approval] = await Promise.all([
    counter ? countPicks(eventId, viewer, picks.types, executor) : 0,
    canSubmitApproval ? countDecisions(eventId, viewer, executor) : { approved: 0, rejected: 0 },
    canSubmitSelection ? activeSubmission(eventId, viewer, 'selection', executor) : null,
    canSubmitApproval ? activeSubmission(eventId, viewer, 'approval', executor) : null,
  ]);

  return {
    selection: {
      counter,
      can_submit: canSubmitSelection,
      pick_types: picks.types,
      cap: picks.cap,
      used,
      submission: present(selection),
    },
    approval: {
      can_submit: canSubmitApproval,
      approved: decisions.approved,
      rejected: decisions.rejected,
      submission: present(approval),
    },
  };
}

/**
 * Record a submission. Returns one of
 *   { disabled: true }            this gallery does not take that kind
 *   { empty: true }               a selection with nothing picked
 *   { already: submission }       this guest already has an active one
 *   { guest_missing: true }       the registered guest was merged or deleted
 *   { submission, rejected }      written; `rejected` only for an approval
 */
async function submit(eventId, settings, viewer, { kind, note, guestName }) {
  try {
    // Count and insert under the viewer's lock: a like still in flight has
    // either landed and is counted, or finds the submission and is refused.
    return await withViewerLock(eventId, viewer, async (trx) => {
      if (await guestGone(trx, viewer.guestId)) return { guest_missing: true };
      const state = await getState(eventId, settings, viewer, trx);
      if (!state[kind].can_submit) return { disabled: true };
      if (state[kind].submission) return { already: state[kind].submission };

      const itemCount = kind === 'selection' ? state.selection.used : state.approval.approved;
      if (kind === 'selection' && itemCount === 0) return { empty: true };

      const inserted = await trx('selection_submissions').insert({
        event_id: eventId,
        guest_id: viewer.guestId || null,
        guest_identifier: viewer.guestIdentifier,
        guest_name: guestName || null,
        kind,
        item_count: itemCount,
        note: note || null,
        submitted_at: new Date().toISOString(),
      }).returning('id');
      const id = inserted[0]?.id ?? inserted[0];
      const row = await trx('selection_submissions').where({ id }).first();
      return {
        submission: present(row),
        ...(kind === 'approval' ? { rejected: state.approval.rejected } : {}),
      };
    });
  } catch (error) {
    // The partial unique index is the backstop behind the lock. Caught out
    // here: the failed insert has aborted the transaction on PostgreSQL.
    if (!isUniqueViolation(error)) throw error;
    return { already: present(await activeSubmission(eventId, viewer, kind)) };
  }
}

/** Every submission of a gallery, newest first, for the admin. */
async function listForEvent(eventId) {
  const rows = await db('selection_submissions')
    .leftJoin('gallery_guests', 'selection_submissions.guest_id', 'gallery_guests.id')
    .where('selection_submissions.event_id', eventId)
    .select('selection_submissions.*', 'gallery_guests.name as registered_name')
    .orderBy('selection_submissions.id', 'desc');
  return rows.map((row) => ({
    ...present(row),
    guest_id: row.guest_id ?? null,
    // The registered name follows a rename or a merge; the stored one is what
    // an anonymous guest typed with their feedback.
    guest_name: row.registered_name || row.guest_name || null,
    reopened_at: toUtcIso(row.reopened_at),
  }));
}

/** Reopen an active submission of this gallery. Returns the row, or null. */
async function reopen(eventId, submissionId, adminId) {
  const updated = await db('selection_submissions')
    .where({ id: submissionId, event_id: eventId })
    .whereNull('reopened_at')
    .update({ reopened_at: new Date().toISOString(), reopened_by: adminId ?? null });
  if (!updated) return null;
  return db('selection_submissions').where({ id: submissionId }).first();
}

/**
 * A guest merge carries the submissions along (feedbackService
 * .mergeGuestFeedback). One active submission per kind survives, the latest:
 * the merged guest is one person, and one person hands a selection in once.
 */
async function mergeGuests(trx, survivor, sourceGuestIds) {
  const scope = () => trx('selection_submissions')
    .where({ event_id: survivor.event_id })
    .whereIn('guest_id', [survivor.id, ...sourceGuestIds]);
  const active = await scope().whereNull('reopened_at').orderBy('id', 'desc').select('id', 'kind');
  const kept = new Set();
  const superseded = [];
  for (const row of active) {
    if (kept.has(row.kind)) superseded.push(row.id);
    else kept.add(row.kind);
  }
  // Before the identifier is rewritten: two active rows of one kind under one
  // identifier is exactly what the unique index refuses.
  if (superseded.length > 0) {
    await trx('selection_submissions').whereIn('id', superseded).delete();
  }
  await scope().update({ guest_id: survivor.id, guest_identifier: survivor.identifier });
}

/**
 * "Forget me" and guest deletion: the submission stays, the person goes.
 * The routes call it once more after the soft delete: a hand-over that got
 * in between the first pass and the delete is stored with the guest's name.
 */
async function anonymizeGuest(guestId) {
  await db('selection_submissions').where({ guest_id: guestId })
    .update({ guest_id: null, guest_name: null });
}

const FEEDBACK_NAME_PAGE = 50;

/**
 * The name to show the photographer for an anonymous viewer: the one they
 * last typed with their feedback, if any. Registered guests carry their own.
 * `requireEmail`: only feedback that also carried a name and an email
 * counts, for a gallery that requires both (a name given while they were
 * optional is not enough, issue 1984). While optional, the feedback routes
 * store a blank name or email as sent, so blank does not count either.
 */
async function feedbackName(eventId, viewer, { requireEmail = false } = {}) {
  const query = db('photo_feedback').where({ event_id: eventId }).whereNotNull('guest_name');
  if (!requireEmail) {
    const row = await scopeToViewer(query, viewer).orderBy('id', 'desc').first('guest_name');
    return row?.guest_name || null;
  }
  // Blank judged in JS, as the validators judge it: SQL TRIM strips spaces
  // only, and a tab-only email is as blank as a space-only one. A page at a
  // time, newest first: the newest row usually answers, and a long history
  // is never loaded whole.
  const scoped = scopeToViewer(query.whereNotNull('guest_email'), viewer).orderBy('id', 'desc');
  for (let offset = 0; ; offset += FEEDBACK_NAME_PAGE) {
    const rows = await scoped.clone().offset(offset).limit(FEEDBACK_NAME_PAGE)
      .select('guest_name', 'guest_email');
    const row = rows.find((r) => String(r.guest_name).trim() && String(r.guest_email).trim());
    if (row) return row.guest_name;
    if (rows.length < FEEDBACK_NAME_PAGE) return null;
  }
}

/**
 * Tell the photographer: the admin bell, the `selection.submitted` webhook
 * and a mail to the gallery's admin address. Never throws: the submission is
 * already stored, and a notification that failed must not undo that for the
 * guest.
 */
async function notifySubmitted(event, submission, { guestName, guestIdentifier, rejected }) {
  const isApproval = submission.kind === 'approval';
  await logActivity(isApproval ? 'approval_submitted' : 'selection_submitted', {
    kind: submission.kind,
    guestName: guestName || 'Anonymous',
    count: submission.item_count,
    eventName: event.event_name,
  }, event.id, { type: 'guest', id: String(guestIdentifier).substring(0, 16), name: guestName || 'Anonymous' });

  // Lazily, as the other routes do: neither module is needed to check a lock.
  const webhookService = require('./webhookService');
  await webhookService.fire('selection.submitted', {
    event: webhookService.buildEventSubject(event),
    submission: {
      id: submission.id,
      kind: submission.kind,
      guest_name: guestName || null,
      count: submission.item_count,
      ...(isApproval ? { rejected_count: rejected || 0 } : {}),
      note: submission.note,
      submitted_at: submission.submitted_at,
    },
  });

  try {
    const { queueEmail } = require('./emailProcessor');
    const { getAbsoluteFrontendUrl } = require('../utils/frontendUrl');
    const base = await getAbsoluteFrontendUrl(null, { override: process.env.ADMIN_URL });
    // queueEmail writes scheduled_at as NULL: the mail goes out on the next
    // queue pass, and no recipient means nothing is queued.
    await queueEmail(event.id, event.admin_email, 'selection_submitted', {
      event_name: event.event_name,
      guest_name: guestName || '',
      item_count: String(submission.item_count),
      rejected_count: isApproval && rejected ? String(rejected) : '',
      note: submission.note || '',
      is_selection: isApproval ? '' : 'yes',
      is_approval: isApproval ? 'yes' : '',
      admin_link: `${base}/admin/events/${event.id}?tab=guests`,
    });
  } catch (error) {
    logger.warn('selection submission mail not queued', { eventId: event.id, error: error.message });
  }
}

module.exports = {
  feedbackName,
  FEEDBACK_NAME_PAGE,
  notifySubmitted,
  KINDS,
  NOTE_MAX_LENGTH,
  LOCKED_TYPES,
  kindLocking,
  withViewerLock,
  guestGone,
  lockFor,
  getState,
  submit,
  listForEvent,
  reopen,
  mergeGuests,
  anonymizeGuest,
};
