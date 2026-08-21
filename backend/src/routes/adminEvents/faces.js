// Per-event face recognition — "People in this gallery" (#1074). Same
// sub-router shape as ./downloadResolutions.js — see ./index.js for the
// registration-order contract.
//
// Every route here is gated on the `faces` feature flag as well as the usual
// auth/ownership chain. The frontend hides these surfaces when the flag is
// off, but a direct API call must be refused too — this feature touches
// biometric data, so "the UI doesn't show it" is not a control.

const { body, validationResult } = require('express-validator');
const { db, logActivity } = require('../../database/db');
const { adminAuth } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permissions');
const { requireFeatureFlag } = require('../../middleware/requireFeatureFlag');
const { requireEventOwnership } = require('../../middleware/ownership');
const { errorResponse } = require('../../utils/routeHelpers');
const { parseBooleanInput } = require('../../utils/parsers');
const logger = require('../../utils/logger');

const faceSettings = require('../../services/faceSettings');
const faceProcessor = require('../../services/faceProcessor');
const faceClustering = require('../../services/faceClustering');
const facePeopleService = require('../../services/facePeopleService');
const faceClient = require('../../services/faceClient');

const requireFaces = requireFeatureFlag('faces', 'FACES_DISABLED');

/** Cap on one person's face list. Surfaced so the UI can say when it bites. */
const PERSON_FACES_LIMIT = 500;

/**
 * Every face of one person, newest-confidence first, with the ORIGINAL photo
 * dimensions the bbox was measured against.
 *
 * Exported so a test can assert the shape of the SQL this actually emits. It
 * has to stay TABLE-QUALIFIED: `photos` also has an event_id, so the bare form
 * became ambiguous the moment the join was added — Postgres refuses it
 * ("column reference event_id is ambiguous") and the endpoint 500s, which took
 * the Split dialog down with it on every PG install. SQLite resolves the
 * ambiguity silently, which is why the suite stayed green and it shipped.
 */
function buildPersonFacesQuery(dbi, eventId, personId) {
  return dbi('photo_faces')
    .where({
      'photo_faces.event_id': eventId,
      'photo_faces.person_id': personId,
    })
    .orderBy('det_score', 'desc')
    .limit(PERSON_FACES_LIMIT)
    .join('photos', 'photos.id', 'photo_faces.photo_id')
    .select(
      'photo_faces.id', 'photo_faces.photo_id',
      'photo_faces.bbox_x', 'photo_faces.bbox_y',
      'photo_faces.bbox_w', 'photo_faces.bbox_h',
      'photo_faces.det_score', 'photo_faces.blur',
      // Needed to crop the box — it is in original-image pixels.
      'photos.width as photo_width', 'photos.height as photo_height'
    );
}


async function loadOwnedEvent(req) {
  let q = db('events').where('id', req.params.id);
  if (req.admin.roleName === 'editor') {
    q = q.where('created_by', req.admin.id);
  }
  return q.first();
}

