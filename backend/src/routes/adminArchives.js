const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const { db } = require('../database/db');
const { formatBoolean } = require('../utils/dbCompat');
const { slugify } = require('../utils/slug');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const archiver = require('archiver');
const StreamZip = require('node-stream-zip');
const { requireEventOwnership } = require('../middleware/ownership');
const { assertZipEntriesWithin } = require('../utils/safePath');
const logger = require('../utils/logger');
const { sanitizeForZipEntry } = require('../utils/filenameSanitizer');
const { getPagination } = require('../utils/routeHelpers');
const router = express.Router();

// Get all archived events
router.get('/', adminAuth, requirePermission('archives.view'), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req);

    // Get total count
    const totalCount = await db('events')
      .where('is_archived', formatBoolean(true))
      .count('id as count')
      .first();

    // Get archived events
    const archives = await db('events')
      .select(
        'events.*',
        db.raw('COUNT(DISTINCT photos.id) as photo_count'),
        db.raw('SUM(photos.size_bytes) as total_size')
      )
      .leftJoin('photos', 'events.id', 'photos.event_id')
      .where('events.is_archived', formatBoolean(true))
      .groupBy('events.id')
      .orderBy('events.archived_at', 'desc')
      .limit(limit)
      .offset(offset);

    // Check if archive files exist and get their sizes
    const storagePath = process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');
    const archivesWithFileInfo = await Promise.all(archives.map(async (archive) => {
      let archiveFileSize = 0;
      if (archive.archive_path) {
        try {
          const fullArchivePath = path.join(storagePath, archive.archive_path);
          const stats = await fs.stat(fullArchivePath);
          archiveFileSize = stats.size;
        } catch (error) {
          logger.error(`Archive file not found: ${archive.archive_path}`);
        }
      }

      return {
        id: archive.id,
        slug: archive.slug,
        eventName: archive.event_name,
        eventDate: archive.event_date,
        eventType: archive.event_type,
        hostEmail: archive.host_email,
        archivedAt: archive.archived_at ? new Date(archive.archived_at).toISOString() : null,
        expiresAt: archive.expires_at ? new Date(archive.expires_at).toISOString() : null,
        photoCount: archive.photo_count || 0,
        originalSize: archive.total_size || 0,
        archiveSize: archiveFileSize,
        archivePath: archive.archive_path
      };
    }));

    res.json({
      archives: archivesWithFileInfo,
      pagination: {
        page,
        limit,
        total: totalCount.count,
        totalPages: Math.ceil(totalCount.count / limit)
      }
    });
  } catch (error) {
    logger.error('Archives list error:', error);
    res.status(500).json({ error: 'Failed to fetch archives' });
  }
});

// Get single archive details
router.get('/:id', adminAuth, requirePermission('archives.view'), requireEventOwnership, async (req, res) => {
  try {
    const archive = await db('events')
      .where('id', req.params.id)
      .where('is_archived', formatBoolean(true))
      .first();

    if (!archive) {
      return res.status(404).json({ error: 'Archive not found' });
    }

    // Get photo details
    const photos = await db('photos')
      .where('event_id', archive.id)
      .select('filename', 'type', 'size_bytes', 'uploaded_at');

    // Check archive file
    let archiveFileInfo = null;
    if (archive.archive_path) {
      try {
        const storagePath = process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');
        const fullArchivePath = path.join(storagePath, archive.archive_path);
        const stats = await fs.stat(fullArchivePath);
        archiveFileInfo = {
          size: stats.size,
          createdAt: stats.birthtime,
          path: archive.archive_path
        };
      } catch (error) {
        logger.error('Archive file not found:', error);
      }
    }

    res.json({
      id: archive.id,
      slug: archive.slug,
      eventName: archive.event_name,
      eventDate: archive.event_date,
      eventType: archive.event_type,
      hostEmail: archive.host_email,
      adminEmail: archive.admin_email,
      welcomeMessage: archive.welcome_message,
      colorTheme: archive.color_theme,
      createdAt: archive.created_at,
      expiresAt: archive.expires_at,
      archivedAt: archive.archived_at,
      photos: photos,
      archiveFile: archiveFileInfo
    });
  } catch (error) {
    logger.error('Archive details error:', error);
    res.status(500).json({ error: 'Failed to fetch archive details' });
  }
});

