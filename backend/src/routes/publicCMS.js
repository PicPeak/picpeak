const express = require('express');
const { db } = require('../database/db');
const router = express.Router();

// Get public CMS page
router.get('/pages/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const { lang = 'en' } = req.query;
    
    const page = await db('cms_pages').where('slug', slug).first();
    
    if (!page) {
      return res.status(404).json({ error: 'Page not found' });
    }
    
    // Return the appropriate language version
    const title = lang === 'de' ? page.title_de : page.title_en;
    const content = lang === 'de' ? page.content_de : page.content_en;
    
    res.json({
      title,
      content,
      slug: page.slug,
      // Per-page logo override (#324). Null means "fall back to global
      // branding logo" — the consumer decides.
      logo_url: page.logo_url || null,
      // Per-page external-URL override. When use_external_url is true and
      // external_url is set, consumers should redirect / link out instead
      // of rendering the internal title/content. external_url is gated by
      // use_external_url so the public response never exposes a URL the
      // admin has saved-but-disabled (the value stays in the DB so the
      // toggle can be flipped back on, but it shouldn't leak via the API).
      use_external_url: !!page.use_external_url,
      external_url: page.use_external_url && page.external_url ? page.external_url : null,
      // Footer visibility (#441). Default true for legacy rows; admins
      // can hide a CMS page from the gallery footer when their
      // jurisdiction doesn't require it (e.g. impressum / datenschutz
      // outside DE/AT).
      show_in_footer: page.show_in_footer !== false,
      updated_at: page.updated_at
    });
  } catch (error) {
    console.error('Error fetching public CMS page:', error);
    res.status(500).json({ error: 'Failed to fetch page' });
  }
});

module.exports = router;