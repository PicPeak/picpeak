const router = require('express').Router();
// Keep route order stable; each router owns one gallery responsibility.
router.use(require('./gallery/metadata'));
router.use(require('./gallery/slideshow'));
router.use(require('./gallery/photos'));
router.use(require('./gallery/downloads'));
router.use(require('./gallery/purchasedDownloads'));
router.use(require('./gallery/snipcart'));
router.use(require('./gallery/media'));
router.use(require('./gallery/stats'));
router.use(require('./gallery/uploads'));
router.use(require('./gallery/styles'));
module.exports = router;
