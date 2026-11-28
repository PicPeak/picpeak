// One sortable key, 'YYYY-MM-DD HH:MM:SS.mmm', out of either SQLite shape.
// The milliseconds stay ('.000' for a text value without any), so two shots a
// fraction of a second apart are not a tie for the name tie-break to reorder
// (issue 2617). Both columns hold ISO text from some writers and knex's
// space-separated shape from others, so text loses its 'T' in either.
const epochKey = (column) => `strftime('%Y-%m-%d %H:%M:%f', ${column} / 1000.0, 'unixepoch')`;
const textKey = (column) => `replace(replace(substr(${column}, 1, 19), 'T', ' '), 'Z', '')`
  + ` || CASE WHEN substr(${column}, 20, 1) = '.' THEN substr(${column}, 20, 4) ELSE '.000' END`;

/**
 * ORDER BY expression for "capture date, falling back to uploaded_at when the
 * photo carries none". Shared by the guest gallery and the admin photo list.
 *
 * On SQLite that fallback cannot be a plain COALESCE, because the two
 * columns do not hold one type. photos.captured_at ends up carrying three
 * different storage classes:
 *
 *   integer  managed uploads — photoProcessor.js:488 writes a Date, which
 *            the sqlite3 binding stores as epoch milliseconds
 *   text     external imports and the backfill, which write ISO-8601
 *            ('2026-06-03T01:15:00.000Z') per the CLAUDE.md rule that
 *            Dates must not be handed to the binding in tests
 *   null     no capture date, so the sort falls through to uploaded_at —
 *            usually text in knex's 'YYYY-MM-DD HH:MM:SS' default shape,
 *            but epoch milliseconds on rows written by a legacy archive
 *            restore (see __tests__/integration/sqliteEpochTimestamps.js),
 *            so that column needs the same two branches
 *
 * SQLite orders INTEGER before TEXT unconditionally, so every managed
 * photo carrying EXIF sorted ahead of every photo that did not, whatever
 * the actual dates — a 2027 capture landing before a 2020 one. Among the
 * text values the 'T' separator (0x54) also outranks the space (0x20), so
 * a same-day ISO 01:15 sorted after a fallback 23:00.
 *
 * Normalising in the ORDER BY rather than rewriting the column: the data
 * fix would have to touch every existing row and every writer, which is a
 * much heavier change than the sort it is meant to correct. The cost here
 * is that this sort stops using idx_photos_captured_at on SQLite — an
 * acceptable trade on the fallback engine, where the alternative is an
 * index-assisted wrong answer.
 *
 * Postgres is untouched: captured_at is a real timestamp there, so
 * COALESCE already compares correctly.
 *
 * @param {string} client  knex client name (db.client.config.client)
 */
const captureDateOrderSql = (client) => (client === 'pg'
  ? 'COALESCE(photos.captured_at, photos.uploaded_at)'
  : `CASE
            WHEN typeof(photos.captured_at) IN ('integer', 'real') THEN ${epochKey('photos.captured_at')}
            WHEN photos.captured_at IS NOT NULL THEN ${textKey('photos.captured_at')}
            WHEN typeof(photos.uploaded_at) IN ('integer', 'real') THEN ${epochKey('photos.uploaded_at')}
            ELSE ${textKey('photos.uploaded_at')}
          END`);

/**
 * ORDER BY expression for a tie on the capture date: the camera's file name.
 * A burst shares one EXIF second and its files are numbered in shot order,
 * which upload order (photos.id, the last key) is not. Shared by the guest
 * gallery and the admin photo list; the browser's capture-date comparator
 * (frontend useGalleryFiltering) sorts the loaded gallery by the same rule.
 *
 * The stored name stands in where there is no original one: external imports
 * keep the camera name in filename, and '' counts as none because the gallery
 * API reports it to the browser as null.
 *
 * Compared byte by byte, so every side can agree: BINARY is SQLite's default,
 * and PostgreSQL is told so, since its database collation decides otherwise
 * (a glibc or ICU locale folds case; the alpine image happens to be bytewise).
 *
 * Known limit: not a natural sort. An unpadded counter (IMG_10 before IMG_3)
 * and a counter rolling over inside a burst (9999, then 0001) order wrong.
 *
 * @param {string} client  knex client name (db.client.config.client)
 */
const captureNameTieBreakSql = (client) => (
  `COALESCE(NULLIF(photos.original_filename, ''), photos.filename)${client === 'pg' ? ' COLLATE "C"' : ''}`);

module.exports = { captureDateOrderSql, captureNameTieBreakSql };
