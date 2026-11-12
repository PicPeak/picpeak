'use strict';
const MiB = 1024 * 1024;
const MAX_SOURCE_BYTES = 50 * MiB;
const MAX_ORDER_SOURCE_BYTES = 200 * MiB;
const MAX_IMAGE_BYTES = 256 * MiB;
const MAX_ORDER_ARTWORK_BYTES = 1024 * MiB;
const PACK_OVERHEAD_BYTES = 8 * MiB;
const MAX_PACK_BYTES = MAX_ORDER_ARTWORK_BYTES + PACK_OVERHEAD_BYTES;
const MAX_SHEET_BYTES = 8 * MiB;
const MAX_PENDING_BYTES = 8 * 1024 * MiB;
const MAX_CUSTOMER_PENDING_BYTES = 3 * 1024 * MiB;
const MAX_RESERVATION_BYTES = MAX_ORDER_SOURCE_BYTES + MAX_ORDER_ARTWORK_BYTES + MAX_PACK_BYTES + MAX_SHEET_BYTES;
const QUOTE_TTL_MS = 30 * 60e3;

// This reserves space, not a promise about encoder compression. Actual bytes
// must fit the allocation before a quotation becomes confirmable.
function imageAllowance(item) {
  return Math.min(MAX_IMAGE_BYTES, Math.ceil(item.profile.artwork.widthPx * item.profile.artwork.heightPx * 4.5) + MiB);
}
function preparationBudget(items, sourceBytes) {
  const artworkBytes = Math.min(MAX_ORDER_ARTWORK_BYTES, items.reduce((sum, item) => sum + imageAllowance(item), 0));
  const packBytes = artworkBytes + PACK_OVERHEAD_BYTES;
  return { sourceBytes, artworkBytes, packBytes, sheetBytes: MAX_SHEET_BYTES,
    totalBytes: sourceBytes + artworkBytes + packBytes + MAX_SHEET_BYTES };
}
function budgetOf(snapshot) {
  const budget = snapshot?.preparationBudget;
  const fields = { sourceBytes: MAX_ORDER_SOURCE_BYTES, artworkBytes: MAX_ORDER_ARTWORK_BYTES, packBytes: MAX_PACK_BYTES, sheetBytes: MAX_SHEET_BYTES };
  return budget && Object.entries(fields).every(([key, max]) => Number.isSafeInteger(budget[key]) && budget[key] >= 0 && budget[key] <= max)
    && Object.keys(fields).reduce((sum, key) => sum + budget[key], 0) === budget.totalBytes
    && budget.totalBytes > 0 && budget.totalBytes <= MAX_RESERVATION_BYTES
    ? budget : { sourceBytes: MAX_ORDER_SOURCE_BYTES, artworkBytes: MAX_ORDER_ARTWORK_BYTES,
      packBytes: MAX_PACK_BYTES, sheetBytes: MAX_SHEET_BYTES, totalBytes: MAX_RESERVATION_BYTES };
}
module.exports = { MiB, MAX_SOURCE_BYTES, MAX_ORDER_SOURCE_BYTES, MAX_IMAGE_BYTES, MAX_ORDER_ARTWORK_BYTES,
  MAX_PACK_BYTES, MAX_SHEET_BYTES, MAX_PENDING_BYTES, MAX_CUSTOMER_PENDING_BYTES, MAX_RESERVATION_BYTES,
  QUOTE_TTL_MS, imageAllowance, preparationBudget, budgetOf };
