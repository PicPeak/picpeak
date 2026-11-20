// Gallery QR codes (#836): QR image (PNG/SVG) for the event's share link and
// print-ready PDF templates (table card A6, poster A4) built with pdfkit.
// `?variant=code` (issue 2495) prints the fixed /code entry page as the QR
// plus the event code, so one QR design serves every event.
// Registered after ./logo in ./index.js — all routes are '/:id/...' literals,
// so registration order relative to the other sub-modules is not sensitive.

const path = require('path');
const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');
const { db } = require('../../database/db');
const { adminAuth } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permissions');
const { requireEventOwnership } = require('../../middleware/ownership');
const { buildShareLinkVariants, getEventShareToken } = require('../../services/shareLinkService');
const { getFrontendBaseUrl } = require('../../utils/frontendUrl');
const { eventCodesEnabled, formatAccessCode } = require('../../services/eventAccessCode');
const logger = require('../../utils/logger');
const { errorResponse } = require('../../utils/routeHelpers');

// Caption under the QR on the print templates, in the admin's UI language
// (passed as ?lang= by the frontend). Mirrors the 8 gallery locales.
const PRINT_CAPTIONS = {
  en: 'Scan to view & share your photos',
  de: 'Scannen, um Fotos anzusehen & zu teilen',
  es: 'Escanea para ver y compartir tus fotos',
  fr: 'Scannez pour voir et partager vos photos',
  nl: 'Scan om foto’s te bekijken & te delen',
  pt: 'Escaneie para ver e compartilhar suas fotos',
  ru: 'Отсканируйте, чтобы посмотреть и поделиться фото',
  sl: 'Skenirajte za ogled in deljenje fotografij',
};

// Caption of the event-code variant: the QR opens /code, the guest types
// the code printed below it.
const PRINT_CODE_CAPTIONS = {
  en: 'Scan and enter this code',
  de: 'Scannen und diesen Code eingeben',
  es: 'Escanea e introduce este código',
  fr: 'Scannez et saisissez ce code',
  nl: 'Scan en voer deze code in',
  pt: 'Escaneie e digite este código',
  ru: 'Отсканируйте и введите этот код',
  sl: 'Skenirajte in vnesite to kodo',
};

// A6 = 298 x 420 pt, A4 = 595 x 842 pt (pdfkit default unit).
const TEMPLATES = {
  'table-card': { size: [298, 420], qrSize: 180, titleSize: 16, captionSize: 10, urlSize: 7, codeSize: 30 },
  poster: { size: 'A4', qrSize: 360, titleSize: 28, captionSize: 16, urlSize: 10, codeSize: 64 },
};

// Bundled COMPLETE IBM Plex Sans (1019 glyphs: Latin + Cyrillic + Greek,
// verified via fontkit cmap) — pdfkit's built-in Helvetica is WinAnsi-only
// and silently drops e.g. Cyrillic event names, and the pre-existing
// assets/fonts/IBM-Plex-Sans/ files are 270-glyph Latin subsets with the
// same gap (codex review of #847). OFL license alongside the files.
const FONT_BOLD = path.join(__dirname, '../../../assets/fonts/IBM-Plex-Sans-Full/700.ttf');
const FONT_REGULAR = path.join(__dirname, '../../../assets/fonts/IBM-Plex-Sans-Full/400.ttf');

// A same-origin admin GET carries no Origin header, so the frontend passes
// window.location.origin explicitly. Only accept a plain http(s) origin.
const ORIGIN_RE = /^https?:\/\/[^\s/]+$/i;
// Configured FRONTEND_URL defaults to localhost on unconfigured installs —
// a QR pointing there is unusable on any other device (codex review of #847).
const LOCAL_BASE_RE = /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i;

function requestOriginOrNull(requestOrigin) {
  return typeof requestOrigin === 'string' && ORIGIN_RE.test(requestOrigin)
    ? requestOrigin.replace(/\/$/, '')
    : null;
}

