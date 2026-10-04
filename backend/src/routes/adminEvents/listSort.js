/**
 * Ordering for the admin events list (GET /admin/events).
 *
 * The list was hard-ordered by `created_at desc` for everyone: the allowlist
 * existed but the admin UI never sent `sortBy`, so the only way to see the
 * galleries was newest-created first. That is the wrong axis for a back-filled
 * archive — import fifty past weddings in an afternoon and they all carry
 * today's `created_at`, ordered by whatever sequence they were typed in, while
 * the `event_date` column the table actually displays has no influence at all.
 *
 * Every column the table renders is sortable here. Two of them are not plain
 * columns and need an expression:
 *
 *   photo_count  a correlated subquery — the list computes photo counts in a
 *                second query AFTER pagination, so the count is not available
 *                to ORDER BY. Counting inline is the only way to order the
 *                page by it rather than re-ordering the 20 rows that happened
 *                to be fetched.
 *   status       a CASE that mirrors, branch for branch, the badge precedence
 *                in EventsListPage.getEventStatus. The rank has to be derived
 *                from the same precedence the row displays, or a row sorts
 *                into a group whose badge it does not carry.
 *
 * `capture_date` used to sit in the allowlist and is gone: it is a *photo*
 * sort keyword (photos.captured_at, see services/galleryQueryService) and
 * there is no such column on `events`, so `?sortBy=capture_date` resolved to
 * `order by events.capture_date` and threw. Unreachable only because nothing
 * sent it.
 */

const { formatBoolean, isPostgreSQL, sqliteTimestampMs } = require('../../utils/dbCompat');

/**
 * How each sortable key is turned into an ORDER BY.
 *
 *   plain     order by the column as stored
 *   ci        case-insensitive (lower()) — for names the admin reads as text
 *   nullable  nulls forced last in BOTH directions (see below)
 *   photos    correlated count subquery
 *   status    lifecycle rank, see STATUS_RANK
 */
const SORTABLE = {
  event_name: 'ci',
  // NOT NULL since the table was created (database/db.js), so no null arm.
  event_type: 'plain',
  // event_date and expires_at were both made nullable by migration 061, which
  // exists precisely so a portrait shoot can have neither.
  event_date: 'nullable',
  created_at: 'plain',
  // Added by migration 210 with no default. It is backfilled there and set on
  // create, so a null should not occur — but the engines disagree about where
  // one would land (SQLite ASC first, Postgres ASC last), so it is pinned.
  updated_at: 'nullable',
  expires_at: 'nullable',
  slug: 'plain',
  photo_count: 'photos',
  status: 'status',
};

const DEFAULT_SORT_BY = 'created_at';
const DEFAULT_SORT_ORDER = 'desc';

/**
 * Rank per displayed badge, mirroring getEventStatus precedence. Ascending
 * reads as "live first, done last", which is what "Active first" offers in
 * the column menu; descending is its mirror.
 */
const STATUS_RANK = {
  active: 0,
  expiring: 1,
  expired: 2,
  draft: 3,
  inactive: 4,
  archived: 5,
};

const EXPIRING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The keys a client may pass as `sortBy`. Exported for validation + tests. */
const SORTABLE_KEYS = Object.keys(SORTABLE);

/**
 * Normalises untrusted query input to a key/direction pair. Anything
 * unrecognised falls back to the historical default rather than erroring, so
 * a stale bookmark still renders a list.
 */
function resolveEventSort(sortBy, sortOrder) {
  return {
    sortBy: Object.prototype.hasOwnProperty.call(SORTABLE, sortBy) ? sortBy : DEFAULT_SORT_BY,
    sortOrder: sortOrder === 'asc' || sortOrder === 'desc' ? sortOrder : DEFAULT_SORT_ORDER,
  };
}

/**
 * Appends the ORDER BY for one sort key to a knex query on `events`.
 *
 * Call this AFTER cloning the query for the pagination count: the count does
 * not need the ordering, and the photo_count subquery would make it needlessly
 * expensive.
 *
 * `sortBy` and `sortOrder` are resolved through resolveEventSort first, so the
 * direction interpolated into the raw fragments below is always the literal
 * 'asc' or 'desc' — never caller-supplied text.
 */