// Restore archive
router.post('/:id/restore', adminAuth, requirePermission('archives.restore'), requireEventOwnership, async (req, res) => {
  try {
    const archive = await db('events')
      .where('id', req.params.id)
      .where('is_archived', formatBoolean(true))
      .first();

    if (!archive) {
      return res.status(404).json({ error: 'Archive not found' });
    }

    // Check if archive file exists
    if (!archive.archive_path) {
      return res.status(400).json({ error: 'No archive file found' });
    }

    const storagePath = process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');
    const fullArchivePath = path.join(storagePath, archive.archive_path);

    try {
      await fs.access(fullArchivePath);
    } catch (error) {
      return res.status(404).json({ error: 'Archive file not found on disk' });
    }

    // Extract the archive
    try {
      // node-stream-zip streams each entry to disk on extract — adm-zip used
      // to load the whole archive into a Node Buffer up front, which capped
      // restore at 2 GiB (ERR_FS_FILE_TOO_LARGE). Real-world wedding archives
      // routinely cross that line. Credit: 8digit/picpeak@69033c6.
      const zip = new StreamZip.async({ file: fullArchivePath });
      const eventsDir = path.join(storagePath, 'events/active');
      const eventDir = path.join(eventsDir, archive.slug);

      // Create event directory if it doesn't exist
      await fs.mkdir(eventDir, { recursive: true });

      // Log ZIP contents for debugging
      logger.info(`Extracting archive to: ${eventDir}`);
      const entries = Object.values(await zip.entries());
      logger.info(`Archive contains ${entries.length} entries`);

      // Reject ZIP-slip entries before writing anything to disk — extract()
      // does not neutralise `../` in entry names (GHSA-jfhw-fj23-fx6x).
      try {
        assertZipEntriesWithin(entries, eventDir);
      } catch (slipErr) {
        await zip.close();
        logger.warn(`Refusing archive restore — unsafe entry path: ${slipErr.message}`);
        return res.status(400).json({ error: 'Archive contains invalid entry paths' });
      }

      // Stream-extract everything to disk
      await zip.extract(null, eventDir);
      await zip.close();

      // Load photos manifest if present. The gallery filenames are renamed on
      // upload, so `original_filename` (and category linkage) can't be derived
      // from the extracted files alone — they're only recoverable from the
      // manifest the archive process writes. Older archives have no manifest;
      // we fall back to filename for those.
      const manifestByFilename = new Map();
      // Aliases that more than one manifest row claims — see the loop below.
      const ambiguousAliases = new Set();
      try {
        const manifestRaw = await fs.readFile(
          path.join(eventDir, 'photos_manifest.json'), 'utf8',
        );
        const parsed = JSON.parse(manifestRaw);
        if (Array.isArray(parsed)) {
          // Two passes, and the order is the point. Canonical photos.filename
          // keys are claimed first and never yielded afterwards; aliases only
          // fill names no canonical row wanted. Interleaving them made the
          // result depend on manifest iteration order — the query has no
          // ORDER BY — and could delete a canonical key because some OTHER
          // row's original_filename happened to collide with it.
          const rows = parsed.filter((m) => m && m.filename);

          // photos.filename is not unique within an event: s3AutoImporter
          // takes path.basename(entry.key) and dedupes by path, so two
          // imported files in different subfolders both land as `IMG_1234.jpg`
          // with different `path` values. At restore both ZIP entries reduce
          // to the same basename, so whichever row won the key would hand the
          // other photo someone else's category. Contested names are dropped
          // rather than guessed.
          const contestedFilenames = new Set();
          for (const m of rows) {
            const held = manifestByFilename.get(m.filename);
            if (held && held !== m) {
              contestedFilenames.add(m.filename);
              continue;
            }
            manifestByFilename.set(m.filename, m);
          }
          for (const name of contestedFilenames) manifestByFilename.delete(name);
          if (contestedFilenames.size) {
            logger.warn(
              `Photos manifest: ${contestedFilenames.size} filename(s) claimed by more than one photo; `
              + 'those fall back to the directory for their category.'
            );
          }

          // Every canonical name, contested ones included — an alias must not
          // claim a name that a canonical row wanted and lost, either.
          const canonicalNames = new Set(rows.map((m) => m.filename));

          for (const m of rows) {
            // Also index by original_filename. When
            // general_use_original_filenames_for_downloads was on at archive
            // time, archiveService names each ZIP entry after the ORIGINAL
            // filename, while the manifest stays keyed by the internal
            // photos.filename — so a lookup by the extracted basename misses
            // every entry and the restore silently loses categories on exactly
            // those archives. Never overwrite a real filename key: that one is
            // authoritative if both happen to collide.
            // Index the name as the ZIP would have EMITTED it, not the raw
            // column: archiveService runs original names through
            // sanitizeForZipEntry() before writing the entry, so an original
            // with a slash or a control byte lands under a different name than
            // the manifest records. Index both, so either spelling resolves.
            //
            // Still not total: uniquifyZipNames() appends `_1` when two photos
            // in one event share an original name, and that suffix cannot be
            // reconstructed from the manifest. Those few fall through to the
            // directory, exactly as they did before this fix — no worse, just
            // not better. Closing that needs the emitted name recorded at
            // archive time, which is a writer change and a new archive format.
            for (const alias of [m.original_filename, sanitizeForZipEntry(m.original_filename)]) {
              if (!alias) continue;
              // An alias colliding with someone else's canonical name is
              // genuinely undecidable, so it is dropped rather than resolved
              // either way. Which photo the ZIP emitted under that name
              // depends on whether original-filename archiving was on at
              // archive time, and the manifest does not record that: with it
              // ON the entry is the ALIAS owner's file, with it OFF it is the
              // canonical owner's. Preferring either one silently mislabels
              // the other half of the time.
              //
              // What the two-pass split buys is that this is now decided the
              // same way every run — the archive query has no ORDER BY, so
              // interleaving the passes previously made it a coin flip
              // between dropping the name and overwriting it.
              if (canonicalNames.has(alias)) {
                if (manifestByFilename.get(alias) !== m) ambiguousAliases.add(alias);
                continue;
              }
              if (manifestByFilename.has(alias)) {
                // Two rows want the same alias — e.g. `individual/IMG.jpg` and
                // `collages/IMG.jpg`, which archiveService treats as distinct
                // paths and does not suffix, but which collapse to one basename
                // here. Whichever won would give the other photo someone else's
                // category. Drop the alias so both fall through to the
                // directory instead: an unresolved category is recoverable, a
                // confidently wrong one is not.
                if (manifestByFilename.get(alias) !== m) ambiguousAliases.add(alias);
                continue;
              }
              manifestByFilename.set(alias, m);
            }
          }
        }
        for (const alias of ambiguousAliases) manifestByFilename.delete(alias);
        if (ambiguousAliases.size) {
          logger.warn(
            `Photos manifest: ${ambiguousAliases.size} original-filename alias(es) claimed by more than one `
            + 'photo; those fall back to the directory for their category.'
          );
        }
        logger.info(`Loaded photos manifest: ${manifestByFilename.size} entries`);
      } catch (e) {
        if (e.code !== 'ENOENT') {
          logger.warn('Photos manifest present but unreadable; falling back to filenames', e.message);
        } else {
          logger.info('No photos manifest in archive (older archive); original_filename falls back to filename');
        }
      }

      // Get list of extracted files to update database
      const extractedPhotos = [];

      // Category name -> id, resolved once per name for the whole restore.
      const categoriesMap = new Map();

      // Find-or-create the category by name, among the ones this event can see.
      const resolveCategoryId = async (categoryName) => {
        if (!categoryName) return null;
        if (categoriesMap.has(categoryName)) return categoriesMap.get(categoryName);

        // Globals count as existing. A photo filed under the seeded "Ceremony"
        // has event_id NULL on its category row, so an event-only lookup misses
        // it and creates a second "Ceremony" — and since is_global defaults to
        // TRUE, that duplicate then shows up in every other event's category
        // list. Same visibility rule the photo routes use: own rows or global.
        // Two queries, not one with an OR: an event-scoped category and a
        // global one may share a name, and a single .first() would return
        // whichever the engine felt like — silently reassigning a photo to the
        // global row and losing event-local settings like allow_downloads.
        // The event's own row is the more specific answer, so it wins.
        //
        // The global arm requires event_id IS NULL, not just is_global. The
        // bug fixed here left legacy rows behind on upgraded instances —
        // event-owned AND is_global true, because the column defaults true —
        // and matching on the flag alone would let one event's leftover row be
        // adopted by another event's restore, tying photos to a category that
        // vanishes with someone else's gallery.
        // Two event-scoped categories CAN share a display name when their
        // slugs differ, and .first() would then pick one arbitrarily — both
        // manifest names collapse onto a single id and half the photos
        // inherit the wrong per-category settings (allow_downloads above all).
        // Resolving that properly needs a stable category identifier in the
        // manifest, which is a writer change and an archive-format bump, and
        // could not help any archive already written. So: surface it instead
        // of fixing it blind. If this never fires in real logs, the format
        // change is not worth making; if it does, this is the evidence for it.
        const ownRows = await db('photo_categories')
          .where({ event_id: archive.id, name: categoryName })
          .select('id');
        if (ownRows.length > 1) {
          logger.warn(
            `Photos manifest: category name "${categoryName}" matches ${ownRows.length} rows in event `
            + `${archive.id}; picking the lowest id. Photos from the other row(s) will inherit its settings.`
          );
        }

        const existingCategory =
          // Lowest id, not engine order — an arbitrary-but-stable choice beats
          // a nondeterministic one, so a re-run lands the same way.
          (ownRows.length
            ? await db('photo_categories')
              .where('id', Math.min(...ownRows.map((r) => r.id)))
              .first()
            : null)
          || await db('photo_categories')
            .where('name', categoryName)
            .whereNull('event_id')
            .where('is_global', formatBoolean(true))
            .first();

        if (existingCategory) {
          categoriesMap.set(categoryName, existingCategory.id);
        } else {
          const insertResult = await db('photo_categories').insert({
            event_id: archive.id,
            name: categoryName,
            slug: slugify(categoryName),
            // Explicit: the column defaults to true, and a restore inventing a
            // GLOBAL category would leak this event's naming into every other
            // gallery. Anything created here belongs to this event alone.
            is_global: formatBoolean(false),
            created_at: new Date()
          }).returning('id');

          categoriesMap.set(categoryName, insertResult[0]?.id || insertResult[0]);
        }

        return categoriesMap.get(categoryName);
      };

      for (const entry of entries) {
        if (!entry.isDirectory && entry.name.match(/\.(jpg|jpeg|png|gif|webp)$/i)) {
          const filename = path.basename(entry.name);
          const dirPath = path.dirname(entry.name);
          const actualFilePath = path.join(eventDir, entry.name);
          
          try {
            // Check if file was extracted successfully
            const stats = await fs.stat(actualFilePath);

            const manifestEntry = manifestByFilename.get(filename);

            // The manifest is the only faithful source for the category, and
            // it is authoritative INCLUDING when it says "none". A manifest
            // entry with a null category_name means the photo was genuinely
            // uncategorized, so falling through to the directory would
            // contradict the very record being restored from.
            //
            // That matters because the directory is not a category. Archive
            // entry names are the storage key minus `events/active/{slug}`,
            // and that layout is `individual/{filename}` / `collages/…` —
            // categories have never been directories there. Reading the first
            // path segment on a real archive therefore invents categories
            // literally named "individual" and "collages".
            //
            // So the fallback is confined to photos with NO manifest entry at
            // all: archives written before the manifest existed, where the
            // directory is the only signal left and inventing those two names
            // is still better than losing every category.
            // Check if photo already exists in database
            const existingPhoto = await db('photos')
              .where('event_id', archive.id)
              .where('filename', filename)
              .first();

            if (!existingPhoto) {
              // Resolved HERE, not above: resolveCategoryId find-or-CREATES,
              // and archiveEvent retains photo rows. Resolving before this
              // check meant restoring an archive whose rows still exist
              // created a category from the stale manifest name that nothing
              // then used — so renaming a category while its event was
              // archived left the old name behind as an empty duplicate.
              let categoryId = null;
              if (manifestEntry) {
                categoryId = await resolveCategoryId(manifestEntry.category_name);
              } else if (dirPath && dirPath !== '.') {
                categoryId = await resolveCategoryId(dirPath.split(path.sep)[0]);
              }

              // Store relative path from storage root
              const relativePath = path.relative(storagePath, actualFilePath);
              extractedPhotos.push({
                event_id: archive.id,
                filename: filename,
                // Recover original_filename from the manifest if present;
                // legacy archives without a manifest lose nothing (filename
                // is what they had before).
                original_filename: manifestEntry?.original_filename || filename,
                path: relativePath,
                thumbnail_path: null, // Will be regenerated by thumbnail service
                type: path.extname(filename).substring(1).toLowerCase(),
                size_bytes: stats.size,
                category_id: categoryId,
                uploaded_at: new Date().toISOString()
              });
            }
          } catch (statError) {
            logger.error(`Failed to stat file: ${actualFilePath}`);
            logger.error(`Entry name was: ${entry.name}`);
            logger.error('Error:', statError.message);
            // Skip this file if we can't stat it
            continue;
          }
        }
      }
      
      // Insert new photos if any
      if (extractedPhotos.length > 0) {
        await db('photos').insert(extractedPhotos);
      }
      
    } catch (extractError) {
      logger.error('Archive extraction error:', extractError);
      return res.status(500).json({ error: 'Failed to extract archive: ' + extractError.message });
    }
    
    // Update event status
    const thirtyDaysFromNow = new Date();
    thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);
    
    await db('events')
      .where('id', req.params.id)
      .update({
        is_archived: false,
        is_active: true,
        archive_path: null,
        archived_at: null,
        expires_at: thirtyDaysFromNow.toISOString() // Reset expiration - works on both DBs
      });

    // Log activity
    await db('activity_logs').insert({
      activity_type: 'archive_restored',
      actor_type: 'admin',
      actor_id: req.admin.id,
      actor_name: req.admin.username,
      event_id: archive.id,
      metadata: JSON.stringify({ event_name: archive.event_name })
    });

    res.json({ message: 'Archive restored successfully' });
  } catch (error) {
    logger.error('Archive restore error:', error);
    res.status(500).json({ error: 'Failed to restore archive' });
  }
});

