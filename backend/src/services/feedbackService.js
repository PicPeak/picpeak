const { db, logActivity } = require('../database/db');
const logger = require('../utils/logger');
const { formatBoolean } = require('../utils/dbCompat');
const { REACTION_EMOJIS } = require('../constants/reactions');
const { isValidColorLabel, SHARED_COLOR_LABEL_IDENTITY } = require('../constants/colorLabels');
const { resolveEventFeedbackDefaults, DEFAULT_KEYBIND_MODE, KEYBIND_MODES } = require('./feedbackDefaults');

// The camera-original name, for the feedback exports (#1224). Both exports
// used to carry only `photos.filename` — the sanitized stored name
// (`wedding-smith_individual_1755892345.jpg`), which matches nothing in a
// Lightroom catalog. Acting on client picks means finding the master file, so
// the export has to name it.
//
// `source_filename` first, NOT `original_filename` alone: the latter is
// overwritten the first time an edited render is uploaded over a proof, so an
// export taken after a Lightroom round-trip (#745) would name the render
// rather than the master and silently stop matching. `source_filename` is
// written once at ingest and survives a replace by design (migration 193),
// and its backfill already covers rows that predate it.
//
// Aliased to `original_filename` because that is what the sibling photo export
// calls this column, and it is the question the reader is asking ("what did
// the camera call it"). Left empty rather than falling back to the stored
// name: blank reads as "no match possible", where repeating the sanitized
// name invites a match attempt that cannot succeed.
//
// A SQL string rather than a prebuilt db.raw(): the raw is constructed per
// query, so this does not depend on `db` being connected at module load.
const CAMERA_NAME_SQL =
  'COALESCE(photos.source_filename, photos.original_filename) as original_filename';

// Every writable column on event_feedback_settings (#1030). The admin form
// posts its whole client-side state back, including UI-only keys that were
// never columns — `enable_rate_limiting`, `rate_limit_window_minutes`,
// `rate_limit_max_requests` — and spreading those into the UPDATE made knex
// throw, so the request 500'd and the "Enable feedback" toggle silently
// never persisted. Identity columns (id/event_id) and the timestamps stay
// server-managed. New columns MUST be added here.
const FEEDBACK_SETTINGS_COLUMNS = [
  'feedback_enabled',
  'allow_ratings',
  'allow_likes',
  'allow_comments',
  'allow_favorites',
  'allow_reactions',
  'allow_color_labels',
  'keybind_mode',
  'require_name_email',
  'moderate_comments',
  'require_moderation',
  'show_feedback_to_guests',
  'identity_mode',
  'max_favorites_per_guest',
  'max_likes_per_guest'
];

/**
 * Feedback types that store exactly ONE value per guest per photo, and the
 * column each keeps it in. Both share the toggle-off / switch semantics in
 * submitFeedback below.
 */
const SINGLE_VALUE_COLUMNS = {
  reaction: 'reaction',
  color_label: 'color_label',
};

/**
 * Is this write the identity-less shared colour tag (#1197)?
 *
 * Narrow on purpose. 'shared' is a mode for the colour tag, not for the event:
 * a like or a rating in a shared-mode gallery is still that guest's own, so
 * only feedback_type='color_label' takes the reserved slot. Everything else
 * falls through to the per-guest path unchanged.
 */
// Set once the settings table has been seen. Module scope on purpose: the
// answer is a property of the schema, not of a request.
let settingsTableKnownToExist = false;

function isSharedColorLabel(identityMode, feedbackType) {
  return identityMode === 'shared' && feedbackType === 'color_label';
}

/**
 * Narrow a colour-label query to the rows the event's current mode actually
 * uses (#1197).
 *
 * Switching modes is deliberately non-destructive: per-guest labels are kept
 * when an event moves to shared, and the shared row is kept when it moves
 * back. That leaves both sets in the table at once with only one of them live,
 * so every read has to say which it means. Without this the dormant set is
 * still counted, still tallied in the lightbox, still matches the admin colour
 * filter and can still decide the exported dominant colour — the labels would
 * be "hidden" only on the badge, which is not what the settings panel promises.
 *
 * The NULL arm matters: rows written before migration 078 carry no identifier
 * at all, and they are per-guest rows, so they belong to the non-shared set.
 */
function scopeColorLabelsToMode(query, identityMode, column = 'guest_identifier') {
  if (identityMode === 'shared') {
    return query.where(column, SHARED_COLOR_LABEL_IDENTITY);
  }
  return query.where(function () {
    this.whereNot(column, SHARED_COLOR_LABEL_IDENTITY).orWhereNull(column);
  });
}

function pickSettingsColumns(settings) {
  const picked = {};
  for (const column of FEEDBACK_SETTINGS_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(settings || {}, column)) {
      picked[column] = settings[column];
    }
  }
  return picked;
}

class FeedbackService {
  /**
   * Get feedback settings for an event
   */
  async getEventFeedbackSettings(eventId) {
    try {
      const settings = await db('event_feedback_settings')
        .where('event_id', eventId)
        .first();
      
      if (!settings) {
        // No row = feedback was never enabled for this event. The sub-toggles
        // still matter: they are the state the admin's feedback panel opens
        // with. Read them from the same global defaults the create routes use
        // (#1044) instead of a fourth hard-coded copy that drifts from them.
        const globals = await resolveEventFeedbackDefaults();
        return {
          event_id: eventId,
          feedback_enabled: false,
          ...globals,
          require_name_email: false,
          moderate_comments: true,
          show_feedback_to_guests: true,
          identity_mode: 'simple',
          max_favorites_per_guest: null,
          max_likes_per_guest: null,
        };
      }

      // Back-compat: rows created before migration 078 have NULL identity_mode.
      if (!settings.identity_mode) {
        settings.identity_mode = 'simple';
      }
      // Rows created before migration 180 have NULL keybind_mode. An
      // unrecognised value gets the same treatment — the lightbox switches on
      // this string and must never receive something it has no scheme for.
      if (!KEYBIND_MODES.includes(settings.keybind_mode)) {
        settings.keybind_mode = DEFAULT_KEYBIND_MODE;
      }
      // Per-guest caps (#655). NULL on existing rows = unlimited; the route
      // layer treats null/0/missing identically.
      settings.max_favorites_per_guest = settings.max_favorites_per_guest ?? null;
      settings.max_likes_per_guest = settings.max_likes_per_guest ?? null;
      return settings;
    } catch (error) {
      logger.error('Error getting feedback settings:', error);
      throw error;
    }
  }

