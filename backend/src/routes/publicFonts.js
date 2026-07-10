const express = require('express');
const { listFonts } = require('../services/fontsService');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * GET /api/public/fonts
 *
 * Returns the list of self-hosted font families discovered under
 * STORAGE_PATH/fonts/. No authentication — gallery visitors need this
 * to render the chosen theme font.
 */
router.get('/', async (req, res) => {
  try {
    const fonts = await listFonts();
    res.json({ fonts });
  } catch (error) {
    logger.error('Failed to list fonts', { error: error.message });
    res.status(500).json({ error: 'Failed to list fonts' });
  }
});

module.exports = router;
