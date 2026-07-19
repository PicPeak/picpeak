// Gallery QR codes (#836): QR image (PNG/SVG) for the event's share link and
// print-ready PDF templates (table card A6, poster A4) built with pdfkit.
// Registered after ./logo in ./index.js — all routes are '/:id/...' literals,
// so registration order relative to the other sub-modules is not sensitive.

const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');
const { db } = require('../../database/db');
const { adminAuth } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permissions');
const { requireEventOwnership } = require('../../middleware/ownership');
const { buildShareLinkVariants, getEventShareToken } = require('../../services/shareLinkService');
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

// A6 = 298 x 420 pt, A4 = 595 x 842 pt (pdfkit default unit).
const TEMPLATES = {
  'table-card': { size: [298, 420], qrSize: 180, titleSize: 16, captionSize: 10, urlSize: 7 },
  poster: { size: 'A4', qrSize: 360, titleSize: 28, captionSize: 16, urlSize: 10 },
};

async function loadShareUrl(eventId) {
  const event = await db('events').where({ id: eventId }).first();
  if (!event) return { event: null, shareUrl: null };
  const shareToken = getEventShareToken(event);
  if (!shareToken) return { event, shareUrl: null };
  const { shareUrl } = await buildShareLinkVariants({ slug: event.slug, shareToken });
  return { event, shareUrl };
}

module.exports = (router) => {
  // QR image for the gallery share link.
  router.get('/:id/qr', adminAuth, requirePermission('events.view'), requireEventOwnership, async (req, res) => {
    try {
      const { event, shareUrl } = await loadShareUrl(req.params.id);
      if (!event) return errorResponse(res, 'Event not found', 404);
      if (!shareUrl) return errorResponse(res, 'Event has no share link', 409);

      const format = req.query.format === 'svg' ? 'svg' : 'png';
      const download = req.query.download === '1';
      const disposition = `${download ? 'attachment' : 'inline'}; filename="qr-${event.slug}.${format}"`;

      if (format === 'svg') {
        const svg = await QRCode.toString(shareUrl, { type: 'svg', margin: 2 });
        res.set('Content-Type', 'image/svg+xml');
        res.set('Content-Disposition', disposition);
        return res.send(svg);
      }

      const width = Math.min(Math.max(parseInt(req.query.size, 10) || 600, 128), 2048);
      const png = await QRCode.toBuffer(shareUrl, { type: 'png', width, margin: 2 });
      res.set('Content-Type', 'image/png');
      res.set('Content-Disposition', disposition);
      return res.send(png);
    } catch (error) {
      logger.error('Failed to generate gallery QR code:', error);
      return errorResponse(res, error, 500, 'Failed to generate QR code');
    }
  });

  // Print-ready PDF (table card / poster) with QR + event name + caption.
  router.get('/:id/qr-print', adminAuth, requirePermission('events.view'), requireEventOwnership, async (req, res) => {
    try {
      const { event, shareUrl } = await loadShareUrl(req.params.id);
      if (!event) return errorResponse(res, 'Event not found', 404);
      if (!shareUrl) return errorResponse(res, 'Event has no share link', 409);

      const templateKey = TEMPLATES[req.query.template] ? req.query.template : 'table-card';
      const tpl = TEMPLATES[templateKey];
      const caption = PRINT_CAPTIONS[req.query.lang] || PRINT_CAPTIONS.en;

      const qrPng = await QRCode.toBuffer(shareUrl, { type: 'png', width: tpl.qrSize * 3, margin: 2 });

      const doc = new PDFDocument({
        size: tpl.size,
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        info: { Title: `PicPeak QR — ${event.event_name}` },
      });
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `attachment; filename="qr-${templateKey}-${event.slug}.pdf"`);
      doc.pipe(res);

      const pageWidth = doc.page.width;
      const pageHeight = doc.page.height;
      const contentTop = pageHeight * 0.12;

      // Helvetica has no Cyrillic glyphs — fall back to English for scripts
      // pdfkit's built-in fonts can't render.
      const printableCaption = /^[\u0020-\u024F\u2018-\u201F\u2026]*$/.test(caption) ? caption : PRINT_CAPTIONS.en;

      doc.font('Helvetica-Bold').fontSize(tpl.titleSize).fillColor('#1a1a1a')
        .text(event.event_name, pageWidth * 0.1, contentTop, { width: pageWidth * 0.8, align: 'center' });

      const qrX = (pageWidth - tpl.qrSize) / 2;
      const qrY = doc.y + tpl.titleSize;
      doc.image(qrPng, qrX, qrY, { width: tpl.qrSize, height: tpl.qrSize });

      doc.font('Helvetica').fontSize(tpl.captionSize).fillColor('#333333')
        .text(printableCaption, pageWidth * 0.1, qrY + tpl.qrSize + tpl.captionSize, { width: pageWidth * 0.8, align: 'center' });

      doc.font('Helvetica').fontSize(tpl.urlSize).fillColor('#888888')
        .text(shareUrl, pageWidth * 0.05, pageHeight - pageHeight * 0.07, { width: pageWidth * 0.9, align: 'center' });

      doc.end();
    } catch (error) {
      logger.error('Failed to generate QR print PDF:', error);
      if (!res.headersSent) return errorResponse(res, error, 500, 'Failed to generate QR print PDF');
      return res.end();
    }
  });
};
