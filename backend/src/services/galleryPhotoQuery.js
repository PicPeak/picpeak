const { db } = require('../database/db');
const { formatBoolean } = require('../utils/dbCompat');
const { COLOR_LABELS, SHARED_COLOR_LABEL_IDENTITY } = require('../constants/colorLabels');
const { scopeToViewer } = require('./selectionSubmissions');
/** Apply the same own/shared feedback visibility before pagination and counts. */
function applyFeedbackFilter(query, { filter, event, identity, sharedColorMode, showFeedbackToGuests }) {
  if (!filter) return query;
  const tokens = new Set(String(filter).toLowerCase().split(',').map(x => x.trim()).filter(Boolean));
  if (tokens.size === 0 || tokens.has('all')) return query;
  if (tokens.has('saved') || tokens.has('favorite')) tokens.add('favorited');
  const feedback = type => db('photo_feedback').where({ event_id: event.id, feedback_type: type,
    is_hidden: formatBoolean(false) }).select('photo_id');
  const own = q => scopeToViewer(q, identity);
  return query.where(function () {
    this.whereRaw('1 = 0');
    for (const [token, type, column] of [['liked', 'like', 'like_count'], ['favorited', 'favorite', 'favorite_count'], ['rated', 'rating', 'average_rating'], ['commented', 'comment', null]]) {
      if (!tokens.has(token)) continue;
      this.orWhereIn('photos.id', own(feedback(type)));
      if (showFeedbackToGuests) {
        if (column) this.orWhere(`photos.${column}`, '>', 0);
        else this.orWhereIn('photos.id', feedback(type).where('is_approved', formatBoolean(true)));
      }
    }
    const colors = COLOR_LABELS.filter(color => tokens.has(`color:${color}`));
    if (colors.length) {
      const colorQuery = feedback('color_label').whereIn('color_label', colors);
      if (sharedColorMode) {
        this.orWhereIn('photos.id', colorQuery.where('guest_identifier', SHARED_COLOR_LABEL_IDENTITY));
      } else {
        this.orWhereIn('photos.id', own(colorQuery.clone()));
        if (showFeedbackToGuests) this.orWhereIn('photos.id', colorQuery.where(function () {
          this.whereNot('guest_identifier', SHARED_COLOR_LABEL_IDENTITY).orWhereNull('guest_identifier');
        }));
      }
    }
  });
}
module.exports = { applyFeedbackFilter };