// The fixed entry page, on the same base a relative share link resolves to.
async function codePageUrl(requestOrigin) {
  const base = requestOriginOrNull(requestOrigin) || (await getFrontendBaseUrl());
  return base ? `${base}/code` : '/code';
}

async function loadShareUrl(eventId, requestOrigin) {
  const event = await db('events').where({ id: eventId }).first();
  if (!event) return { event: null, shareUrl: null };

  // Single source of truth is the STORED share_link — exactly what the
  // ShareLinkCard displays and the admin copies. Rebuilding from the
  // current slug/token/short-URL setting can diverge for legacy absolute
  // links or events created under a different short-URL setting, and a
  // printed QR encoding a different URL than the card is a permanent
  // mistake (codex review of #847, confirmation round). Only when no
  // share_link is stored do we fall back to rebuilding it.
  let link = event.share_link;
  if (!link) {
    const shareToken = getEventShareToken(event);
    if (!shareToken) return { event, shareUrl: null };
    ({ shareLinkToStore: link } = await buildShareLinkVariants({ slug: event.slug, shareToken }));
  }

  const origin = requestOriginOrNull(requestOrigin);

  // Absolute + reachable → use as-is; loopback-absolute → re-anchor its
  // path; relative → absolutize. Mirrors the frontend's buildShareLinkUrl.
  if (/^https?:\/\//i.test(link) && !LOCAL_BASE_RE.test(link)) {
    return { event, shareUrl: link };
  }
  let sharePath = link;
  if (/^https?:\/\//i.test(link)) {
    try { const u = new URL(link); sharePath = `${u.pathname}${u.search}`; } catch { /* keep as-is */ }
  }
  // Bare stored values (quote-/contract-converted events persist the raw
  // token) resolve as /gallery/<token> — mirroring the frontend's
  // buildShareLinkUrl exactly (codex review of #847, final round).
  if (!sharePath.startsWith('/')) sharePath = `/gallery/${sharePath}`;
  if (origin) return { event, shareUrl: `${origin}${sharePath}` };
  const frontendBase = await getFrontendBaseUrl();
  return { event, shareUrl: frontendBase ? `${frontendBase}${sharePath}` : sharePath };
}