  /**
   * Update feedback settings for an event
   */
  async updateEventFeedbackSettings(eventId, settings) {
    try {
      const existing = await db('event_feedback_settings')
        .where('event_id', eventId)
        .first();

      const writable = pickSettingsColumns(settings);

      // Changing identity_mode changes which colour labels are live, and
      // photos.color_label_count is denormalized — recomputed on a feedback
      // write, not on a settings write (#1197). Without this the tiles, the
      // admin grid and PhotoFilterBuilder.getSummary keep reporting the
      // previous mode's totals until each photo happens to receive another
      // mutation, which on a finished gallery is never.
      const modeChanged = Object.prototype.hasOwnProperty.call(writable, 'identity_mode')
        && existing
        && (existing.identity_mode || 'simple') !== (writable.identity_mode || 'simple');

      if (existing) {
        await db('event_feedback_settings')
          .where('event_id', eventId)
          .update({
            ...writable,
            updated_at: new Date().toISOString()
          });
      } else {
        await db('event_feedback_settings').insert({
          event_id: eventId,
          ...writable,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });
      }

      if (modeChanged) {
        await this.recountEventColorLabels(eventId, writable.identity_mode || 'simple');
      }

      await logActivity('feedback_settings_updated', writable, eventId);

      return this.getEventFeedbackSettings(eventId);
    } catch (error) {
      logger.error('Error updating feedback settings:', error);
      throw error;
    }
  }

  /**
   * Submit feedback for a photo
   */
  /**
   * Count how many existing feedback rows of `feedback_type` a single guest
   * has on a given event, matching the same guest-key shape submitFeedback's
   * duplicate-check uses (guest_id when present, fall back to
   * guest_identifier). Used for the per-guest favorite/like caps (#655).
   */
  async countGuestFeedback(eventId, feedbackType, guestId, guestIdentifier) {
    const query = db('photo_feedback')
      // Hidden rows do not count against the guest's cap (#1150). They are
      // absent everywhere else — the heart is empty, the tallies skip them,
      // and submitFeedback now treats one as room for a fresh row. Counting
      // them here would meet that fresh row with limit_reached and leave the
      // control dead until the guest un-likes something they can still see.
      .where({ event_id: eventId, feedback_type: feedbackType, is_hidden: false });
    if (guestId) {
      query.where('guest_id', guestId);
    } else {
      query.where('guest_identifier', guestIdentifier);
    }
    const result = await query.count('* as count').first();
    return parseInt(result?.count, 10) || 0;
  }

  /**
   * Write the photo's one shared colour tag (#1197).
   *
   * Last write wins, and re-sending the colour that is already there clears it
   * — the same toggle every other colour path uses, and the only way to remove
   * a tag without inventing a second control for it. Any guest can do either:
   * that is the mode, not a hole in it.
   *
   * The transaction plus the lock on the photo row is what makes "last write
   * wins" mean one value rather than two. Without it, two guests tapping
   * different colours in the same instant both read "no tag", both insert, and
   * the photo ends up carrying two shared tags at once — which is exactly the
   * per-guest tally this mode exists to get rid of. SQLite ignores forUpdate
   * but serialises writers anyway; on Postgres it is doing real work.
   *
   * No guest_name, guest_email or guest_id is stored. Attribution is gone by
   * design here — the tag is the photo's state, not a person's opinion — so
   * the admin feedback list shows a shared tag with no name against it.
   */
  async submitSharedColorLabel(photoId, eventId, colorLabel, { ip_address, user_agent } = {}) {
    const nowIso = () => new Date().toISOString();
    let outcome;

    await db.transaction(async (trx) => {
      await trx('photos').where({ id: photoId }).forUpdate().first();

      // Visible rows only, like every other single-value path (#1150): a
      // hidden tag is the admin's moderation record, and a guest writing over
      // it must create a fresh visible row rather than quietly unhide it. The
      // unhide path in moderateFeedback collapses the pair back to one.
      const sharedScope = () => trx('photo_feedback').where({
        photo_id: photoId,
        event_id: eventId,
        feedback_type: 'color_label',
        guest_identifier: SHARED_COLOR_LABEL_IDENTITY,
        is_hidden: false,
      });

      const existing = await sharedScope().first();

      if (existing && existing.color_label === colorLabel) {
        await sharedScope().delete();
        outcome = { removed: true, shared: true };
        return;
      }

      if (existing) {
        // Converge on one row, the same defence the per-guest path uses: if a
        // race ever did leave duplicates behind, the next tap collapses them.
        await sharedScope().whereNot('id', existing.id).delete();
        await trx('photo_feedback')
          .where('id', existing.id)
          .update({ color_label: colorLabel, updated_at: nowIso() });
        outcome = { id: existing.id, updated: true, shared: true };
        return;
      }

      const inserted = await trx('photo_feedback').insert({
        photo_id: photoId,
        event_id: eventId,
        feedback_type: 'color_label',
        color_label: colorLabel,
        guest_identifier: SHARED_COLOR_LABEL_IDENTITY,
        guest_id: null,
        guest_name: null,
        guest_email: null,
        ip_address,
        user_agent,
        is_approved: true,
        created_at: nowIso(),
        updated_at: nowIso(),
      }).returning('id');
      outcome = { id: inserted[0]?.id || inserted[0], created: true, shared: true };

      // Inside the transaction, while the photo row is still locked (#1197
      // review). Recomputing after the commit meant a failure there returned
      // 500 for a tag that HAD been written — so the client reverted its
      // swatch, the next tap on the same colour toggled the committed tag off
      // instead of setting it, and the counters stayed stale meanwhile. It
      // also let two concurrent writers race their aggregate updates.
      await this.updatePhotoFeedbackStats(photoId, trx);
    });

    return outcome;
  }