module.exports = (router) => {
  /**
   * Sidecar connection test for the global settings panel.
   *
   * Registered FIRST because it is the only literal-prefix route in this
   * module — see ./index.js on why registration order is load-bearing. It
   * does not currently collide with '/:id/faces' (the second segment differs)
   * but relying on that would be one refactor away from a silent 404.
   */
  router.get('/faces/health', adminAuth, requirePermission('events.view'), requireFaces, async (req, res) => {
    try {
      const result = await faceClient.checkHealth();
      res.json({ url: faceSettings.getSidecarUrl(), ...result });
    } catch (error) {
      errorResponse(res, error, 500, 'Failed to check sidecar health');
    }
  });

  /**
   * Settings + scan status for the Event → Settings → People panel.
   */
  router.get('/:id/faces', adminAuth, requirePermission('events.view'), requireFaces, requireEventOwnership,
    async (req, res) => {
      try {
        const event = await loadOwnedEvent(req);
        if (!event) return res.status(404).json({ error: 'Event not found' });

        const status = await facePeopleService.getScanStatus(event.id);
        res.json({
          enabled: event.face_recognition_enabled === true || event.face_recognition_enabled === 1,
          visible_to_guests: faceSettings.areFacesVisibleToGuests(event),
          last_scan_at: event.faces_last_scan_at || null,
          status,
        });
      } catch (error) {
        errorResponse(res, error, 500, 'Failed to load face settings');
      }
    });

  /**
   * Flip the two per-event toggles.
   *
   * Enabling detection backfills existing photos. Disabling it stops there —
   * it does NOT delete anything, because "stop scanning" and "destroy the
   * clusters I already named" are different intentions and the destructive
   * one gets its own explicit endpoint.
   */
  router.patch('/:id/faces',
    adminAuth,
    requirePermission('events.edit'),
    requireFaces,
    requireEventOwnership,
    [
      body('enabled').optional().isBoolean(),
      body('visible_to_guests').optional().isBoolean(),
    ],
    async (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      try {
        const event = await loadOwnedEvent(req);
        if (!event) return res.status(404).json({ error: 'Event not found' });

        const update = {};
        const wasEnabled = event.face_recognition_enabled === true || event.face_recognition_enabled === 1;
        let nowEnabled = wasEnabled;

        if (req.body.enabled !== undefined) {
          nowEnabled = parseBooleanInput(req.body.enabled, false);
          update.face_recognition_enabled = nowEnabled;
        }
        if (req.body.visible_to_guests !== undefined) {
          update.faces_visible_to_guests = parseBooleanInput(req.body.visible_to_guests, true);
        }
        if (!Object.keys(update).length) {
          return res.status(400).json({ error: 'Nothing to update' });
        }

        await db('events').where({ id: event.id }).update(update);

        let queued = 0;
        if (!wasEnabled && nowEnabled) {
          queued = await faceProcessor.enqueueEvent(event.id, { onlyUnscanned: true });
          await db('events').where({ id: event.id })
            .update({ faces_last_scan_at: new Date().toISOString() });
        }

        await logActivity('event_faces_updated', {
          actorType: 'admin',
          actorId: req.admin.id,
          eventId: event.id,
          metadata: { ...update, queued },
        }).catch(() => {});

        res.json({ success: true, queued });
      } catch (error) {
        errorResponse(res, error, 500, 'Failed to update face settings');
      }
    });

  /**
   * People management grid. Unlike the gallery endpoint this returns hidden
   * and ignored people, plus the total (all-visibility) face count — the
   * photographer is allowed to see their own hidden photos.
   */
  router.get('/:id/people', adminAuth, requirePermission('events.view'), requireFaces, requireEventOwnership,
    async (req, res) => {
      try {
        const event = await loadOwnedEvent(req);
        if (!event) return res.status(404).json({ error: 'Event not found' });

        const people = await facePeopleService.listPeople(event.id, {
          isClient: true,
          forAdmin: true,
        });
        res.json({ people });
      } catch (error) {
        errorResponse(res, error, 500, 'Failed to fetch people');
      }
    });

  /**
   * Rename / hide / ignore / set cover.
   */
  router.patch('/:id/people/:personId',
    adminAuth,
    requirePermission('events.edit'),
    requireFaces,
    requireEventOwnership,
    [
      body('label').optional({ nullable: true }).isString().isLength({ max: 255 }),
      body('is_hidden').optional().isBoolean(),
      body('is_ignored').optional().isBoolean(),
      body('cover_face_id').optional({ nullable: true }).isInt(),
    ],
    async (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      try {
        const event = await loadOwnedEvent(req);
        if (!event) return res.status(404).json({ error: 'Event not found' });

        const person = await db('event_people')
          .where({ id: req.params.personId, event_id: event.id }).first();
        if (!person) return res.status(404).json({ error: 'Person not found' });

        const update = { updated_at: new Date().toISOString() };
        if (req.body.label !== undefined) {
          const label = req.body.label === null ? null : String(req.body.label).trim();
          update.label = label || null;
        }
        if (req.body.is_hidden !== undefined) update.is_hidden = parseBooleanInput(req.body.is_hidden, false);
        if (req.body.is_ignored !== undefined) update.is_ignored = parseBooleanInput(req.body.is_ignored, false);

        if (req.body.cover_face_id !== undefined && req.body.cover_face_id !== null) {
          // The cover must belong to THIS person in THIS event — otherwise a
          // crafted id could point the avatar at any face in the database.
          const face = await db('photo_faces')
            .where({ id: req.body.cover_face_id, event_id: event.id, person_id: person.id })
            .first();
          if (!face) return res.status(400).json({ error: 'cover_face_id does not belong to this person' });
          update.cover_face_id = face.id;
        }

        await db('event_people').where({ id: person.id }).update(update);
        res.json({ success: true });
      } catch (error) {
        errorResponse(res, error, 500, 'Failed to update person');
      }
    });

  /**
   * Merge people. The two operations that make automatic clustering survive
   * contact with reality are this and split — a well-behaved wedding gallery
   * still produces "Anna in daylight" and "Anna at the party".
   */
  router.post('/:id/people/merge',
    adminAuth,
    requirePermission('events.edit'),
    requireFaces,
    requireEventOwnership,
    [body('source_ids').isArray({ min: 1 }), body('target_id').isInt()],
    async (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      try {
        const event = await loadOwnedEvent(req);
        if (!event) return res.status(404).json({ error: 'Event not found' });

        // Every id must belong to this event — never merge across galleries.
        const ids = [...req.body.source_ids.map(Number), Number(req.body.target_id)];
        const owned = await db('event_people').where({ event_id: event.id }).whereIn('id', ids).pluck('id');
        if (owned.length !== new Set(ids).size) {
          return res.status(400).json({ error: 'One or more people do not belong to this event' });
        }

        const result = await faceClustering.mergePeople(
          event.id, req.body.source_ids.map(Number), Number(req.body.target_id)
        );
        res.json({ success: true, ...result });
      } catch (error) {
        errorResponse(res, error, 500, 'Failed to merge people');
      }
    });

  router.post('/:id/people/:personId/split',
    adminAuth,
    requirePermission('events.edit'),
    requireFaces,
    requireEventOwnership,
    [body('face_ids').isArray({ min: 1 })],
    async (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      try {
        const event = await loadOwnedEvent(req);
        if (!event) return res.status(404).json({ error: 'Event not found' });

        const newPersonId = await faceClustering.splitPerson(
          event.id, Number(req.params.personId), req.body.face_ids.map(Number)
        );
        if (!newPersonId) return res.status(400).json({ error: 'No matching faces to split' });
        res.json({ success: true, person_id: newPersonId });
      } catch (error) {
        errorResponse(res, error, 500, 'Failed to split person');
      }
    });

  /**
   * Faces of one person, for the split picker.
   */
  router.get('/:id/people/:personId/faces', adminAuth, requirePermission('events.view'), requireFaces, requireEventOwnership,
    async (req, res) => {
      try {
        const event = await loadOwnedEvent(req);
        if (!event) return res.status(404).json({ error: 'Event not found' });

        const faces = await buildPersonFacesQuery(db, event.id, req.params.personId);

        res.json({
          faces: faces.map((f) => ({
            id: f.id,
            photo_id: f.photo_id,
            bbox: [f.bbox_x, f.bbox_y, f.bbox_w, f.bbox_h],
            photo_width: f.photo_width ?? null,
            photo_height: f.photo_height ?? null,
            score: f.det_score,
            blur: f.blur,
          })),
        });
      } catch (error) {
        errorResponse(res, error, 500, 'Failed to fetch faces');
      }
    });

  /**
   * Re-scan: re-runs detection through the sidecar. Expensive.
   */
  router.post('/:id/faces/rescan', adminAuth, requirePermission('events.edit'), requireFaces, requireEventOwnership,
    async (req, res) => {
      try {
        const event = await loadOwnedEvent(req);
        if (!event) return res.status(404).json({ error: 'Event not found' });
        if (!(await faceSettings.isEnabledForEvent(event))) {
          return res.status(400).json({ error: 'Face detection is not enabled for this event' });
        }

        const queued = await faceProcessor.enqueueEvent(event.id, { onlyUnscanned: false });
        await db('events').where({ id: event.id })
          .update({ faces_last_scan_at: new Date().toISOString() });

        await logActivity('event_faces_rescan', {
          actorType: 'admin', actorId: req.admin.id, eventId: event.id, metadata: { queued },
        }).catch(() => {});

        res.json({ success: true, queued });
      } catch (error) {
        errorResponse(res, error, 500, 'Failed to queue re-scan');
      }
    });

  /**
   * Re-cluster: re-derives people from stored embeddings. Cheap — no sidecar
   * call — and the thing to run after changing the match threshold.
   */
  router.post('/:id/faces/recluster', adminAuth, requirePermission('events.edit'), requireFaces, requireEventOwnership,
    async (req, res) => {
      try {
        const event = await loadOwnedEvent(req);
        if (!event) return res.status(404).json({ error: 'Event not found' });

        const people = await faceClustering.recluster(event.id);
        await logActivity('event_faces_recluster', {
          actorType: 'admin', actorId: req.admin.id, eventId: event.id, metadata: { people },
        }).catch(() => {});

        res.json({ success: true, people });
      } catch (error) {
        errorResponse(res, error, 500, 'Failed to recluster');
      }
    });

  /**
   * Read/write the global auto-category setting.
   *
   * The migration seeds it false and nothing else ever wrote it, so the whole
   * rule engine — and its undo endpoint — were unreachable in normal product
   * flows: every call returned `skipped: disabled`. A feature with no way to
   * turn it on is not shipped.
   */
  router.get('/faces/auto-categories', adminAuth, requirePermission('settings.view'), requireFaces,
    async (req, res) => {
      try {
        const thresholds = await faceSettings.getThresholds();
        res.json({ enabled: thresholds.face_auto_categorize_enabled === true });
      } catch (error) {
        errorResponse(res, error, 500, 'Failed to read the auto-category setting');
      }
    });

  router.put('/faces/auto-categories',
    adminAuth,
    requirePermission('settings.edit'),
    requireFaces,
    [body('enabled').isBoolean()],
    async (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      try {
        const enabled = parseBooleanInput(req.body.enabled, false);
        const existing = await db('app_settings')
          .where('setting_key', 'face_auto_categorize_enabled').first();

        if (existing) {
          await db('app_settings').where('setting_key', 'face_auto_categorize_enabled')
            .update({ setting_value: JSON.stringify(enabled), updated_at: new Date().toISOString() });
        } else {
          await db('app_settings').insert({
            setting_key: 'face_auto_categorize_enabled',
            setting_value: JSON.stringify(enabled),
            setting_type: 'faces',
            updated_at: new Date().toISOString(),
          });
        }

        await logActivity('face_auto_categories_toggled', {
          actorType: 'admin', actorId: req.admin.id, metadata: { enabled },
        }).catch(() => {});

        res.json({ success: true, enabled });
      } catch (error) {
        errorResponse(res, error, 500, 'Failed to update the auto-category setting');
      }
    });

  /**
   * Run the auto-category rules over this event now.
   *
   * Normally happens automatically after each photo is scanned; this is for
   * applying the rules to a gallery that was scanned before the setting was
   * turned on.
   */
  router.post('/:id/faces/categorize', adminAuth, requirePermission('events.edit'), requireFaces, requireEventOwnership,
    async (req, res) => {
      try {
        const event = await loadOwnedEvent(req);
        if (!event) return res.status(404).json({ error: 'Event not found' });

        const { categorizeEvent } = require('../../services/faceAutoCategories');
        const result = await categorizeEvent(event.id);
        res.json({ success: true, ...result });
      } catch (error) {
        errorResponse(res, error, 500, 'Failed to apply automatic categories');
      }
    });

  /**
   * Undo every automatic category assignment. Only clears what the rule
   * engine set — categories chosen by a person are untouched.
   */
  router.delete('/:id/faces/categorize', adminAuth, requirePermission('events.edit'), requireFaces, requireEventOwnership,
    async (req, res) => {
      try {
        const event = await loadOwnedEvent(req);
        if (!event) return res.status(404).json({ error: 'Event not found' });

        const { undoEvent } = require('../../services/faceAutoCategories');
        const result = await undoEvent(event.id);

        await logActivity('event_faces_categories_undone', {
          actorType: 'admin', actorId: req.admin.id, eventId: event.id, metadata: result,
        }).catch(() => {});

        res.json({ success: true, ...result });
      } catch (error) {
        errorResponse(res, error, 500, 'Failed to undo automatic categories');
      }
    });

  /**
   * Delete all face data for this event. The GDPR erasure path.
   */
  router.delete('/:id/faces', adminAuth, requirePermission('events.edit'), requireFaces, requireEventOwnership,
    async (req, res) => {
      try {
        const event = await loadOwnedEvent(req);
        if (!event) return res.status(404).json({ error: 'Event not found' });

        const result = await faceProcessor.purgeEvent(event.id);
        await db('events').where({ id: event.id }).update({ faces_last_scan_at: null });

        await logActivity('event_faces_purged', {
          actorType: 'admin', actorId: req.admin.id, eventId: event.id, metadata: result,
        }).catch(() => {});

        logger.info(`adminEvents: face data purged for event ${event.id} by admin ${req.admin.id}`);
        res.json({ success: true, ...result });
      } catch (error) {
        errorResponse(res, error, 500, 'Failed to delete face data');
      }
    });

};

module.exports.buildPersonFacesQuery = buildPersonFacesQuery;
module.exports.PERSON_FACES_LIMIT = PERSON_FACES_LIMIT;