function applyEventListSort(query, sortBy, sortOrder) {
  const { sortBy: key, sortOrder: dir } = resolveEventSort(sortBy, sortOrder);
  const kind = SORTABLE[key];

  if (kind === 'ci') {
    // Without lower() SQLite's BINARY collation sorts every capitalised name
    // ahead of every lowercase one, so "apfelhochzeit" lands after "Zwilling".
    // (lower() is ASCII-only on SQLite, so Ä still sorts after Z — a German
    // collation would need ICU, which is not a dependency here.)
    query = query.orderByRaw(`lower(??) ${dir}`, [key]);
  } else if (kind === 'nullable') {
    // Nulls last in both directions. A gallery with no date or no expiry is an
    // absence of information, not an extreme of it: bubbling fifty "N/A" rows
    // to the top of "oldest first" would bury the answer the sort was asked
    // for. Expressed as a leading 0/1 flag rather than `NULLS LAST`, which
    // SQLite only learned in 3.30 — and which the two engines default to
    // opposite ways without.
    query = query.orderByRaw('case when ?? is null then 1 else 0 end asc', [key]);
    if (key === 'expires_at' && !isPostgreSQL()) {
      // SQLite holds expires_at as ISO text or as epoch ms (the extend path
      // bound a Date), and orders every number below every text; sort the
      // value as a timestamp, like the status filter compares it.
      const ms = sqliteTimestampMs(key);
      query = query.orderByRaw(`${ms.sql} ${dir}`, ms.bindings);
    } else {
      query = query.orderBy(key, dir);
    }
  } else if (kind === 'photos') {
    query = query.orderByRaw(
      `(select count(*) from photos where photos.event_id = events.id) ${dir}`,
    );
  } else if (kind === 'status') {
    const now = new Date();
    const expiringUntil = new Date(now.getTime() + EXPIRING_WINDOW_MS);
    // PostgreSQL compares the timestamp column; SQLite reads the stored
    // shape (ISO text or epoch ms) as epoch ms, see sqliteTimestampMs.
    const expiry = isPostgreSQL()
      ? { sql: '??', bindings: ['expires_at'], now: now.toISOString(), until: expiringUntil.toISOString() }
      : { ...sqliteTimestampMs('expires_at'), now: now.getTime(), until: expiringUntil.getTime() };
    // Branch order is load-bearing: it is getEventStatus's precedence, where a
    // draft reads as a draft even once archived and an archived event never
    // reads as expired.
    query = query.orderByRaw(
      `case
         when ?? = ? then ${STATUS_RANK.draft}
         when ?? = ? then ${STATUS_RANK.archived}
         when ?? is null or ?? = ? then ${STATUS_RANK.inactive}
         when ?? is null then ${STATUS_RANK.active}
         when ${expiry.sql} <= ? then ${STATUS_RANK.expired}
         when ${expiry.sql} <= ? then ${STATUS_RANK.expiring}
         else ${STATUS_RANK.active}
       end ${dir}`,
      [
        'is_draft', formatBoolean(true),
        'is_archived', formatBoolean(true),
        'is_active', 'is_active', formatBoolean(false),
        'expires_at',
        ...expiry.bindings, expiry.now,
        ...expiry.bindings, expiry.until,
      ],
    );
  } else {
    query = query.orderBy(key, dir);
  }

  // Ties are the normal case, not the exception (#1172): a bulk import writes
  // hundreds of rows carrying the same created_at, and status collapses every
  // active gallery onto one rank. Without a tiebreaker the order within a tie
  // is whatever the engine returns, which reshuffles between page loads — and
  // under pagination that means a row can appear on two pages, or on none.
  return query.orderBy('id', 'desc');
}

module.exports = {
  applyEventListSort,
  resolveEventSort,
  SORTABLE_KEYS,
  STATUS_RANK,
  DEFAULT_SORT_BY,
  DEFAULT_SORT_ORDER,
};