  /**
   * Rebuild photos.color_label_count for a whole event against the set the
   * given mode makes live (#1197).
   *
   * Two statements rather than updatePhotoFeedbackStats per photo: a mode
   * switch on a 5,000-photo gallery would otherwise be 5,000 aggregate queries
   * and 5,000 updates, for a counter that four of its five components cannot
   * have changed. Zero everything first, then write the photos that actually
   * carry a live label — usually a small fraction of the event.
   */
  async recountEventColorLabels(eventId, identityMode) {
    await db.transaction(async (trx) => {
      await trx('photos').where({ event_id: eventId }).update({ color_label_count: 0 });

      const rows = await scopeColorLabelsToMode(
        trx('photo_feedback')
          .where({ event_id: eventId, feedback_type: 'color_label', is_hidden: false }),
        identityMode,
      )
        .groupBy('photo_id')
        .select('photo_id')
        .count('id as count');

      for (const row of rows) {
        await trx('photos')
          .where({ id: row.photo_id })
          .update({ color_label_count: Number(row.count) || 0 });
      }
    });
  }

  /**
   * The identity mode of the event a photo belongs to (#1197).
   *
   * One small join rather than threading the mode through every caller of
   * updatePhotoFeedbackStats — including the duplicate-photo dedupe (#1162),
   * which recomputes totals from a background service with no request settings
   * in hand. Falls back to 'simple' for a photo whose event has no feedback
   * settings row, which is the same default getEventFeedbackSettings applies.
   */
  async getIdentityModeForPhoto(photoId, trx = db) {
    try {
      // Asked BEFORE the join, not recovered from afterwards (#1197 review).
      // On Postgres a failed statement aborts the whole transaction, so
      // catching the error and carrying on left the caller's trx poisoned:
      // the aggregate and update that follow would fail with "current
      // transaction is aborted", which is exactly the migration-time path the
      // fallback exists to support. A metadata check is safe to ask and does
      // not abort anything.
      //
      // Memoised once true because a table does not un-create itself, and this
      // sits on the feedback write path; a false answer is not cached, so a
      // migration that creates the table later is picked up.
      if (!settingsTableKnownToExist) {
        settingsTableKnownToExist = await trx.schema.hasTable('event_feedback_settings');
        if (!settingsTableKnownToExist) return 'simple';
      }
      const row = await trx('photos')
        .join('event_feedback_settings', 'photos.event_id', 'event_feedback_settings.event_id')
        .where('photos.id', photoId)
        .select('event_feedback_settings.identity_mode')
        .first();
      return row?.identity_mode || 'simple';
    } catch (error) {
      // updatePhotoFeedbackStats is called from MIGRATIONS as well as from the
      // request path — migration 186's duplicate-photo dedupe (#1162)
      // recomputes the survivor's totals — and a migration runs against a
      // half-built schema where event_feedback_settings need not exist yet.
      // Letting that throw took the whole stats update down with it, so the
      // reparented rows were never counted.
      //
      // 'simple' is the right answer in that situation rather than merely a
      // safe one: an install with no feedback settings table has no event in
      // shared mode, so the non-shared scope is exactly correct.
      logger.debug(`Identity mode lookup for photo ${photoId} fell back to 'simple': ${error.message}`);
      return 'simple';
    }
  }

  /**
   * The shared tag for a set of photos (#1197), as { [photoId]: colour }.
   *
   * One query for the whole page — the gallery list renders hundreds of tiles
   * and a per-photo lookup would be a query each.
   */
  async getSharedColorLabels(eventId, photoIds) {
    if (!photoIds || photoIds.length === 0) return {};
    const rows = await db('photo_feedback')
      .where({
        event_id: eventId,
        feedback_type: 'color_label',
        guest_identifier: SHARED_COLOR_LABEL_IDENTITY,
        is_hidden: false,
      })
      .whereIn('photo_id', photoIds)
      .whereNotNull('color_label')
      .select('photo_id', 'color_label');

    const byPhoto = {};
    rows.forEach((row) => { byPhoto[row.photo_id] = row.color_label; });
    return byPhoto;
  }

