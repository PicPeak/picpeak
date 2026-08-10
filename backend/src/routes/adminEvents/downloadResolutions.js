// Per-event download resolution overrides (#858). Same sub-router shape as
// ./slideshow.js — see ./index.js for the registration-order contract.
//
// All three fields are tri-state: explicit null = inherit the global
// (Settings → Downloads), matching show_watermark / show_qr. Changing the
// standard resolution invalidates this event's cached download-all zip,
// because that archive is built AT the standard resolution.

const { body, validationResult } = require('express-validator');
const { db, logActivity } = require('../../database/db');
const { formatBoolean } = require('../../utils/dbCompat');
const { adminAuth } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permissions');
const { errorResponse } = require('../../utils/routeHelpers');
const { parseBooleanInput } = require('../../utils/parsers');
const { requireEventOwnership } = require('../../middleware/ownership');
const {
  getDownloadGlobals,
  resolveEventDownloadPolicy,
  ORIGINAL,
} = require('../../utils/downloadResolutions');
const downloadZipService = require('../../services/downloadZipService');

async function loadOwnedEvent(req) {
  let q = db('events').where('id', req.params.id);
  if (req.admin.roleName === 'editor') {
    q = q.where('created_by', req.admin.id);
  }
  return q.first();
}

module.exports = (router) => {
  // Read the event's effective policy plus the raw overrides, so the admin UI
  // can show "inheriting 1500x1000" vs "overridden to Original".
  router.get('/:id/download-resolutions', adminAuth, requirePermission('events.view'), requireEventOwnership, async (req, res) => {
    try {
      const event = await loadOwnedEvent(req);
      if (!event) return res.status(404).json({ error: 'Event not found' });

      const globals = await getDownloadGlobals();
      const policy = await resolveEventDownloadPolicy(event);
      res.json({
        overrides: {
          download_standard_resolution: event.download_standard_resolution ?? null,
          download_resolution_picker_enabled: event.download_resolution_picker_enabled ?? null,
          download_allow_original: event.download_allow_original ?? null,
        },
        globals,
        effective: {
          standard: policy.standard,
          picker_enabled: policy.pickerEnabled,
          allow_original: policy.allowOriginal,
          choices: policy.choices,
        },
      });
    } catch (error) {
      errorResponse(res, error, 500, 'Failed to load download resolution settings');
    }
  });

  router.patch('/:id/download-resolutions', adminAuth, requirePermission('events.edit'), requireEventOwnership, [
    body('download_standard_resolution').optional({ nullable: true }),
    body('download_resolution_picker_enabled').optional({ nullable: true }),
    body('download_allow_original').optional({ nullable: true }),
  ], async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'Invalid download settings', details: errors.array() });
      }

      const event = await loadOwnedEvent(req);
      if (!event) return res.status(404).json({ error: 'Event not found' });

      const globals = await getDownloadGlobals();
      const updates = {};
      let standardChanged = false;

      if (req.body.download_standard_resolution !== undefined) {
        const raw = req.body.download_standard_resolution;
        if (raw === null) {
          updates.download_standard_resolution = null;
        } else {
          const v = String(raw);
          if (v !== ORIGINAL && !globals.resolutions.some((r) => r.id === v)) {
            return res.status(400).json({ error: `Unknown resolution "${v}"` });
          }
          updates.download_standard_resolution = v;
        }
        standardChanged = (event.download_standard_resolution ?? null)
          !== (updates.download_standard_resolution ?? null);
      }

      // events has no updated_at column — don't set it.
      if (req.body.download_resolution_picker_enabled !== undefined) {
        updates.download_resolution_picker_enabled = req.body.download_resolution_picker_enabled === null
          ? null
          : formatBoolean(parseBooleanInput(req.body.download_resolution_picker_enabled, false));
      }
      if (req.body.download_allow_original !== undefined) {
        updates.download_allow_original = req.body.download_allow_original === null
          ? null
          : formatBoolean(parseBooleanInput(req.body.download_allow_original, false));
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'No settings supplied' });
      }

      await db('events').where('id', event.id).update(updates);

      // Only the standard resolution changes what the cached archive contains.
      // Toggling the picker or the original allowance doesn't, so don't throw
      // away a valid zip for those.
      if (standardChanged) {
        downloadZipService.invalidate(event.id);
      }

      const fresh = await db('events').where('id', event.id).first();
      const policy = await resolveEventDownloadPolicy(fresh);

      await logActivity('event_download_resolutions_updated', {
        event_id: event.id, ...updates,
      }, null, { type: 'admin', id: req.admin.id, name: req.admin.username });

      res.json({
        message: 'Download resolution settings updated',
        zip_invalidated: standardChanged,
        effective: {
          standard: policy.standard,
          picker_enabled: policy.pickerEnabled,
          allow_original: policy.allowOriginal,
          choices: policy.choices,
        },
      });
    } catch (error) {
      errorResponse(res, error, 500, 'Failed to save download resolution settings');
    }
  });
};