// Download archive
router.get('/:id/download', adminAuth, requirePermission('archives.download'), requireEventOwnership, async (req, res) => {
  try {
    const archive = await db('events')
      .where('id', req.params.id)
      .where('is_archived', formatBoolean(true))
      .first();

    if (!archive) {
      return res.status(404).json({ error: 'Archive not found' });
    }

    if (!archive.archive_path) {
      return res.status(404).json({ error: 'Archive file not found' });
    }

    // Check if file exists
    const storagePath = process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');
    const fullArchivePath = path.join(storagePath, archive.archive_path);
    
    try {
      await fs.access(fullArchivePath);
    } catch (error) {
      return res.status(404).json({ error: 'Archive file not found on disk' });
    }

    // Set headers for download
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${archive.slug}.zip"`);

    // Stream the file
    const fileStream = require('fs').createReadStream(fullArchivePath);
    fileStream.pipe(res);

    // Log download
    await db('activity_logs').insert({
      activity_type: 'archive_downloaded',
      actor_type: 'admin',
      actor_id: req.admin.id,
      actor_name: req.admin.username,
      event_id: archive.id,
      metadata: JSON.stringify({ event_name: archive.event_name })
    });
  } catch (error) {
    logger.error('Archive download error:', error);
    res.status(500).json({ error: 'Failed to download archive' });
  }
});