  async submitFeedback(photoId, eventId, feedbackData, guestIdentifier) {
    try {
      const { feedback_type, rating, comment_text, reaction, color_label, guest_name, guest_email, ip_address, user_agent, guest_id } = feedbackData;

      // Validate feedback type
      if (!['rating', 'like', 'comment', 'favorite', 'reaction', 'color_label'].includes(feedback_type)) {
        throw new Error('Invalid feedback type');
      }

      // Reactions come from a fixed curated set — anything else is rejected
      // (the route validator enforces this too; this is the last line).
      if (feedback_type === 'reaction' && !REACTION_EMOJIS.includes(reaction)) {
        throw new Error('Invalid reaction');
      }

      // Same contract for colour labels (#1044).
      if (feedback_type === 'color_label' && !isValidColorLabel(color_label)) {
        throw new Error('Invalid color label');
      }

      // The shared tag (#1197) leaves before any of the per-guest machinery
      // below runs: none of it applies to a row that belongs to the photo
      // rather than to a person.
      if (isSharedColorLabel(feedbackData.identity_mode, feedback_type)) {
        return await this.submitSharedColorLabel(photoId, eventId, color_label, {
          ip_address,
          user_agent,
        });
      }

      // Belt and braces: nothing but the branch above may write the reserved
      // slot. If some future caller ever passed it as a guest identifier, a
      // per-guest write would land on the photo's shared tag and every guest
      // in the gallery would see it as their own.
      if (guestIdentifier === SHARED_COLOR_LABEL_IDENTITY) {
        throw new Error('Reserved guest identifier');
      }

      // Rating 0 clears the guest's rating (#884). Only the explicit zero
      // sentinel (0, or "0" from callers that skip the route validator's
      // toInt) triggers the destructive path — malformed input (undefined,
      // NaN, null) must never delete an existing rating.
      const isRatingClear = feedback_type === 'rating' && (rating === 0 || rating === '0');

      // Check if similar feedback already exists (prevent duplicates).
      // When a per-person guest_id is present, scope the check to that guest
      // so two guests on the same device can independently like a photo.
      if (feedback_type !== 'comment') {
        const duplicateQuery = db('photo_feedback')
          .where({
            photo_id: photoId,
            event_id: eventId,
            feedback_type,
            // A hidden row is not there (#1150). Without this the guest saw an
            // empty heart — every read surface treats hidden as absent — and
            // clicking it found the hidden row and TOGGLED IT OFF, so the
            // click appeared to do nothing and it took two more to get back to
            // a filled heart. Skipping it makes the click create a fresh,
            // visible row, which is what the guest is asking for.
            is_hidden: false,
          });
        if (guest_id) {
          duplicateQuery.where('guest_id', guest_id);
        } else {
          duplicateQuery.where('guest_identifier', guestIdentifier);
        }
        const existing = await duplicateQuery.first();

        if (existing) {
          // Rating 0 clears the guest's rating (#884) — delete rather
          // than store 0, which would drag the photo's average down and
          // still count in total_ratings. Delete the full guest-scoped
          // set, not existing.id: the check-then-insert above can race
          // into duplicate rows (same defense as the reaction path), and
          // clearing must not leave a stray duplicate in the average.
          if (isRatingClear) {
            // Visible rows only (#1150). A hidden row can now sit alongside
            // the guest's replacement, and it is the admin's moderation
            // record — clearing a rating must not destroy it, or there is
            // nothing left to review or unhide.
            const clearScope = db('photo_feedback').where({
              photo_id: photoId,
              event_id: eventId,
              feedback_type: 'rating',
              is_hidden: false,
            });
            if (guest_id) clearScope.where('guest_id', guest_id);
            else clearScope.where('guest_identifier', guestIdentifier);
            await clearScope.delete();

            await this.updatePhotoFeedbackStats(photoId);
            return { removed: true };
          }

          if (feedback_type === 'rating' && rating !== existing.rating) {
            // Update existing rating
            await db('photo_feedback')
              .where('id', existing.id)
              .update({
                rating,
                updated_at: new Date()
              });

            await this.updatePhotoFeedbackStats(photoId);
            return { id: existing.id, updated: true };
          }

          // Single-value types — one reaction (#839) and one colour label
          // (#1044) per guest per photo, both changeable: submitting the
          // current value again toggles it off, a different one switches the
          // row. Shared so the two paths can't drift.
          //
          // Toggle/switch act on the full guest-scoped QUERY, not existing.id:
          // like the sibling like path, the check-then-insert above can race
          // into duplicate rows — operating on the set makes the next
          // interaction collapse them instead of leaving a phantom count.
          const singleValueColumn = SINGLE_VALUE_COLUMNS[feedback_type];
          if (singleValueColumn) {
            const submittedValue = feedback_type === 'reaction' ? reaction : color_label;
            // Visible rows only, same reason as the rating clear above: the
            // toggle-off and the duplicate collapse below both DELETE over
            // this scope, and a hidden original is the admin's record rather
            // than a racy duplicate of the guest's own.
            const singleValueScope = () => {
              const q = db('photo_feedback').where({
                photo_id: photoId,
                event_id: eventId,
                feedback_type,
                is_hidden: false,
              });
              if (guest_id) q.where('guest_id', guest_id);
              else q.where('guest_identifier', guestIdentifier);
              return q;
            };

            if (existing[singleValueColumn] === submittedValue) {
              await singleValueScope().delete();
              await this.updatePhotoFeedbackStats(photoId);
              return { removed: true };
            }
            // Converge to exactly one row: drop any racy duplicates, then
            // switch the surviving row's value.
            await singleValueScope().whereNot('id', existing.id).delete();
            await db('photo_feedback')
              .where('id', existing.id)
              .update({
                [singleValueColumn]: submittedValue,
                updated_at: new Date()
              });
            await this.updatePhotoFeedbackStats(photoId);
            return { id: existing.id, updated: true };
          }

          // For likes and favorites, toggle off if already exists.
          // Toggle-off always allowed — the cap below is on adds only, so a
          // guest at the limit can still free a slot by un-favoriting (#655).
          if (feedback_type === 'like' || feedback_type === 'favorite') {
            await db('photo_feedback')
              .where('id', existing.id)
              .delete();

            await this.updatePhotoFeedbackStats(photoId);
            return { removed: true };
          }

          return { id: existing.id, exists: true };
        }
      }

      // Rating 0 with no existing rating: nothing to clear — never insert a
      // 0-rating row (#884).
      if (isRatingClear) {
        return { removed: true };
      }

      // Per-guest cap enforcement (#655). Only checked on ADD; toggle-off is
      // always allowed. NULL or 0 stored in the column means "unlimited" —
      // the photographer hasn't opted in to a cap for this event.
      if (feedback_type === 'favorite' || feedback_type === 'like') {
        const settings = await this.getEventFeedbackSettings(eventId);
        const cap = feedback_type === 'favorite'
          ? settings.max_favorites_per_guest
          : settings.max_likes_per_guest;
        if (cap && cap > 0) {
          const currentCount = await this.countGuestFeedback(
            eventId, feedback_type, guest_id, guestIdentifier,
          );
          if (currentCount >= cap) {
            // Don't insert; surface a structured payload so the route layer
            // can return a 403 with `code` + `limit` + `current_count` and
            // the UI can render an explicit popup with the cap value.
            return {
              limit_reached: true,
              feedback_type,
              limit: cap,
              current_count: currentCount,
            };
          }
        }
      }

      // Insert new feedback
      const result = await db('photo_feedback').insert({
        photo_id: photoId,
        event_id: eventId,
        feedback_type,
        rating: feedback_type === 'rating' ? rating : null,
        comment_text: feedback_type === 'comment' ? comment_text : null,
        reaction: feedback_type === 'reaction' ? reaction : null,
        color_label: feedback_type === 'color_label' ? color_label : null,
        guest_name,
        guest_email,
        guest_identifier: guestIdentifier,
        guest_id: guest_id || null,
        ip_address,
        user_agent,
        // The submit route can force a comment into moderation (a
        // `moderate`/`high` word-filter hit) on an event whose
        // moderate_comments is off — this line used to ignore that entirely,
        // so those hits published straight away. A caller-supplied `false` is
        // honoured; nothing a caller passes can RELAX the event's setting.
        is_approved: feedbackData.is_approved === false
          ? false
          : (feedback_type !== 'comment' || !feedbackData.moderate_comments),
        created_at: new Date(),
        updated_at: new Date()
      }).returning('id');
      
      const id = result[0]?.id || result[0];
      
      // Update photo stats
      await this.updatePhotoFeedbackStats(photoId);
      
      // Log activity
      await logActivity(`photo_${feedback_type}`, { photo_id: photoId }, eventId);
      
      return { id, created: true };
    } catch (error) {
      logger.error('Error submitting feedback:', error);
      throw error;
    }
  }

