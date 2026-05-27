const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const { db } = require('../database/db');
const { formatBoolean } = require('../utils/dbCompat');
const { slugify } = require('../utils/slug');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const archiver = require('archiver');
const AdmZip = require('adm-zip');
const { requireEventOwnership } = require('../middleware/ownership');
const router = express.Router();

// Get all archived events
router.get('/', adminAuth, requirePermission('archives.view'), async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

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
          console.error(`Archive file not found: ${archive.archive_path}`);
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
    console.error('Archives list error:', error);
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
        console.error('Archive file not found:', error);
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
    console.error('Archive details error:', error);
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
      const zip = new AdmZip(fullArchivePath);
      const eventsDir = path.join(storagePath, 'events/active');
      const eventDir = path.join(eventsDir, archive.slug);
      
      // Create event directory if it doesn't exist
      await fs.mkdir(eventDir, { recursive: true });
      
      // Log ZIP contents for debugging
      console.log(`Extracting archive to: ${eventDir}`);
      const entries = zip.getEntries();
      console.log(`Archive contains ${entries.length} entries`);
      
      // Extract files to the event directory
      zip.extractAllTo(eventDir, true);
      
      // Get list of extracted files to update database
      const extractedPhotos = [];
      
      // First, collect all category information from the ZIP structure
      const categoriesMap = new Map();
      
      for (const entry of entries) {
        if (!entry.isDirectory && entry.entryName.match(/\.(jpg|jpeg|png|gif|webp)$/i)) {
          const filename = path.basename(entry.entryName);
          const dirPath = path.dirname(entry.entryName);
          const actualFilePath = path.join(eventDir, entry.entryName);
          
          try {
            // Check if file was extracted successfully
            const stats = await fs.stat(actualFilePath);
            
            // Determine category from directory structure
            let categoryId = null;
            if (dirPath && dirPath !== '.') {
              // Get the first level directory as category
              const categoryName = dirPath.split(path.sep)[0];
              
              if (!categoriesMap.has(categoryName)) {
                // Check if this category exists in the database
                const existingCategory = await db('photo_categories')
                  .where('event_id', archive.id)
                  .where('name', categoryName)
                  .first();
                
                if (existingCategory) {
                  categoriesMap.set(categoryName, existingCategory.id);
                } else {
                  // Create the category if it doesn't exist
                  const insertResult = await db('photo_categories').insert({
                    event_id: archive.id,
                    name: categoryName,
                    slug: slugify(categoryName),
                    created_at: new Date()
                  }).returning('id');
                  
                  const newCategoryId = insertResult[0]?.id || insertResult[0];
                  categoriesMap.set(categoryName, newCategoryId);
                }
              }
              
              categoryId = categoriesMap.get(categoryName);
            }
          
            // Check if photo already exists in database
            const existingPhoto = await db('photos')
              .where('event_id', archive.id)
              .where('filename', filename)
              .first();
            
            if (!existingPhoto) {
              // Store relative path from storage root
              const relativePath = path.relative(storagePath, actualFilePath);
              extractedPhotos.push({
                event_id: archive.id,
                filename: filename,
                original_filename: filename,
                path: relativePath,
                thumbnail_path: null, // Will be regenerated by thumbnail service
                type: path.extname(filename).substring(1).toLowerCase(),
                size_bytes: stats.size,
                category_id: categoryId,
                uploaded_at: new Date()
              });
            }
          } catch (statError) {
            console.error(`Failed to stat file: ${actualFilePath}`);
            console.error(`Entry name was: ${entry.entryName}`);
            console.error('Error:', statError.message);
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
      console.error('Archive extraction error:', extractError);
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
    console.error('Archive restore error:', error);
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
    console.error('Archive download error:', error);
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
        console.error('Failed to delete archive file:', error);
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
    console.error('Archive delete error:', error);
    res.status(500).json({ error: 'Failed to delete archive' });
  }
});

module.exports = router;