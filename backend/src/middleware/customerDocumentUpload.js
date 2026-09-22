/**
 * Single-file multipart intake for customer documents (#1444), shared by the
 * portal route and the admin route.
 *
 * Modelled on routes/publicTransferUpload.js: the caller runs its auth,
 * feature and quota guards BEFORE calling this, multer writes into a temp
 * directory (never the final location, never under the uploaded name), and the
 * caller hands the file to customerDocumentsService, which checks the content,
 * moves it into storage, and the caller then removes the temp copy.
 *
 * The name and declared type are checked here only as a first filter,
 * against the formats the install accepts (services/documentFormats). The
 * content check in the service is the one that decides.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { getStoragePath } = require('../config/storage');
const { AppError } = require('../utils/errors');
const { buildContentDisposition } = require('../utils/filenameSanitizer');
const { pipeStreamToResponse } = require('../utils/streamResponse');

const { FORMATS, formatForName, contentTypeFor, formatForStorageKey } = require('../services/documentFormats');

const tempStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(getStoragePath(), 'temp', 'customer-documents');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${crypto.randomUUID()}.upload`);
  },
});

/**
 * Resolves with the multer file (or null when the request carried none) and
 * leaves the text fields on req.body. The file carries `documentFormat`, the
 * registry key its LAST extension selects. Rejects with an AppError carrying
 * a 4xx: FORMAT_NOT_ALLOWED when the extension is not one of
 * `allowedFormats`, or the declared type doesn't fit it.
 */
function receiveDocumentUpload(req, res, { maxBytes, allowedFormats = ['pdf'] }) {
  const upload = multer({
    storage: tempStorage,
    // Browsers send the filename as UTF-8; multer's latin1 default turns
    // "Müller.pdf" into "MÃ¼ller.pdf" in the display name.
    defParamCharset: 'utf8',
    // One `file` part and a few plain fields; no array-indexed field names.
    limits: { fileSize: maxBytes, files: 1, fields: 10, fieldArrayIndexLimit: 0 },
    fileFilter: (_req, file, cb) => {
      const format = formatForName(file.originalname);
      if (!format || !allowedFormats.includes(format) || !FORMATS[format].declaredTypes.has(file.mimetype || '')) {
        return cb(new AppError('This file type cannot be uploaded', 400, 'FORMAT_NOT_ALLOWED'));
      }
      // eslint-disable-next-line no-param-reassign
      file.documentFormat = format;
      return cb(null, true);
    },
  }).single('file');

  return new Promise((resolve, reject) => {
    upload(req, res, (err) => {
      if (!err) return resolve(req.file || null);
      if (err.code === 'LIMIT_FILE_SIZE') {
        const mb = Math.floor(maxBytes / (1024 * 1024));
        return reject(new AppError(`The file must be ${mb} MB or smaller`, 413, 'FILE_TOO_LARGE'));
      }
      if (err instanceof AppError) return reject(err);
      return reject(new AppError('The upload could not be read', 400, 'UPLOAD_REJECTED'));
    });
  });
}

/**
 * Send a stored document. Always an attachment, never rendered inline: the
 * bytes came from a customer, so the browser must not interpret them. The
 * content type comes from the format registry by the generated storage key —
 * never from what the upload declared.
 */
function sendDocumentAttachment(res, stream, row) {
  res.set('Content-Type', contentTypeFor(formatForStorageKey(row.storage_key)));
  res.set('Content-Disposition', buildContentDisposition(row.original_name, 'attachment'));
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', 'default-src \'none\'; sandbox');
  res.set('Cache-Control', 'no-store');
  pipeStreamToResponse(stream, res, { context: 'customer document' });
}

/** Remove the temp copy, whatever happened to the upload. */
function discardTempFile(file) {
  try {
    if (file && file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
  } catch (_) { /* best effort */ }
}

module.exports = { receiveDocumentUpload, discardTempFile, sendDocumentAttachment };