  /**
   * Get feedback for a photo
   */
  async getPhotoFeedback(photoId, options = {}) {
    try {
      const query = db('photo_feedback')
        .where('photo_id', photoId);
      
      if (options.feedback_type) {
        query.where('feedback_type', options.feedback_type);
      }
      
      if (options.approved_only) {
        query.where('is_approved', true);
      }

      // Colour labels belong to one of two sets, and only one is live (#1197
      // review). Without this the raw feedback list handed back both — dormant
      // per-guest rows while the event is in shared mode, and the reserved
      // shared row after switching away — even though the settings panel
      // promises the other set is not shown. With sharing off it was worse:
      // the caller's own dormant row came back flagged is_mine.
      if (options.identity_mode) {
        query.where(function () {
          this.whereNot('feedback_type', 'color_label');
          this.orWhere(function () {
            this.where('feedback_type', 'color_label');
            scopeColorLabelsToMode(this, options.identity_mode);
          });
        });
      }
      
      if (!options.include_hidden) {
        query.where('is_hidden', false);
      }
      
      if (options.guest_identifier) {
        query.where('guest_identifier', options.guest_identifier);
      }
      
      const feedback = await query
        .orderBy('created_at', 'desc')
        .select('id', 'feedback_type', 'rating', 'comment_text', 'reaction', 'color_label', 'guest_name', 'created_at', 'is_approved', 'is_hidden');
      
      return feedback;
    } catch (error) {
      logger.error('Error getting photo feedback:', error);
      throw error;
    }
  }

  /**
   * Get feedback summary for an event
   */
  async getEventFeedbackSummary(eventId) {
    try {
      const photos = await db('photos')
        .where('event_id', eventId)
        .select('id', 'filename', 'feedback_count', 'like_count', 'average_rating', 'favorite_count', 'reaction_count', 'color_label_count')
        .orderBy('average_rating', 'desc')
        .orderBy('like_count', 'desc');
      
      const sharedColors = (await this.getEventFeedbackSettings(eventId)).identity_mode === 'shared';
      const totalStats = await db('photo_feedback')
        .where('event_id', eventId)
        // Hidden rows do not count, the same rule the photo counters above
        // already apply — without this the two halves of THIS response
        // disagreed, and a hidden row preserved beside its replacement (#1150)
        // is counted twice.
        .where('is_hidden', false)
        .select(
          db.raw('COUNT(DISTINCT CASE WHEN feedback_type = ? THEN guest_identifier END) as unique_raters', ['rating']),
          db.raw('COUNT(CASE WHEN feedback_type = ? THEN 1 END) as total_ratings', ['rating']),
          db.raw('COUNT(CASE WHEN feedback_type = ? THEN 1 END) as total_likes', ['like']),
          db.raw('COUNT(CASE WHEN feedback_type = ? THEN 1 END) as total_comments', ['comment']),
          db.raw('COUNT(CASE WHEN feedback_type = ? THEN 1 END) as total_favorites', ['favorite']),
          db.raw('COUNT(CASE WHEN feedback_type = ? THEN 1 END) as total_reactions', ['reaction']),
          // Scoped to the live colour-label set (#1197), like every other
          // colour read. Unscoped, a dormant set left behind by a mode switch
          // inflated total_feedback in the admin analytics and the guest
          // /feedback-summary while every other surface hid it.
          sharedColors
            ? db.raw(
              'COUNT(CASE WHEN feedback_type = ? AND guest_identifier = ? THEN 1 END) as total_color_labels',
              ['color_label', SHARED_COLOR_LABEL_IDENTITY],
            )
            : db.raw(
              'COUNT(CASE WHEN feedback_type = ? AND (guest_identifier IS NULL OR guest_identifier <> ?) THEN 1 END) as total_color_labels',
              ['color_label', SHARED_COLOR_LABEL_IDENTITY],
            )
        )
        .first();
      
      return {
        photos,
        stats: totalStats
      };
    } catch (error) {
      logger.error('Error getting feedback summary:', error);
      throw error;
    }
  }

  /**
   * Per-emoji reaction counts for one photo (#839): { '❤️': 3, '👏': 1 }.
   * Only visible rows count — hidden-by-moderator reactions disappear from
   * the tallies the same way hidden likes leave like_count.
   */
  async getPhotoReactionCounts(photoId) {
    try {
      const rows = await db('photo_feedback')
        .where({ photo_id: photoId, feedback_type: 'reaction' })
        .where('is_hidden', false)
        .groupBy('reaction')
        .select('reaction')
        .count('id as count');

      const counts = {};
      for (const row of rows) {
        if (row.reaction) counts[row.reaction] = Number(row.count) || 0;
      }
      return counts;
    } catch (error) {
      logger.error('Error getting photo reaction counts:', error);
      throw error;
    }
  }

  /**
   * Per-colour tallies for one photo (#1044) — the colour-label sibling of
   * getPhotoReactionCounts.
   */
  async getPhotoColorLabelCounts(photoId, identityMode = undefined) {
    try {
      // Resolved here rather than pushed onto every caller (#1197): the admin
      // grid, the XMP export and the lightbox all reach colour labels through
      // this helper and its event-wide sibling, so scoping them at the source
      // is what keeps a dormant label out of all three at once.
      const mode = identityMode ?? await this.getIdentityModeForPhoto(photoId);
      const rows = await scopeColorLabelsToMode(
        db('photo_feedback')
          .where({ photo_id: photoId, feedback_type: 'color_label' })
          .where('is_hidden', false),
        mode,
      )
        .groupBy('color_label')
        .select('color_label')
        .count('id as count');

      const counts = {};
      for (const row of rows) {
        if (row.color_label) counts[row.color_label] = Number(row.count) || 0;
      }
      return counts;
    } catch (error) {
      logger.error('Error getting photo color label counts:', error);
      throw error;
    }
  }

