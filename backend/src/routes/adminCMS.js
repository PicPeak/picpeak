const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const multer = require('multer');
const { body, validationResult } = require('express-validator');
const { db, logActivity } = require('../database/db');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { validateFileType } = require('../utils/fileSecurityUtils');
const router = express.Router();

const getStoragePath = () => process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');

// Multer config for per-page logo uploads. Stores into the same
// /uploads/logos directory the global branding logo uses, with a
// per-slug filename so a page swap doesn't fight an unrelated upload.
const pageLogoStorage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    const dir = path.join(getStoragePath(), 'uploads/logos');
    await fs.mkdir(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const safeSlug = (req.params.slug || 'page').replace(/[^a-z0-9-]/gi, '');
    cb(null, `cms-${safeSlug}-${Date.now()}${ext}`);
  }
});

const pageLogoUpload = multer({
  storage: pageLogoStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/svg+xml'];
    if (validateFileType(file.originalname, file.mimetype, allowed)) cb(null, true);
    else cb(new Error('Only JPEG, PNG, GIF and SVG image files are allowed'));
  }
});

// Get all CMS pages
router.get('/pages', adminAuth, requirePermission('cms.view'), async (req, res) => {
  try {
    const pages = await db('cms_pages').select('*').orderBy('slug', 'asc');
    res.json(pages);
  } catch (error) {
    console.error('Error fetching CMS pages:', error);
    res.status(500).json({ error: 'Failed to fetch pages' });
  }
});

// Get a single CMS page
router.get('/pages/:slug', adminAuth, requirePermission('cms.view'), async (req, res) => {
  try {
    const { slug } = req.params;
    const page = await db('cms_pages').where('slug', slug).first();

    if (!page) {
      return res.status(404).json({ error: 'Page not found' });
    }

    res.json(page);
  } catch (error) {
    console.error('Error fetching CMS page:', error);
    res.status(500).json({ error: 'Failed to fetch page' });
  }
});

// Update a CMS page
router.put('/pages/:slug', adminAuth, requirePermission('cms.edit'), [
  body('title_en').optional().isString(),
  body('title_de').optional().isString(),
  body('content_en').optional().isString(),
  body('content_de').optional().isString(),
  body('logo_url').optional({ nullable: true }).isString(),
  body('use_external_url').optional().isBoolean(),
  body('external_url').optional({ nullable: true }).isString(),
  body('show_in_footer').optional().isBoolean()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { slug } = req.params;
    const { title_en, title_de, content_en, content_de, logo_url, use_external_url, external_url } = req.body;

    // When the external-URL toggle is on, the URL must parse and use https://.
    // express-validator's isURL() is too permissive (allows http:, ftp:, etc.) —
    // an explicit protocol check is the security-relevant gate.
    if (use_external_url === true) {
      const candidate = typeof external_url === 'string' ? external_url.trim() : '';
      if (!candidate) {
        return res.status(400).json({ error: 'external_url is required when use_external_url is true' });
      }
      let parsed;
      try {
        parsed = new URL(candidate);
      } catch (_err) {
        return res.status(400).json({ error: 'external_url must be a valid URL' });
      }
      if (parsed.protocol !== 'https:') {
        return res.status(400).json({ error: 'external_url must use https://' });
      }
    }

    const page = await db('cms_pages').where('slug', slug).first();
    if (!page) {
      return res.status(404).json({ error: 'Page not found' });
    }

    const updateFields = {
      title_en,
      title_de,
      content_en,
      content_de,
      updated_at: new Date()
    };
    // Only touch logo_url when explicitly present so partial updates
    // (e.g. text-only edits) don't accidentally clear the upload.
    if (Object.prototype.hasOwnProperty.call(req.body, 'logo_url')) {
      updateFields.logo_url = logo_url || null;
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'use_external_url')) {
      updateFields.use_external_url = !!use_external_url;
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'external_url')) {
      const trimmed = typeof external_url === 'string' ? external_url.trim() : '';
      updateFields.external_url = trimmed || null;
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'show_in_footer')) {
      updateFields.show_in_footer = !!req.body.show_in_footer;
    }

    await db('cms_pages').where('slug', slug).update(updateFields);

    const updated = await db('cms_pages').where('slug', slug).first();

    await logActivity('cms_page_updated',
      { page: slug },
      null,
      { type: 'admin', id: req.admin.id, name: req.admin.username }
    );

    res.json(updated);
  } catch (error) {
    console.error('Error updating CMS page:', error);
    res.status(500).json({ error: 'Failed to update page' });
  }
});

// Upload a per-page logo (#324). Persists the URL to cms_pages.logo_url
// and returns it so the client can re-render without a refetch.
router.post(
  '/pages/:slug/logo',
  adminAuth,
  requirePermission('cms.edit'),
  pageLogoUpload.single('logo'),
  async (req, res) => {
    try {
      const { slug } = req.params;
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const page = await db('cms_pages').where('slug', slug).first();
      if (!page) {
        // Best-effort cleanup of the orphaned upload before erroring.
        await fs.unlink(req.file.path).catch(() => {});
        return res.status(404).json({ error: 'Page not found' });
      }

      const logoUrl = `/uploads/logos/${path.basename(req.file.path)}`;
      await db('cms_pages').where('slug', slug).update({
        logo_url: logoUrl,
        updated_at: new Date()
      });

      await logActivity('cms_page_logo_uploaded',
        { page: slug },
        null,
        { type: 'admin', id: req.admin.id, name: req.admin.username }
      );

      res.json({ logo_url: logoUrl });
    } catch (error) {
      console.error('Error uploading CMS page logo:', error);
      res.status(500).json({ error: 'Failed to upload logo' });
    }
  }
);

// Clear a per-page logo override (revert to global branding logo).
router.delete(
  '/pages/:slug/logo',
  adminAuth,
  requirePermission('cms.edit'),
  async (req, res) => {
    try {
      const { slug } = req.params;
      const page = await db('cms_pages').where('slug', slug).first();
      if (!page) return res.status(404).json({ error: 'Page not found' });

      await db('cms_pages').where('slug', slug).update({
        logo_url: null,
        updated_at: new Date()
      });

      res.json({ logo_url: null });
    } catch (error) {
      console.error('Error clearing CMS page logo:', error);
      res.status(500).json({ error: 'Failed to clear logo' });
    }
  }
);

module.exports = router;
