/**
 * OG/Twitter-card preview for PicTransfer links (#997).
 *
 * Crawlers (WhatsApp, Slack, iMessage, …) don't run JS, so without this a
 * `/transfer/<token>` or `/transfer-upload/<token>` link fell through to the
 * SPA's index.html and previewed as the env-baked BRAND_TITLE /
 * BRAND_DESCRIPTION ("PicPeak — Photo gallery shared with PicPeak.") instead
 * of the transfer's name and the studio's tagline.
 *
 * Only the 64-hex token is resolved. The upload page also accepts the short
 * read-aloud code, but that lookup is guarded by a per-network bad-attempt
 * lockout in publicTransferUpload; resolving it here would hand guessers an
 * unthrottled oracle, so short codes always get the generic card.
 *
 * Exposes the transfer TITLE only — never the message, file names or sizes.
 * The title is already shown to anyone holding the link, which is the only
 * secret. Disabled, expired and capped transfers (and the whole module when
 * the `transfers` flag is off) get the generic branded card instead.
 */

const logger = require('../utils/logger');
const { getAbsoluteFrontendUrl } = require('../utils/frontendUrl');
const { isFeatureEnabled } = require('../middleware/requireFeatureFlag');
const transferService = require('./transferService');
const { fetchBranding, absoluteUrl, renderOgHtml } = require('./galleryOgService');
const { previewLanguage, ogText } = require('./ogText');

const LONG_TOKEN_RE = /^[a-f0-9]{64}$/;

const KINDS = {
  send: {
    pathPrefix: '/transfer',
    resolve: (token) => transferService.getTransferByToken(token),
    usable: (t) => transferService.assertDownloadable(t).ok,
    descriptionKey: 'filesShared',
    linkLabelKey: 'viewFiles',
  },
  request: {
    pathPrefix: '/transfer-upload',
    resolve: (token) => transferService.getRequestByToken(token),
    usable: (t) => transferService.assertUploadable(t).ok,
    descriptionKey: 'uploadHere',
    linkLabelKey: 'uploadFiles',
  },
};

async function buildTransferOgMetadata(kind, token) {
  const cfg = KINDS[kind];
  const branding = await fetchBranding();
  const base = await getAbsoluteFrontendUrl();
  const language = await previewLanguage();
  const siteName = branding.companyName || 'PicPeak';
  const image = absoluteUrl(branding.logoUrl, base) || `${base}/picpeak-logo-transparent.png`;

  let transfer = null;
  if (LONG_TOKEN_RE.test(token) && await isFeatureEnabled('transfers')) {
    const row = await cfg.resolve(token);
    if (row && cfg.usable(row)) transfer = row;
  }

  const name = transfer && transfer.title ? String(transfer.title).trim() : '';
  const title = name && name !== siteName ? `${name} — ${siteName}` : siteName;

  return {
    title,
    description: branding.companyTagline || ogText(language, cfg.descriptionKey),
    image,
    url: `${base}${cfg.pathPrefix}/${token}`,
    siteName,
    linkLabel: ogText(language, cfg.linkLabelKey),
    language,
  };
}

function handleTransferOgRequest(kind) {
  return async (req, res) => {
    try {
      const { token } = req.params;
      if (!token || !/^[A-Za-z0-9]{4,64}$/.test(token)) {
        res.status(400).type('text/plain').send('Invalid transfer token');
        return;
      }
      const meta = await buildTransferOgMetadata(kind, token);
      // Short cache + no shared caching of the token URL by intermediaries.
      res.set('Cache-Control', 'private, max-age=300');
      res.set('X-Robots-Tag', 'noindex, nofollow');
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(renderOgHtml(meta));
    } catch (error) {
      logger.error('Failed to render transfer OG page', { error: error.message });
      res.status(500).type('text/plain').send('Internal server error');
    }
  };
}

module.exports = {
  buildTransferOgMetadata,
  handleTransferOgRequest,
};