  /**
   * Per-colour tallies for every labelled photo in an event, keyed by photo
   * id (#1044). One grouped query — the admin grid needs this for a whole
   * page of photos at once, and the per-photo helper above would be N+1.
   *
   * @param {number} eventId
   * @param {number[]} [photoIds] - optional narrowing to the visible page
   * @returns {Promise<Object>} { [photoId]: { green: 2, red: 1 } }
   */
  async getEventColorLabelCounts(eventId, photoIds = null, identityMode = undefined) {
    try {
      const mode = identityMode ?? (await this.getEventFeedbackSettings(eventId)).identity_mode;
      const query = scopeColorLabelsToMode(
        db('photo_feedback')
          .where({ event_id: eventId, feedback_type: 'color_label' })
          .where('is_hidden', false),
        mode,
      )
        .groupBy('photo_id', 'color_label')
        .select('photo_id', 'color_label')
        .count('id as count');

      if (Array.isArray(photoIds)) {
        if (photoIds.length === 0) return {};
        query.whereIn('photo_id', photoIds);
      }

      const rows = await query;
      const byPhoto = {};
      for (const row of rows) {
        if (!row.color_label) continue;
        if (!byPhoto[row.photo_id]) byPhoto[row.photo_id] = {};
        byPhoto[row.photo_id][row.color_label] = Number(row.count) || 0;
      }
      return byPhoto;
    } catch (error) {
      logger.error('Error getting event color label counts:', error);
      return {};
    }
  }

  /**
   * Update photo feedback statistics.
   *
   * `trx` so a caller running outside the request path — the duplicate-photo
   * dedupe (#1162), which reparents feedback rows and must leave the
   * survivor's denormalized totals correct — can recompute on its own
   * connection.
   */
  async updatePhotoFeedbackStats(photoId, trx = db) {
    try {
      // Which colour labels are live for this photo's event (#1197). The other
      // four counters are identity-agnostic; only the colour tag has two
      // possible sets sitting in the table at once.
      const sharedColors = (await this.getIdentityModeForPhoto(photoId, trx)) === 'shared';
      const colorLabelCount = sharedColors
        ? trx.raw(
          'COUNT(CASE WHEN feedback_type = ? AND guest_identifier = ? THEN 1 END) as color_label_count',
          ['color_label', SHARED_COLOR_LABEL_IDENTITY],
        )
        : trx.raw(
          'COUNT(CASE WHEN feedback_type = ? AND (guest_identifier IS NULL OR guest_identifier <> ?) THEN 1 END) as color_label_count',
          ['color_label', SHARED_COLOR_LABEL_IDENTITY],
        );

      // Get aggregated stats
      const stats = await trx('photo_feedback')
        .where('photo_id', photoId)
        .where('is_hidden', false)
        .select(
          trx.raw('COUNT(CASE WHEN feedback_type = ? AND is_approved = ? THEN 1 END) as comment_count', ['comment', formatBoolean(true)]),
          trx.raw('COUNT(CASE WHEN feedback_type = ? THEN 1 END) as like_count', ['like']),
          trx.raw('COUNT(CASE WHEN feedback_type = ? THEN 1 END) as favorite_count', ['favorite']),
          trx.raw('COUNT(CASE WHEN feedback_type = ? THEN 1 END) as reaction_count', ['reaction']),
          colorLabelCount,
          trx.raw('AVG(CASE WHEN feedback_type = ? THEN rating END) as average_rating', ['rating']),
          // The shared tag is not a participant (#1197). It carries the
          // reserved identifier rather than a person's, so counting it here
          // added a phantom guest: a photo with one rating and a shared tag
          // reported two, and this column is exported as `rating_count` in the
          // CSV/JSON export (photoExportService.js) — so merely tagging a
          // photo inflated its rating count.
          trx.raw(
            'COUNT(DISTINCT CASE WHEN guest_identifier IS NULL OR guest_identifier <> ? '
            + 'THEN COALESCE(CAST(guest_id AS VARCHAR), guest_identifier) END) as feedback_count',
            [SHARED_COLOR_LABEL_IDENTITY],
          )
        )
        .first();

      // Update photo table
      await trx('photos')
        .where('id', photoId)
        .update({
          feedback_count: stats.feedback_count || 0,
          like_count: stats.like_count || 0,
          average_rating: stats.average_rating || 0,
          favorite_count: stats.favorite_count || 0,
          reaction_count: stats.reaction_count || 0,
          color_label_count: stats.color_label_count || 0
        });
    } catch (error) {
      logger.error('Error updating photo feedback stats:', error);
      throw error;
    }
  }

