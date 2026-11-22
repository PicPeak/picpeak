'use strict';
// Multilingual gallery texts (issue 2550, migration 373): the hand-written
// texts of a gallery's title, welcome message, category names and chapter
// markers in other languages. The mode and the languages are ordinary event
// columns, edited through PUT /:id. See ../../services/contentTranslations.js.

const { db, logActivity } = require('../../database/db');
const { adminAuth } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permissions');
const { requireEventOwnership, scopeEventsQuery } = require('../../middleware/ownership');
const { errorResponse } = require('../../utils/routeHelpers');
const translations = require('../../services/contentTranslations');

async function loadOwnedEvent(req) {
  // Ownership: requireEventOwnership already enforced it; kept as defence in
  // depth like the other event sub-routes.
  return scopeEventsQuery(db('events').where('id', req.params.id), req.admin).first();
}

async function stateOf(event) {
  return {
    ...translations.languageSettingsOf(event),
    languages: translations.TEXT_LANGUAGES,
    translations: await translations.translationRowsForEvent(event.id),
  };
}

module.exports = (router) => {
  router.get('/:id/translations', adminAuth, requirePermission('events.view'), requireEventOwnership, async (req, res) => {
    try {
      const event = await loadOwnedEvent(req);
      if (!event) return res.status(404).json({ error: 'Event not found' });
      res.json(await stateOf(event));
    } catch (error) {
      errorResponse(res, error, 500, 'Failed to load the gallery translations');
    }
  });

  // A batch of changes: { items: [{ entity_type, entity_id, field, language, text }] }.
  // An empty text removes that translation. All or nothing.
  router.put('/:id/translations', adminAuth, requirePermission('events.edit'), requireEventOwnership, async (req, res) => {
    try {
      const event = await loadOwnedEvent(req);
      if (!event) return res.status(404).json({ error: 'Event not found' });
      const items = await translations.saveTranslations(event.id, req.body && req.body.items);
      await logActivity('event_translations_updated', { eventName: event.event_name, changes: items.length }, event.id,
        { type: 'admin', id: req.admin.id, name: req.admin.username });
      res.json(await stateOf(event));
    } catch (error) {
      if (error instanceof translations.TranslationError) {
        return res.status(error.status).json({ error: error.message });
      }
      errorResponse(res, error, 500, 'Failed to save the gallery translations');
    }
  });
};
