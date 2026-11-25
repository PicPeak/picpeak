/**
 * Is an event's own "watermark downloads" flag on, for serving a file? The
 * view route, the download rendition and photo sales share this test, so
 * they cannot disagree about the same row. The column reads as a boolean
 * (PostgreSQL) or 0/1 (SQLite); true, 1 and the string '1' all count as on,
 * the widest of the shapes those callers took. The photo list and the asset
 * policy still read the flag through parseBooleanInput, which also takes
 * 'true'; a column that only ever holds a boolean or 0/1 never reaches that
 * difference.
 * Kept free of requires so any module can load it cheaply, including
 * modules/photoSales/priceRules.
 */
function eventWatermarksDownloads(event) {
  const flag = event.watermark_downloads;
  return flag === true || flag === 1 || flag === '1';
}

module.exports = { eventWatermarksDownloads };