  /**
   * Moderate feedback (approve/hide)
   */
  async moderateFeedback(feedbackId, action, adminId) {
    try {
      const target = await db('photo_feedback').where('id', feedbackId).first();
      if (!target) {
        throw new Error('Feedback not found');
      }

      const updates = {
        updated_at: new Date()
      };
      
      if (action === 'approve') {
        updates.is_approved = true;
        updates.is_hidden = false;
      } else if (action === 'hide') {
        updates.is_hidden = true;
      } else if (action === 'reject') {
        updates.is_approved = false;
        updates.is_hidden = true;
      }
      
      const feedback = target;

      await db('photo_feedback')
        .where('id', feedbackId)
        .update(updates);

      // Unhiding can collide with a replacement (#1150). A hidden row reads as
      // absent, so the guest may well have re-added the same feedback in the
      // meantime; making the original visible again would leave TWO visible
      // rows for one guest on one photo — double-counted in the tallies, and
      // needing two toggles to clear because each one deletes a single row.
      //
      // Converge on the row the admin acted on, the same way the submit path
      // collapses racy duplicates. Comments are exempt: several from one guest
      // on one photo is normal.
      // Needs a stable identity to scope the collapse to ONE guest. With
      // neither id nor identifier the fallback degrades to
      // `guest_identifier IS NULL`, which is every identifier-less row on the
      // photo — other people's, deleted. Nothing to converge in that case, so
      // leave it alone.
      const collapseIdentity = feedback.guest_id || feedback.guest_identifier;
      if (updates.is_hidden === false && feedback.feedback_type !== 'comment' && collapseIdentity) {
        const superseded = db('photo_feedback')
          .where({
            photo_id: feedback.photo_id,
            event_id: feedback.event_id,
            feedback_type: feedback.feedback_type,
            is_hidden: false,
          })
          .whereNot('id', feedbackId);
        if (feedback.guest_id) superseded.where('guest_id', feedback.guest_id);
        else superseded.where('guest_identifier', feedback.guest_identifier);
        await superseded.delete();
      }
      
      // Update photo stats if visibility changed
      await this.updatePhotoFeedbackStats(feedback.photo_id);
      
      // Log moderation action
      await logActivity('feedback_moderated', {
        feedback_id: feedbackId,
        action,
        admin_id: adminId
      }, feedback.event_id);
      
      return true;
    } catch (error) {
      logger.error('Error moderating feedback:', error);
      throw error;
    }
  }

  /**
   * Delete feedback
   */
  async deleteFeedback(feedbackId, adminId) {
    try {
      const feedback = await db('photo_feedback')
        .where('id', feedbackId)
        .first();
      
      if (!feedback) {
        throw new Error('Feedback not found');
      }
      
      await db('photo_feedback')
        .where('id', feedbackId)
        .delete();
      
      // Update photo stats
      await this.updatePhotoFeedbackStats(feedback.photo_id);
      
      // Log deletion
      await logActivity('feedback_deleted', {
        feedback_id: feedbackId,
        feedback_type: feedback.feedback_type,
        admin_id: adminId
      }, feedback.event_id);
      
      return true;
    } catch (error) {
      logger.error('Error deleting feedback:', error);
      throw error;
    }
  }

  /**
   * Get feedback requiring moderation
   */
  async getPendingModeration(eventId = null, ownedEventIds = null) {
    try {
      let query = db('photo_feedback')
        .join('photos', 'photo_feedback.photo_id', 'photos.id')
        .join('events', 'photo_feedback.event_id', 'events.id')
        .where('photo_feedback.is_approved', false)
        .where('photo_feedback.is_hidden', false)
        .where('photo_feedback.feedback_type', 'comment');

      if (eventId) {
        query = query.where('photo_feedback.event_id', eventId);
      } else if (Array.isArray(ownedEventIds)) {
        // Scope to the caller's owned events (GHSA-3335) — an empty set
        // matches nothing, so a restricted admin sees only their own.
        query = query.whereIn('photo_feedback.event_id', ownedEventIds.length ? ownedEventIds : [-1]);
      }
      
      const pending = await query
        .select(
          'photo_feedback.*',
          'photos.filename as photo_filename',
          'events.event_name'
        )
        .orderBy('photo_feedback.created_at', 'desc');
      
      return pending;
    } catch (error) {
      logger.error('Error getting pending moderation:', error);
      throw error;
    }
  }

  /**
   * Export feedback data for an event — long-form (one row per individual
   * feedback action: favourite, like, rating, or comment). Backward-compatible
   * with archives and any external integrations that consume the existing CSV.
   */
  async exportEventFeedback(eventId) {
    try {
      const feedback = await db('photo_feedback')
        .join('photos', 'photo_feedback.photo_id', 'photos.id')
        .where('photo_feedback.event_id', eventId)
        .select(
          'photos.filename',
          db.raw(CAMERA_NAME_SQL),
          'photo_feedback.feedback_type',
          'photo_feedback.rating',
          'photo_feedback.comment_text',
          'photo_feedback.reaction',
          'photo_feedback.color_label',
          'photo_feedback.guest_name',
          'photo_feedback.guest_email',
          'photo_feedback.created_at'
        )
        .orderBy('photos.filename')
        .orderBy('photo_feedback.created_at');

      return feedback;
    } catch (error) {
      logger.error('Error exporting feedback:', error);
      throw error;
    }
  }

  /**
   * Export feedback data for an event — pivoted (one row per
   * (filename, guest_identifier) pair, columns: is_favorited, is_liked,
   * star_rating, comment, latest_at). Useful for spreadsheet pivot tables
   * and per-guest engagement scans. Hidden-by-moderator rows are excluded
   * because the pivot represents "what the guest currently sees / what we
   * want to surface" rather than the raw event log.
   *
   * Returns the same shape regardless of database driver — pivot is built
   * in JS so Postgres / SQLite behave identically. Ported from
   * 8digit/picpeak@ed7943b (#640 part #6).
   */
  async exportEventFeedbackPivoted(eventId) {
    try {
      const rows = await db('photo_feedback')
        .join('photos', 'photo_feedback.photo_id', 'photos.id')
        .where('photo_feedback.event_id', eventId)
        .where('photo_feedback.is_hidden', false)
        .select(
          'photos.filename',
          db.raw(CAMERA_NAME_SQL),
          'photo_feedback.feedback_type',
          'photo_feedback.rating',
          'photo_feedback.comment_text',
          'photo_feedback.reaction',
          'photo_feedback.color_label',
          'photo_feedback.guest_name',
          'photo_feedback.guest_email',
          'photo_feedback.guest_identifier',
          'photo_feedback.created_at'
        )
        .orderBy('photos.filename')
        .orderBy('photo_feedback.guest_identifier');

      const byKey = new Map();
      for (const row of rows) {
        // Key needs both the photo and the guest. Anonymous feedback (no
        // identifier) gets a synthetic key per row so two anonymous guests'
        // actions on the same photo don't collapse together.
        const guestKey = row.guest_identifier || `anon-${row.created_at}`;
        const key = `${row.filename}::${guestKey}`;
        let entry = byKey.get(key);
        if (!entry) {
          entry = {
            filename: row.filename,
            original_filename: row.original_filename || '',
            guest_name: row.guest_name || '',
            guest_email: row.guest_email || '',
            is_favorited: false,
            is_liked: false,
            star_rating: '',
            comment: '',
            reaction: '',
            color_label: '',
            latest_at: row.created_at,
          };
          byKey.set(key, entry);
        }
        // Prefer non-empty contact fields if any row supplied them.
        if (!entry.guest_name && row.guest_name) entry.guest_name = row.guest_name;
        if (!entry.guest_email && row.guest_email) entry.guest_email = row.guest_email;

        switch (row.feedback_type) {
        case 'favorite':
          entry.is_favorited = true;
          break;
        case 'like':
          entry.is_liked = true;
          break;
        case 'rating':
          if (row.rating != null) entry.star_rating = row.rating;
          break;
        case 'comment':
          if (row.comment_text) {
            // Most recent comment wins. Older comments from the same guest
            // on the same photo are dropped — the export is "current state",
            // not the comment history.
            entry.comment = row.comment_text;
          }
          break;
        case 'reaction':
          if (row.reaction) entry.reaction = row.reaction;
          break;
        case 'color_label':
          if (row.color_label) entry.color_label = row.color_label;
          break;
        default:
          // Unknown feedback type — ignore so a future type doesn't break the export.
          break;
        }
        // Track the latest action timestamp across all feedback types.
        if (row.created_at && entry.latest_at && row.created_at > entry.latest_at) {
          entry.latest_at = row.created_at;
        }
      }

      return Array.from(byKey.values());
    } catch (error) {
      logger.error('Error exporting feedback (pivoted):', error);
      throw error;
    }
  }