// Delete archive permanently
router.delete('/:id', adminAuth, requirePermission('archives.delete'), requireEventOwnership, async (req, res) => {
  try {
    const archive = await db('events')
      .where('id', req.params.id)
      .where('is_archived', formatBoolean(true))
      .first();

    if (!archive) {
      return res.status(404).json({ error: 'Archive not found' });
    }

    // Delete archive file if exists
    if (archive.archive_path) {
      try {
        const storagePath = process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');
        const fullArchivePath = path.join(storagePath, archive.archive_path);
        await fs.unlink(fullArchivePath);
      } catch (error) {
        logger.error('Failed to delete archive file:', error);
      }
    }

    // Delete thumbnails for this event
    const photos = await db('photos').where('event_id', req.params.id).select('thumbnail_path');
    const storagePath = process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');
    
    for (const photo of photos) {
      if (photo.thumbnail_path) {
        try {
          const thumbPath = path.join(storagePath, photo.thumbnail_path.replace(/^\//, ''));
          await fs.unlink(thumbPath);
        } catch (error) {
          // Ignore errors - thumbnail might already be deleted
        }
      }
    }

    // Face data (#1074, #1132). This route deletes the event row directly and
    // relies on the FK cascade, but SQLite only honours ON DELETE CASCADE with
    // `PRAGMA foreign_keys = ON`, which PicPeak does not set — and
    // event_people_merge_dismissals has no event FK at all, on either engine.
    // archiveEvent's purge step is deliberately nonfatal, so an event can
    // still be carrying face data when it reaches this permanent delete.
    // Delete explicitly, the same way deleteEventCascade does.
    await db('photo_faces').where('event_id', req.params.id).del();
    await db('event_people').where('event_id', req.params.id).del();
    if (await db.schema.hasTable('event_people_merge_dismissals')) {
      await db('event_people_merge_dismissals').where('event_id', req.params.id).del();
    }

    // Delete from database (cascade will delete photos and logs)
    await db('events').where('id', req.params.id).delete();

    // Log activity
    await db('activity_logs').insert({
      activity_type: 'archive_deleted',
      actor_type: 'admin',
      actor_id: req.admin.id,
      actor_name: req.admin.username,
      metadata: JSON.stringify({ 
        event_name: archive.event_name,
        archived_date: archive.archived_at 
      })
    });

    res.json({ message: 'Archive deleted permanently' });
  } catch (error) {
    logger.error('Archive delete error:', error);
    res.status(500).json({ error: 'Failed to delete archive' });
  }
});

module.exports = router;