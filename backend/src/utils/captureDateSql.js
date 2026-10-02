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
            WHEN typeof(photos.captured_at) IN ('integer', 'real') THEN datetime(photos.captured_at / 1000, 'unixepoch')
            WHEN photos.captured_at IS NOT NULL THEN replace(replace(substr(photos.captured_at, 1, 19), 'T', ' '), 'Z', '')
            WHEN typeof(photos.uploaded_at) IN ('integer', 'real') THEN datetime(photos.uploaded_at / 1000, 'unixepoch')
            ELSE substr(photos.uploaded_at, 1, 19)
          END`);

module.exports = { captureDateOrderSql };