  /**
   * Get filtered photos based on feedback criteria
   * @param {number} eventId - Event ID
   * @param {string} guestIdentifier - Guest identifier
   * @param {object} filters - Filter criteria
   * @param {boolean} filters.liked - Include liked photos
   * @param {boolean} filters.favorited - Include favorited photos
   * @param {string} filters.operator - 'AND' or 'OR' for multiple filters
   * @returns {Promise<number[]>} Array of photo IDs that match criteria
   */
  async getFilteredPhotos(eventId, guestIdentifier, filters = {}) {
    try {
      const { liked, favorited, operator = 'OR' } = filters;
      
      // If no filters specified, return all photos
      if (!liked && !favorited) {
        const allPhotos = await db('photos')
          .where('event_id', eventId)
          .select('id');
        return allPhotos.map(p => p.id);
      }
      
      // Build query based on filters
      let query = db('photo_feedback')
        .where('event_id', eventId)
        .where('guest_identifier', guestIdentifier)
        .where('is_hidden', false);
      
      // Apply filter logic
      if (operator === 'AND' && liked && favorited) {
        // For AND operation, we need photos that have both types of feedback
        const likedPhotos = await db('photo_feedback')
          .where('event_id', eventId)
          .where('guest_identifier', guestIdentifier)
          .where('feedback_type', 'like')
          .where('is_hidden', false)
          .select('photo_id');
        
        const favoritedPhotos = await db('photo_feedback')
          .where('event_id', eventId)
          .where('guest_identifier', guestIdentifier)
          .where('feedback_type', 'favorite')
          .where('is_hidden', false)
          .select('photo_id');
        
        const likedIds = new Set(likedPhotos.map(p => p.photo_id));
        const favoritedIds = new Set(favoritedPhotos.map(p => p.photo_id));
        
        // Return intersection of both sets
        return Array.from(likedIds).filter(id => favoritedIds.has(id));
      } else {
        // OR operation or single filter
        const feedbackTypes = [];
        if (liked) feedbackTypes.push('like');
        if (favorited) feedbackTypes.push('favorite');
        
        query.whereIn('feedback_type', feedbackTypes);
      }
      
      const filteredPhotos = await query
        .distinct('photo_id')
        .select('photo_id');
      
      return filteredPhotos.map(p => p.photo_id);
    } catch (error) {
      logger.error('Error getting filtered photos:', error);
      throw error;
    }
  }

  /**
   * Anonymize feedback belonging to a guest — sets guest_id to NULL on all
   * their feedback rows and clears guest_name/guest_email for privacy, then
   * recomputes denormalized photo counts on affected photos.
   *
   * Used by self-service "forget me" and admin guest deletion.
   */
  async anonymizeGuestFeedback(guestId) {
    try {
      const affected = await db('photo_feedback')
        .where('guest_id', guestId)
        .select('photo_id');
      const photoIds = [...new Set(affected.map((r) => r.photo_id))];

      await db('photo_feedback')
        .where('guest_id', guestId)
        .update({
          guest_id: null,
          guest_name: null,
          guest_email: null,
          updated_at: new Date(),
        });

      for (const pid of photoIds) {
        await this.updatePhotoFeedbackStats(pid);
      }

      return { anonymized: affected.length, photos: photoIds.length };
    } catch (error) {
      logger.error('Error anonymizing guest feedback:', error);
      throw error;
    }
  }

  /**
   * Merge feedback rows from sourceGuestIds into keepGuestId. Used by admin
   * guest merge and email-based identity recovery when a user re-registers.
   * Recomputes denormalized counts on affected photos.
   */
  async mergeGuestFeedback(keepGuestId, sourceGuestIds) {
    try {
      const sources = (sourceGuestIds || []).filter((id) => id && id !== keepGuestId);
      if (sources.length === 0) {
        return { merged: 0, photos: 0 };
      }

      const affected = await db('photo_feedback')
        .whereIn('guest_id', sources)
        .select('photo_id');
      const photoIds = [...new Set(affected.map((r) => r.photo_id))];

      await db('photo_feedback')
        .whereIn('guest_id', sources)
        .update({
          guest_id: keepGuestId,
          updated_at: new Date(),
        });

      for (const pid of photoIds) {
        await this.updatePhotoFeedbackStats(pid);
      }

      return { merged: affected.length, photos: photoIds.length };
    } catch (error) {
      logger.error('Error merging guest feedback:', error);
      throw error;
    }
  }
}

module.exports = new FeedbackService();