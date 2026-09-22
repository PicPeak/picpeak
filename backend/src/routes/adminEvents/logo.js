const { capabilityEvidence } = require('../../usage/capabilityEvidence');
// Extracted verbatim from the original routes/adminEvents.js (see ./index.js).
// Exports a register function; ./index.js calls the sub-routers in the original
// registration order so Express route matching is unchanged.

const { db, logActivity } = require('../../database/db');
const { adminAuth } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permissions');
const fs = require('fs').promises;
const path = require('path');
const multer = require('multer');
const logger = require('../../utils/logger');
const { errorResponse } = require('../../utils/routeHelpers');
const { validateFileType } = require('../../utils/fileSecurityUtils');
const { requireEventOwnership } = require('../../middleware/ownership');
const { getStoragePath } = require('./helpers');
const { resolveStoredPath, toStoredPath } = require('../../utils/storedPath');


// Configure multer for event logo uploads
const eventLogoStorage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = path.join(getStoragePath(), 'uploads/logos/events');
    await fs.mkdir(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const eventId = Number(req.params.id);
    if (!Number.isInteger(eventId) || eventId <= 0) {
      return cb(new Error('Invalid event id'));
    }
    const ext = path.extname(file.originalname);
    cb(null, `event-${eventId}-logo-${Date.now()}${ext}`);
  }
});

const eventLogoUpload = multer({
  storage: eventLogoStorage,
  // CVE-2026-82333: single unnamed `logo` field only — no legitimate
  // array-indexed field names, so reject any bracket-index field name.
  limits: { fileSize: 5 * 1024 * 1024, fieldArrayIndexLimit: 0 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/svg+xml'];
    if (validateFileType(file.originalname, file.mimetype, allowedMimeTypes)) {
      return cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, GIF and SVG image files are allowed'));
    }
  }
});

module.exports = (router) => {


  // Upload event custom logo
  router.post('/:id/logo', adminAuth, requirePermission('events.edit'), requireEventOwnership, eventLogoUpload.single('logo'), async (req, res) => {
    try {
      const { id } = req.params;

      // Check if event exists
      let eventQuery = db('events').where('id', id);
      if (req.admin.roleName === 'editor') {
        eventQuery = eventQuery.where('created_by', req.admin.id);
      }
      const event = await eventQuery.first();
      if (!event) {
        return res.status(404).json({ error: 'Event not found' });
      }

      if (!req.file) {
        return res.status(400).json({ error: 'No logo file provided' });
      }

      // Delete old logo file if exists
      if (event.hero_logo_path) {
        try {
          await fs.unlink(resolveStoredPath(event.hero_logo_path) || '');
          logger.debug('Deleted old event logo file', { path: event.hero_logo_path });
        } catch (err) {
          logger.warn('Failed to delete old event logo file', { path: event.hero_logo_path, error: err.message });
        }
      }

      const logoUrl = `/uploads/logos/events/${req.file.filename}`;
      const logoPath = req.file.path;

      await db('events')
        .where('id', id)
        .update({
          hero_logo_url: logoUrl,
          hero_logo_path: toStoredPath(logoPath)
        });

      await logActivity('event_logo_uploaded',
        { eventName: event.event_name, filename: req.file.filename },
        id,
        { type: 'admin', id: req.admin.id, name: req.admin.username }
      );

      capabilityEvidence(res, 'branding_editing');
      res.json({
        message: 'Event logo uploaded successfully',
        hero_logo_url: logoUrl
      });
    } catch (error) {
      errorResponse(res, error, 500, 'Failed to upload event logo');
    }
  });

  // Delete event custom logo
  router.delete('/:id/logo', adminAuth, requirePermission('events.edit'), requireEventOwnership, async (req, res) => {
    try {
      const { id } = req.params;

      let eventQuery = db('events').where('id', id);
      if (req.admin.roleName === 'editor') {
        eventQuery = eventQuery.where('created_by', req.admin.id);
      }
      const event = await eventQuery.first();
      if (!event) {
        return res.status(404).json({ error: 'Event not found' });
      }

      // Delete logo file if exists
      if (event.hero_logo_path) {
        try {
          await fs.unlink(resolveStoredPath(event.hero_logo_path) || '');
          logger.debug('Deleted event logo file', { path: event.hero_logo_path });
        } catch (err) {
          logger.warn('Failed to delete event logo file', { path: event.hero_logo_path, error: err.message });
        }
      }

      await db('events')
        .where('id', id)
        .update({
          hero_logo_url: null,
          hero_logo_path: null
        });

      await logActivity('event_logo_removed',
        { eventName: event.event_name },
        id,
        { type: 'admin', id: req.admin.id, name: req.admin.username }
      );

      if (event.hero_logo_url || event.hero_logo_path) capabilityEvidence(res, 'branding_editing');
      res.json({ message: 'Event logo removed successfully' });
    } catch (error) {
      errorResponse(res, error, 500, 'Failed to delete event logo');
    }
  });


};
