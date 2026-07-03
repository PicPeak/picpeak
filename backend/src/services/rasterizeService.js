/**
 * PDF rasteriser for inbound supplier-invoice previews.
 *
 * Renders a single PDF page to a flat PNG via poppler's `pdftoppm` (an OS
 * package installed in the Docker image — NOT a Node PDF library, so it doesn't
 * count against the pdfkit+pdf-lib "no third PDF lib" rule). The admin UI shows
 * ONLY these rasterised images, never the raw PDF — pdftoppm executes no
 * embedded JavaScript and fetches no remote resources, so a malicious inbound
 * PDF can neither run code in the browser nor phone home (SSRF/exfil).
 *
 * Rendered pages are cached on disk under
 *   storage/business-docs/inbound/rendered/<docId>/page-<n>.png
 * and regenerated on demand.
 */
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const { getStoragePath } = require('../config/storage');
const { AppError } = require('../utils/errors');
const logger = require('../utils/logger');

const RENDER_TIMEOUT_MS = 25000;
const RENDER_DPI = 150;
// Per-file resource bound (PR #622 concern 6): pages render one-per-request, so
// a 1000-page hostile PDF could otherwise be walked page-by-page. Refuse to
// render beyond this — the inbox pager is capped to match.
const MAX_RENDERABLE_PAGES = 200;

function renderedDir(docId) {
  return path.join(getStoragePath(), 'business-docs', 'inbound', 'rendered', String(docId));
}

function execFileAsync(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) return reject(err);
      return resolve({ stdout, stderr });
    });
  });
}

/**
 * Rasterise one page of `pdfPath` to a cached PNG; returns its absolute path.
 * @throws AppError 503 when pdftoppm is unavailable, 500 on render failure.
 */
async function getRenderedPagePath(docId, pdfPath, pageNum) {
  if (!Number.isInteger(pageNum) || pageNum < 1 || pageNum > MAX_RENDERABLE_PAGES) {
    throw new AppError(`Page out of range (1–${MAX_RENDERABLE_PAGES})`, 400, 'PAGE_OUT_OF_RANGE');
  }
  const dir = renderedDir(docId);
  const outPng = path.join(dir, `page-${pageNum}.png`);
  if (fs.existsSync(outPng)) return outPng;

  await fsp.mkdir(dir, { recursive: true });
  const outPrefix = path.join(dir, `page-${pageNum}`); // pdftoppm -singlefile appends .png
  try {
    await execFileAsync('pdftoppm', [
      '-png', '-singlefile', '-r', String(RENDER_DPI),
      '-f', String(pageNum), '-l', String(pageNum),
      pdfPath, outPrefix,
    ], { timeout: RENDER_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      throw new AppError('PDF rasteriser (pdftoppm) is not installed', 503, 'RASTERIZER_UNAVAILABLE');
    }
    logger.error?.(`rasterizeService: pdftoppm failed for ${pdfPath} p${pageNum}: ${e.message}`);
    throw new AppError('Failed to render PDF page', 500, 'RENDER_FAILED');
  }
  if (!fs.existsSync(outPng)) {
    throw new AppError('Failed to render PDF page', 500, 'RENDER_FAILED');
  }
  return outPng;
}

module.exports = { getRenderedPagePath };
