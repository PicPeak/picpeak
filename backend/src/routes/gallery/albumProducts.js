'use strict';
const express = require('express'),
  crypto = require('crypto');
const { body, param } = require('express-validator');
const {
  verifyGalleryAccess,
  denySlideshowToken,
} = require('../../middleware/gallery');
const { blockHiddenGallery } = require('../../utils/revealMode');
const { requireFeatureFlag } = require('../../middleware/requireFeatureFlag');
const { handleAsync, validateRequest } = require('../../utils/routeHelpers');
const { ForbiddenError } = require('../../utils/errors');
const { pipeStreamToResponse } = require('../../utils/streamResponse');
const service = () =>
  require('../../services/albumProducts/service').application();
const router = express.Router();
router.use(
  '/:slug/album-products',
  verifyGalleryAccess,
  denySlideshowToken,
  blockHiddenGallery,
  requireFeatureFlag('albumProducts'),
  (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    if (req.accessLevel !== 'client' && !req.viaCustomer && !req.isAdminPreview)
      return next(new ForbiddenError('Client access is required'));
    next();
  },
);
router.get(
  '/:slug/album-products',
  handleAsync(async (req, res) =>
    res.json({ offers: await service().clientOffers(req.event.id) }),
  ),
);
router.get(
  '/:slug/album-products/images/:imageId',
  param('imageId').isUUID(),
  handleAsync(async (req, res) => {
    validateRequest(req);
    const image = await service().clientImage(req.event.id, req.params.imageId);
    res.type('png');
    pipeStreamToResponse(
      await require('../../services/storage')
        .getStorage()
        .get(image.storage_key),
      res,
      { context: 'gallery album option image' },
    );
  }),
);
router.put(
  '/:slug/album-products/:id',
  param('id').isUUID(),
  body('revision').isInt({ min: 1 }),
  body('mutationId').isUUID(),
  body('modelId').optional().isUUID(),
  body('colourId').optional().isUUID(),
  body('values').optional().isObject(),
  body('productVersion').isHexadecimal().isLength({ min: 64, max: 64 }),
  body('name').isString().trim().isLength({ min: 1, max: 100 }),
  body('submit').isBoolean(),
  handleAsync(async (req, res) => {
    validateRequest(req);
    if (req.isAdminPreview)
      throw new ForbiddenError('Admin preview cannot make a client choice');
    // Record a digest of the authenticated session, never its bearer token.
    const id = crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          event: req.event.id,
          jti: req.galleryAccess?.session?.jti || null,
          customer: req.galleryAccess?.session?.customerId || null,
          issuedAt: req.galleryAccess?.session?.iat || null,
          parent: req.galleryAccess?.session?.parentJti || null,
        }),
      )
      .digest('hex');
    res.json(
      await service().mutate(
        req.event,
        {
          id: req.params.id,
          revision: req.body.revision,
          mutationId: req.body.mutationId,
          productVersion: req.body.productVersion,
          values: req.body.values,
          modelId: req.body.modelId,
          colourId: req.body.colourId,
          submit: req.body.submit,
        },
        {
          type: 'client',
          id,
          name: require('../../services/albumProducts/validation').text(
            req.body.name,
            100,
            true,
          ),
        },
      ),
    );
  }),
);
module.exports = router;
