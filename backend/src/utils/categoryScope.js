const { db } = require('../database/db');

// Resolve a numeric category id within the scope of one event: it must belong
// to that event or be a global category (#500 / #525 — the same contract the
// public v1 upload route enforces). Returns undefined for an out-of-scope id,
// which every caller turns into a 400 rather than silently filing the photo
// under another event's category.
const findScopedCategory = (eventId, categoryId) => db('photo_categories')
  .where({ id: categoryId })
  .andWhere(function () {
    this.where({ event_id: eventId }).orWhere('is_global', true);
  })
  .first();

const outOfScopeCategoryError = (categoryId) => ({
  error: `Unknown or out-of-scope category_id ${categoryId}`
});

module.exports = { findScopedCategory, outOfScopeCategoryError };
