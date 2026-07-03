const express = require('express');
const crypto = require('crypto');
const archiver = require('archiver');
const router = express.Router();
const { db, logActivity } = require('../database/db');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { requireEventOwnership } = require('../middleware/ownership');
const feedbackService = require('../services/feedbackService');
const logger = require('../utils/logger');

const FRONTEND_URL = process.env.FRONTEND_URL || '';

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

async function loadGuestOr404(eventId, guestId, res) {
  const guest = await db('gallery_guests')
    .where({ id: guestId, event_id: eventId, is_deleted: false })
    .first();
  if (!guest) {
    res.status(404).json({ error: 'Guest not found' });
    return null;
  }
  return guest;
}

function serializeGuest(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    email_verified_at: row.email_verified_at,
    is_deleted: row.is_deleted,
  };
}

function escapeCsvCell(value) {
  const str = value == null ? '' : String(value);
  if (/[,"\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// ----------------------------------------------------------------------------
// GET /admin/events/:eventId/guests — list guests with aggregated counts
// ----------------------------------------------------------------------------

router.get(
  '/events/:eventId/guests',
  adminAuth,
  requirePermission('events.view'),
  requireEventOwnership,
  async (req, res) => {
    try {
      const { eventId } = req.params;

      const rows = await db('gallery_guests')
        .leftJoin('photo_feedback', function () {
          this.on('photo_feedback.guest_id', '=', 'gallery_guests.id');
        })
        .where('gallery_guests.event_id', eventId)
        .where('gallery_guests.is_deleted', false)
        .groupBy('gallery_guests.id')
        .select(
          'gallery_guests.id',
          'gallery_guests.name',
          'gallery_guests.email',
          'gallery_guests.created_at',
          'gallery_guests.last_seen_at',
          'gallery_guests.email_verified_at',
          db.raw("COUNT(CASE WHEN photo_feedback.feedback_type = 'like' THEN 1 END) AS likes"),
          db.raw("COUNT(CASE WHEN photo_feedback.feedback_type = 'favorite' THEN 1 END) AS favorites"),
          db.raw("COUNT(CASE WHEN photo_feedback.feedback_type = 'comment' THEN 1 END) AS comments"),
          db.raw("COUNT(CASE WHEN photo_feedback.feedback_type = 'rating' THEN 1 END) AS ratings"),
          db.raw('COUNT(DISTINCT photo_feedback.photo_id) AS distinct_photos')
        )
        .orderBy('gallery_guests.created_at', 'desc');

      const guests = rows.map((r) => ({
        ...serializeGuest(r),
        stats: {
          likes: parseInt(r.likes, 10) || 0,
          favorites: parseInt(r.favorites, 10) || 0,
          comments: parseInt(r.comments, 10) || 0,
          ratings: parseInt(r.ratings, 10) || 0,
          distinct_photos: parseInt(r.distinct_photos, 10) || 0,
        },
      }));

      res.json({ guests });
    } catch (error) {
      logger.error('Error listing guests:', error);
      res.status(500).json({ error: 'Failed to list guests' });
    }
  }
);

// ----------------------------------------------------------------------------
// GET /admin/events/:eventId/guests/aggregate — photos sorted by distinct
// guest pick count (Phase 2 aggregate view)
// ----------------------------------------------------------------------------

router.get(
  '/events/:eventId/guests/aggregate',
  adminAuth,
  requirePermission('events.view'),
  requireEventOwnership,
  async (req, res) => {
    try {
      const { eventId } = req.params;

      const photos = await db('photos')
        .leftJoin('photo_feedback', function () {
          this.on('photo_feedback.photo_id', '=', 'photos.id')
            .andOn(db.raw("photo_feedback.feedback_type IN ('like','favorite')"))
            .andOnNotNull('photo_feedback.guest_id');
        })
        .where('photos.event_id', eventId)
        .groupBy('photos.id')
        .select(
          'photos.id',
          'photos.filename',
          'photos.original_filename',
          db.raw('COUNT(DISTINCT photo_feedback.guest_id) AS picker_count')
        )
        .orderBy('picker_count', 'desc')
        .orderBy('photos.id', 'desc');

      res.json({
        photos: photos
          .filter((p) => parseInt(p.picker_count, 10) > 0)
          .map((p) => ({
            id: p.id,
            filename: p.filename,
            original_filename: p.original_filename,
            url: `/api/admin/photos/${eventId}/photo/${p.id}`,
            thumbnail_url: `/api/admin/photos/${eventId}/thumbnail/${p.id}`,
            picker_count: parseInt(p.picker_count, 10),
          })),
      });
    } catch (error) {
      logger.error('Error fetching aggregate view:', error);
      res.status(500).json({ error: 'Failed to fetch aggregate view' });
    }
  }
);

// ----------------------------------------------------------------------------
// GET /admin/events/:eventId/guests/invites — list pre-minted invites
// ----------------------------------------------------------------------------

router.get(
  '/events/:eventId/guests/invites',
  adminAuth,
  requirePermission('events.view'),
  requireEventOwnership,
  async (req, res) => {
    try {
      const { eventId } = req.params;
      const event = await db('events').where({ id: eventId }).first();

      const rows = await db('guest_invites')
        .leftJoin('gallery_guests', 'gallery_guests.id', 'guest_invites.guest_id')
        .where('guest_invites.event_id', eventId)
        .select(
          'guest_invites.id',
          'guest_invites.token',
          'guest_invites.created_at',
          'guest_invites.redeemed_at',
          'guest_invites.revoked_at',
          'gallery_guests.id as guest_id',
          'gallery_guests.name as guest_name',
          'gallery_guests.email as guest_email'
        )
        .orderBy('guest_invites.created_at', 'desc');

      const invites = rows.map((r) => ({
        id: r.id,
        token: r.token,
        url: `${FRONTEND_URL}/gallery/${event.slug}?invite=${r.token}`,
        created_at: r.created_at,
        redeemed_at: r.redeemed_at,
        revoked_at: r.revoked_at,
        status: r.revoked_at ? 'revoked' : r.redeemed_at ? 'redeemed' : 'pending',
        guest: {
          id: r.guest_id,
          name: r.guest_name,
          email: r.guest_email,
        },
      }));

      res.json({ invites });
    } catch (error) {
      logger.error('Error listing invites:', error);
      res.status(500).json({ error: 'Failed to list invites' });
    }
  }
);

// ----------------------------------------------------------------------------
// POST /admin/events/:eventId/guests/invites — create guest + invite
// Body: { name, email? }
// ----------------------------------------------------------------------------

router.post(
  '/events/:eventId/guests/invites',
  adminAuth,
  requirePermission('events.edit'),
  requireEventOwnership,
  async (req, res) => {
    try {
      const { eventId } = req.params;
      const name = String(req.body?.name || '').trim().slice(0, 100);
      const email = String(req.body?.email || '').trim().slice(0, 255).toLowerCase();
      if (!name) {
        return res.status(400).json({ error: 'Name is required' });
      }

      const identifier = crypto.randomUUID();
      const inviteToken = crypto.randomBytes(24).toString('hex');

      let guestId;
      let inviteId;
      await db.transaction(async (trx) => {
        const [guestRow] = await trx('gallery_guests')
          .insert({
            event_id: eventId,
            name,
            email: email || null,
            identifier,
          })
          .returning(['id']);
        guestId = guestRow.id;

        const [inviteRow] = await trx('guest_invites')
          .insert({
            event_id: eventId,
            guest_id: guestId,
            token: inviteToken,
            created_by_admin_id: req.admin.id,
          })
          .returning(['id']);
        inviteId = inviteRow.id;
      });

      await logActivity(
        'guest_invite_created',
        { event_id: eventId, guest_id: guestId, invite_id: inviteId },
        eventId,
        { type: 'admin', id: req.admin.id, name: req.admin.username }
      );

      const event = await db('events').where({ id: eventId }).first();
      res.json({
        invite: {
          id: inviteId,
          token: inviteToken,
          url: `${FRONTEND_URL}/gallery/${event.slug}?invite=${inviteToken}`,
          status: 'pending',
          guest: { id: guestId, name, email: email || null },
        },
      });
    } catch (error) {
      logger.error('Error creating invite:', error);
      res.status(500).json({ error: 'Failed to create invite' });
    }
  }
);

// ----------------------------------------------------------------------------
// DELETE /admin/events/:eventId/guests/invites/:inviteId — revoke
// ----------------------------------------------------------------------------

router.delete(
  '/events/:eventId/guests/invites/:inviteId',
  adminAuth,
  requirePermission('events.edit'),
  requireEventOwnership,
  async (req, res) => {
    try {
      const { eventId, inviteId } = req.params;
      const updated = await db('guest_invites')
        .where({ id: inviteId, event_id: eventId })
        .whereNull('revoked_at')
        .update({ revoked_at: db.fn.now() });

      if (!updated) {
        return res.status(404).json({ error: 'Invite not found or already revoked' });
      }

      await logActivity(
        'guest_invite_revoked',
        { event_id: eventId, invite_id: inviteId },
        eventId,
        { type: 'admin', id: req.admin.id, name: req.admin.username }
      );

      res.json({ success: true });
    } catch (error) {
      logger.error('Error revoking invite:', error);
      res.status(500).json({ error: 'Failed to revoke invite' });
    }
  }
);

// ----------------------------------------------------------------------------
// GET /admin/events/:eventId/guests/export-all — ZIP of per-guest exports
// Query: format=txt|csv|json (default: csv)
// ----------------------------------------------------------------------------

router.get(
  '/events/:eventId/guests/export-all',
  adminAuth,
  requirePermission('events.view'),
  requireEventOwnership,
  async (req, res) => {
    try {
      const { eventId } = req.params;
      const format = ['txt', 'csv', 'json'].includes(req.query.format) ? req.query.format : 'csv';

      const guests = await db('gallery_guests')
        .where({ event_id: eventId, is_deleted: false })
        .select('id', 'name', 'email');

      if (guests.length === 0) {
        return res.status(404).json({ error: 'No guests to export' });
      }

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="event-${eventId}-guests.zip"`
      );

      const archive = archiver('zip', { zlib: { level: 9 } });
      archive.on('error', (err) => {
        logger.error('Archive error:', err);
        res.status(500).end();
      });
      archive.pipe(res);

      for (const g of guests) {
        const selections = await db('photo_feedback')
          .join('photos', 'photo_feedback.photo_id', 'photos.id')
          .where('photo_feedback.guest_id', g.id)
          .whereIn('photo_feedback.feedback_type', ['like', 'favorite'])
          .select('photos.filename', 'photos.original_filename', 'photo_feedback.feedback_type');

        const safeName = g.name.replace(/[^a-zA-Z0-9_-]/g, '_') || `guest_${g.id}`;
        const filename = `${safeName}.${format}`;

        let body;
        if (format === 'json') {
          body = JSON.stringify({ guest: g, selections }, null, 2);
        } else if (format === 'csv') {
          const header = 'filename,original_filename,feedback_type';
          const rows = selections.map(
            (s) =>
              `${escapeCsvCell(s.filename)},${escapeCsvCell(s.original_filename)},${escapeCsvCell(s.feedback_type)}`
          );
          body = [header, ...rows].join('\n');
        } else {
          // txt — just filenames
          body = selections.map((s) => s.original_filename || s.filename).join('\n');
        }
        archive.append(body, { name: filename });
      }

      await archive.finalize();
    } catch (error) {
      logger.error('Error exporting all guests:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to export guests' });
      }
    }
  }
);

// ----------------------------------------------------------------------------
// GET /admin/events/:eventId/guests/:guestId — guest detail with selections
// (Phase 2)
// ----------------------------------------------------------------------------

router.get(
  '/events/:eventId/guests/:guestId',
  adminAuth,
  requirePermission('events.view'),
  requireEventOwnership,
  async (req, res) => {
    try {
      const { eventId, guestId } = req.params;
      const guest = await loadGuestOr404(eventId, guestId, res);
      if (!guest) return;

      const feedback = await db('photo_feedback')
        .join('photos', 'photo_feedback.photo_id', 'photos.id')
        .where('photo_feedback.guest_id', guestId)
        .select(
          'photo_feedback.id as feedback_id',
          'photo_feedback.feedback_type',
          'photo_feedback.rating',
          'photo_feedback.comment_text',
          'photo_feedback.created_at',
          'photos.id as photo_id',
          'photos.filename',
          'photos.original_filename',
          'photos.type'
        )
        .orderBy('photo_feedback.created_at', 'desc');

      const photoFor = (row) => ({
        id: row.photo_id,
        filename: row.filename,
        original_filename: row.original_filename,
        type: row.type,
        url: `/api/admin/photos/${eventId}/photo/${row.photo_id}`,
        thumbnail_url: `/api/admin/photos/${eventId}/thumbnail/${row.photo_id}`,
      });

      const selections = {
        liked: [],
        favorited: [],
        rated: [],
        commented: [],
      };
      for (const row of feedback) {
        if (row.feedback_type === 'like') {
          selections.liked.push(photoFor(row));
        } else if (row.feedback_type === 'favorite') {
          selections.favorited.push(photoFor(row));
        } else if (row.feedback_type === 'rating') {
          selections.rated.push({ photo: photoFor(row), rating: row.rating });
        } else if (row.feedback_type === 'comment') {
          selections.commented.push({
            photo: photoFor(row),
            comment: row.comment_text,
            created_at: row.created_at,
          });
        }
      }

      res.json({
        guest: {
          ...serializeGuest(guest),
          stats: {
            likes: selections.liked.length,
            favorites: selections.favorited.length,
            comments: selections.commented.length,
            ratings: selections.rated.length,
          },
        },
        selections,
      });
    } catch (error) {
      logger.error('Error fetching guest detail:', error);
      res.status(500).json({ error: 'Failed to fetch guest detail' });
    }
  }
);

// ----------------------------------------------------------------------------
// GET /admin/events/:eventId/guests/:guestId/export — per-guest export
// Query: format=txt|csv|json
// ----------------------------------------------------------------------------

router.get(
  '/events/:eventId/guests/:guestId/export',
  adminAuth,
  requirePermission('events.view'),
  requireEventOwnership,
  async (req, res) => {
    try {
      const { eventId, guestId } = req.params;
      const format = ['txt', 'csv', 'json'].includes(req.query.format) ? req.query.format : 'txt';
      const guest = await loadGuestOr404(eventId, guestId, res);
      if (!guest) return;

      const selections = await db('photo_feedback')
        .join('photos', 'photo_feedback.photo_id', 'photos.id')
        .where('photo_feedback.guest_id', guestId)
        .whereIn('photo_feedback.feedback_type', ['like', 'favorite'])
        .select('photos.filename', 'photos.original_filename', 'photo_feedback.feedback_type');

      const safeName = guest.name.replace(/[^a-zA-Z0-9_-]/g, '_') || `guest_${guest.id}`;
      const filename = `${safeName}.${format}`;

      if (format === 'json') {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        return res.send(JSON.stringify({ guest: serializeGuest(guest), selections }, null, 2));
      }
      if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        const header = 'filename,original_filename,feedback_type';
        const rows = selections.map(
          (s) =>
            `${escapeCsvCell(s.filename)},${escapeCsvCell(s.original_filename)},${escapeCsvCell(s.feedback_type)}`
        );
        return res.send([header, ...rows].join('\n'));
      }
      // txt — one filename per line
      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(selections.map((s) => s.original_filename || s.filename).join('\n'));
    } catch (error) {
      logger.error('Error exporting guest:', error);
      res.status(500).json({ error: 'Failed to export guest' });
    }
  }
);

// ----------------------------------------------------------------------------
// DELETE /admin/events/:eventId/guests/:guestId — anonymize (soft delete)
// ----------------------------------------------------------------------------

router.delete(
  '/events/:eventId/guests/:guestId',
  adminAuth,
  requirePermission('events.edit'),
  requireEventOwnership,
  async (req, res) => {
    try {
      const { eventId, guestId } = req.params;
      const guest = await loadGuestOr404(eventId, guestId, res);
      if (!guest) return;

      const result = await feedbackService.anonymizeGuestFeedback(guestId);

      await db('gallery_guests').where({ id: guestId }).update({
        is_deleted: true,
        name: 'Removed',
        email: null,
        last_seen_at: db.fn.now(),
      });

      await logActivity(
        'guest_deleted',
        { event_id: eventId, guest_id: guestId, anonymized: result.anonymized },
        eventId,
        { type: 'admin', id: req.admin.id, name: req.admin.username }
      );

      res.json({ success: true, ...result });
    } catch (error) {
      logger.error('Error deleting guest:', error);
      res.status(500).json({ error: 'Failed to delete guest' });
    }
  }
);

// ----------------------------------------------------------------------------
// POST /admin/events/:eventId/guests/:keepId/merge — merge guests (Phase 3.4)
// Body: { mergeIds: number[] }
// ----------------------------------------------------------------------------

router.post(
  '/events/:eventId/guests/:keepId/merge',
  adminAuth,
  requirePermission('events.edit'),
  requireEventOwnership,
  async (req, res) => {
    try {
      const { eventId, keepId } = req.params;
      const mergeIds = Array.isArray(req.body?.mergeIds) ? req.body.mergeIds : [];

      if (mergeIds.length === 0) {
        return res.status(400).json({ error: 'mergeIds is required' });
      }
      if (mergeIds.includes(Number(keepId))) {
        return res.status(400).json({ error: 'Cannot merge a guest into itself' });
      }

      // Sanity check: all guests belong to this event.
      const all = await db('gallery_guests')
        .whereIn('id', [Number(keepId), ...mergeIds.map(Number)])
        .where({ event_id: eventId });
      if (all.length !== mergeIds.length + 1) {
        return res.status(400).json({ error: 'All guests must belong to the same event' });
      }

      const result = await feedbackService.mergeGuestFeedback(Number(keepId), mergeIds.map(Number));

      // Soft-delete the merged (source) guests.
      await db('gallery_guests')
        .whereIn('id', mergeIds.map(Number))
        .update({ is_deleted: true, last_seen_at: db.fn.now() });

      await logActivity(
        'guest_merged',
        { event_id: eventId, keep_id: keepId, merged_ids: mergeIds },
        eventId,
        { type: 'admin', id: req.admin.id, name: req.admin.username }
      );

      res.json({ success: true, ...result });
    } catch (error) {
      logger.error('Error merging guests:', error);
      res.status(500).json({ error: 'Failed to merge guests' });
    }
  }
);

module.exports = router;
