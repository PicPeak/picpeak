/**
 * Public → Transfer download routes (PicTransfer, #997).
 *
 * Mounted at /api/public/transfer. NO authentication — the 64-hex token in the
 * recipient's link is the only secret. The recipient page has NO thumbnails by
 * design; this API exposes filenames + sizes only, never image URLs.
 *
 * Surface:
 *   GET /:token                 metadata view (title, message, file list, expiry)
 *   GET /:token/download        ZIP of all ORIGINAL files
 *   GET /:token/download/:fileId  single ORIGINAL file
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { param } = require('express-validator');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const { requireFeatureFlag } = require('../middleware/requireFeatureFlag');
const { clientIpForAudit } = require('../utils/clientIp');
const transferService = require('../services/transferService');

const router = express.Router();

// Belt-and-braces: a recipient link must stop resolving the moment an admin
// turns PicTransfer off under Settings → Features, same as every other gated
// module. The token is still the only secret; this just fails closed.
router.use(requireFeatureFlag('transfers'));

const viewLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
const downloadLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });

const tokenValidator = [param('token').isString().isLength({ min: 64, max: 64 }).matches(/^[a-f0-9]+$/i)];

// Recipient view. Always resolves for a live (non-deleted) transfer so the page
// can render an "expired" state; file list is only included while downloadable.
router.get('/:token', viewLimiter, tokenValidator, handleAsync(async (req, res) => {
  validateRequest(req);
  const transfer = await transferService.getTransferByToken(req.params.token);
  if (!transfer) return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });

  const gate = transferService.assertDownloadable(transfer);
  if (!gate.ok) {
    return successResponse(res, {
      transfer: {
        title: transfer.title || 'Transfer',
        status: gate.code === 'DOWNLOAD_LIMIT_REACHED' ? 'limit_reached' : 'expired',
        expires_at: transfer.expires_at,
        downloadable: false,
      },
    });
  }

  const view = await transferService.getPublicView(transfer);
  return successResponse(res, { transfer: { ...view, status: 'active', downloadable: true } });
}));

// Download all as a ZIP of originals.
router.get('/:token/download', downloadLimiter, tokenValidator, handleAsync(async (req, res) => {
  validateRequest(req);
  const transfer = await transferService.getTransferByToken(req.params.token);
  const gate = transferService.assertDownloadable(transfer);
  if (!gate.ok) {
    return res.status(gate.status).json({ error: 'This link is no longer available', code: gate.code });
  }
  // Claim the download BEFORE streaming: the claim is the cap check, so
  // concurrent requests cannot all pass a cap read from the same snapshot, and
  // a mid-stream disconnect still counts ("disable after N downloads").
  if (!(await transferService.claimDownload(transfer, { kind: 'all', ip: clientIpForAudit(req) }))) {
    return res.status(410).json({ error: 'This link is no longer available', code: 'DOWNLOAD_LIMIT_REACHED' });
  }
  await transferService.streamTransferArchive(transfer, res);
}));

// Download a single original file. The file id is prefixed — `p<id>` for a
// referenced gallery photo, `x<id>` for an admin-uploaded deliverable file (a
// bare number is tolerated as a photo id) — so the service reads the right table.
router.get('/:token/download/:fileId', downloadLimiter,
  [...tokenValidator, param('fileId').matches(/^[px]?[0-9]{1,15}$/i)],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const transfer = await transferService.getTransferByToken(req.params.token);
    const gate = transferService.assertDownloadable(transfer);
    if (!gate.ok) {
      return res.status(gate.status).json({ error: 'This link is no longer available', code: gate.code });
    }
    // Counted once the file is known to exist and before it streams, so
    // parallel requests cannot stream past the cap and a missing file does
    // not use up a download.
    let limitReached = false;
    const ok = await transferService.streamTransferFile(transfer, req.params.fileId, res, {
      beforeStream: async () => {
        const claimed = await transferService.claimDownload(transfer, {
          kind: 'single', photoId: null, ip: clientIpForAudit(req),
        });
        limitReached = !claimed;
        return claimed;
      },
    });
    if (limitReached && !res.headersSent) {
      return res.status(410).json({ error: 'This link is no longer available', code: 'DOWNLOAD_LIMIT_REACHED' });
    }
    if (!ok && !res.headersSent) {
      return res.status(404).json({ error: 'File not found', code: 'FILE_NOT_FOUND' });
    }
  }),
);

module.exports = router;