module.exports = (router) => {
  // QR image for the gallery share link.
  router.get('/:id/qr', adminAuth, requirePermission('events.view'), requireEventOwnership, async (req, res) => {
    try {
      const { event, shareUrl } = await loadShareUrl(req.params.id, req.query.origin);
      if (!event) return errorResponse(res, 'Event not found', 404);
      if (!shareUrl) return errorResponse(res, 'Event has no share link', 409);

      const format = req.query.format === 'svg' ? 'svg' : 'png';
      const download = req.query.download === '1';
      const disposition = `${download ? 'attachment' : 'inline'}; filename="qr-${event.slug}.${format}"`;

      if (format === 'svg') {
        const svg = await QRCode.toString(shareUrl, { type: 'svg', margin: 4 });
        res.set('Content-Type', 'image/svg+xml');
        res.set('Content-Disposition', disposition);
        return res.send(svg);
      }

      const width = Math.min(Math.max(parseInt(req.query.size, 10) || 600, 128), 2048);
      const png = await QRCode.toBuffer(shareUrl, { type: 'png', width, margin: 4 });
      res.set('Content-Type', 'image/png');
      res.set('Content-Disposition', disposition);
      return res.send(png);
    } catch (error) {
      logger.error('Failed to generate gallery QR code:', error);
      return errorResponse(res, error, 500, 'Failed to generate QR code');
    }
  });

  // Print-ready PDF (table card / poster) with QR + event name + caption.
  // variant=code: the QR encodes the fixed /code page and the event code is
  // printed under it. The code leads to the share link, so it is gated by the
  // same ownership check as the link itself.
  router.get('/:id/qr-print', adminAuth, requirePermission('events.view'), requireEventOwnership, async (req, res) => {
    try {
      const codeVariant = req.query.variant === 'code';
      const { event, shareUrl } = await loadShareUrl(req.params.id, req.query.origin);
      if (!event) return errorResponse(res, 'Event not found', 404);

      let qrUrl = shareUrl;
      let accessCode = null;
      if (codeVariant) {
        if (!(await eventCodesEnabled())) {
          return res.status(409).json({ error: 'Event codes are switched off', code: 'EVENT_CODES_DISABLED' });
        }
        if (!event.access_code) {
          return res.status(409).json({ error: 'Event has no event code', code: 'EVENT_HAS_NO_CODE' });
        }
        accessCode = formatAccessCode(event.access_code);
        qrUrl = await codePageUrl(req.query.origin);
      } else if (!shareUrl) {
        return errorResponse(res, 'Event has no share link', 409);
      }

      const templateKey = TEMPLATES[req.query.template] ? req.query.template : 'table-card';
      const tpl = TEMPLATES[templateKey];
      const captions = codeVariant ? PRINT_CODE_CAPTIONS : PRINT_CAPTIONS;
      const caption = captions[req.query.lang] || captions.en;

      const qrPng = await QRCode.toBuffer(qrUrl, { type: 'png', width: tpl.qrSize * 3, margin: 4 });

      const doc = new PDFDocument({
        size: tpl.size,
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        info: { Title: `PicPeak QR — ${event.event_name}` },
      });
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `attachment; filename="qr-${codeVariant ? 'code-' : ''}${templateKey}-${event.slug}.pdf"`);
      doc.pipe(res);

      const pageWidth = doc.page.width;
      const pageHeight = doc.page.height;
      const contentTop = pageHeight * 0.12;

      // Fixed vertical layout: the title gets a bounded two-line region with
      // ellipsis so an arbitrarily long event name can't push the QR/caption
      // over the footer or off the page (codex review of #847). All positions
      // below derive from constants, never from doc.y.
      const titleBlockHeight = tpl.titleSize * 2.6;
      doc.font(FONT_BOLD).fontSize(tpl.titleSize).fillColor('#1a1a1a')
        .text(event.event_name, pageWidth * 0.1, contentTop, {
          width: pageWidth * 0.8,
          align: 'center',
          height: titleBlockHeight,
          ellipsis: true,
        });

      const qrX = (pageWidth - tpl.qrSize) / 2;
      const qrY = contentTop + titleBlockHeight + tpl.titleSize * 0.5;
      doc.image(qrPng, qrX, qrY, { width: tpl.qrSize, height: tpl.qrSize });

      const captionY = qrY + tpl.qrSize + tpl.captionSize;
      doc.font(FONT_REGULAR).fontSize(tpl.captionSize).fillColor('#333333')
        .text(caption, pageWidth * 0.1, captionY, { width: pageWidth * 0.8, align: 'center' });

      if (accessCode) {
        doc.font(FONT_BOLD).fontSize(tpl.codeSize).fillColor('#1a1a1a')
          .text(accessCode, pageWidth * 0.05, captionY + tpl.captionSize * 2, {
            width: pageWidth * 0.9,
            align: 'center',
            characterSpacing: tpl.codeSize * 0.08,
            lineBreak: false,
          });
      }

      doc.font(FONT_REGULAR).fontSize(tpl.urlSize).fillColor('#888888')
        .text(qrUrl, pageWidth * 0.05, pageHeight - pageHeight * 0.07, {
          width: pageWidth * 0.9,
          align: 'center',
          height: pageHeight * 0.06,
          ellipsis: true,
        });

      doc.end();
    } catch (error) {
      logger.error('Failed to generate QR print PDF:', error);
      if (!res.headersSent) return errorResponse(res, error, 500, 'Failed to generate QR print PDF');
      return res.end();
    }
  });
};
