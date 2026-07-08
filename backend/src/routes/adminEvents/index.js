// adminEvents router — decomposed move-code refactor of the original
// routes/adminEvents.js god file. Each sub-module attaches its routes onto the
// shared router below. CRITICAL: the require(...)(router) calls preserve the
// original registration order — Express matches in registration order, so
// literal segments and '/:id' patterns must keep their relative positions.

const express = require('express');

const router = express.Router();

require('./crud')(router);
require('./slideshow')(router);
require('./resets')(router);
require('./archiveBulk')(router);
require('./logo')(router);

module.exports = router;
