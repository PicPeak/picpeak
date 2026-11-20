'use strict';
// Event codes (issue 2495, migration 367): generate a new code, set one the
// admin chose, or remove it. Codes only resolve while the setting
// general_event_codes_enabled is on; generating and setting answer 409
// EVENT_CODES_DISABLED while it is off, removing works either way. Gated like the embed link (./embed.js). The public side is
// routes/publicEventCode.js.

const { db, logActivity } = require('../../database/db');
const { adminAuth } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permissions');
const { requireEventOwnership, scopeEventsQuery } = require('../../middleware/ownership');
const { errorResponse } = require('../../utils/routeHelpers');
const {
  normalizeAccessCode, isValidAccessCode, formatAccessCode, assignGeneratedAccessCode, setAccessCode, clearAccessCode,
  eventCodesEnabled,
} = require('../../services/eventAccessCode');

async function loadOwnedEvent(req) {
  // Ownership: requireEventOwnership already enforced it; kept as defence in
  // depth like the embed routes.
  return scopeEventsQuery(db('events').where('id', req.params.id), req.admin).first();
}

const codeState = (code) => ({ access_code: code || null, access_code_display: formatAccessCode(code) });
const codesDisabled = (res) => res.status(409).json({
  error: 'Event codes are switched off', code: 'EVENT_CODES_DISABLED',
});
const actor = (req) => ({ type: 'admin', id: req.admin.id, name: req.admin.username });

module.exports = (router) => {
  // A new generated code. The old one stops working at once.
  router.post('/:id/access-code/regenerate', adminAuth, requirePermission('events.edit'), requireEventOwnership, async (req, res) => {
    try {
      const event = await loadOwnedEvent(req);
      if (!event) return res.status(404).json({ error: 'Event not found' });
      if (!(await eventCodesEnabled())) return codesDisabled(res);
      const code = await assignGeneratedAccessCode(event.id);
      await logActivity('event_code_changed', { eventName: event.event_name, generated: true }, event.id, actor(req));
      res.json(codeState(code));
    } catch (error) {
      errorResponse(res, error, 500, 'Failed to generate the event code');
    }
  });

  // A code the admin chose: 6-12 characters of the code alphabet, `-` and
  // spaces ignored, stored uppercase. 409 when another gallery holds it.
  router.put('/:id/access-code', adminAuth, requirePermission('events.edit'), requireEventOwnership, async (req, res) => {
    try {
      const event = await loadOwnedEvent(req);
      if (!event) return res.status(404).json({ error: 'Event not found' });
      if (!(await eventCodesEnabled())) return codesDisabled(res);
      const code = normalizeAccessCode(req.body?.code);
      if (!isValidAccessCode(code)) {
        return res.status(400).json({
          error: 'The code must have 6 to 12 letters and digits, without 0, O, 1, I or L',
          code: 'INVALID_ACCESS_CODE',
        });
      }
      if (code !== event.access_code) {
        try {
          await setAccessCode(event.id, code);
        } catch (error) {
          if (error.code === 'ACCESS_CODE_TAKEN') return res.status(409).json({ error: error.message, code: error.code });
          throw error;
        }
        await logActivity('event_code_changed', { eventName: event.event_name, generated: false }, event.id, actor(req));
      }
      res.json(codeState(code));
    } catch (error) {
      errorResponse(res, error, 500, 'Failed to save the event code');
    }
  });

  // Remove the code: it stops working at once and the gallery has none.
  router.delete('/:id/access-code', adminAuth, requirePermission('events.edit'), requireEventOwnership, async (req, res) => {
    try {
      const event = await loadOwnedEvent(req);
      if (!event) return res.status(404).json({ error: 'Event not found' });
      if (event.access_code) {
        await clearAccessCode(event.id);
        await logActivity('event_code_changed', { eventName: event.event_name, removed: true }, event.id, actor(req));
      }
      res.json(codeState(null));
    } catch (error) {
      errorResponse(res, error, 500, 'Failed to remove the event code');
    }
  });
};
