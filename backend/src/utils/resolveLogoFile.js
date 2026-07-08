/**
 * resolveLogoFile — resolve a logo to an absolute existing file path.
 *
 * The CRM PDFs accept a logo from three different sources and each
 * source may store the path in a different shape (absolute multer
 * path, relative URL, bare filename, etc.). Rather than have the PDF
 * renderer guess, we build an exhaustive candidate list HERE, return
 * the first existing PNG/JPEG file, and log everything we tried when
 * we come up empty.
 *
 * Why this lives in utils:
 *   - both invoiceService and quoteService need the same resolution
 *   - the renderer (pdfService) should NOT touch the DB or the
 *     filesystem-discovery rules; it just calls doc.image(path)
 *
 * Sources we accept (in priority order):
 *   1. business_profile.logo_path  — explicit per-CRM logo
 *   2. app_settings.branding_logo_path  — absolute multer path from
 *      Settings → Branding (preferred — already absolute)
 *   3. app_settings.branding_logo_url   — URL path from the same
 *      branding upload (fallback for older installs)
 *
 * For each source we try multiple candidate disk paths:
 *   - The raw value as an absolute path (if absolute)
 *   - STORAGE_PATH joined with the value (stripped of leading "/")
 *   - STORAGE_PATH/uploads/logos/<basename>
 *   - STORAGE_PATH/branding/<basename>
 *   - CWD/storage joined with the value (last-ditch for older
 *     docker-compose configs that didn't set STORAGE_PATH)
 *
 * Format filter:
 *   PDFKit only natively decodes PNG + JPEG. SVG/WebP/GIF/TIFF files
 *   are silently skipped here (with a warn log) so the rest of the
 *   PDF still renders rather than crashing on an unsupported format.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getStoragePath } = require('../config/storage');
const { getAppSetting } = require('./appSettings');
const logger = require('./logger');

// Bump this whenever the SVG→PNG rendering environment changes in a way that
// changes output, to invalidate previously-cached rasterisations.
//   v2 (2026-06): backend image now ships fonts (fontconfig + brand fonts),
//       so SVG logos with live <text> render their text instead of tofu boxes.
const RASTER_VERSION = 'v2-fonts';

const SUPPORTED_EXT = /\.(png|jpe?g)$/i;
// Formats PDFKit can't embed directly but `sharp` can rasterise into
// PNG for us. We transparently convert + cache.
const CONVERTIBLE_EXT = /\.(svg|webp|gif|tif|tiff|avif|heif|heic)$/i;

function generateCandidates(raw, storageRoot) {
  const value = String(raw || '').trim();
  if (!value) return [];
  const stripped = value.replace(/^\/+/, '');
  const baseName = path.basename(value);
  // Build candidate set; dedup at the end so we don't stat the same
  // file twice when the inputs overlap.
  const candidates = [
    path.isAbsolute(value) ? value : null,
    path.join(storageRoot, stripped),
    path.join(storageRoot, 'uploads', 'logos', baseName),
    path.join(storageRoot, 'branding', baseName),
    path.join(process.cwd(), 'storage', stripped),
    path.join(process.cwd(), 'storage', 'uploads', 'logos', baseName),
    path.join(process.cwd(), 'storage', 'branding', baseName),
  ].filter(Boolean);
  return [...new Set(candidates)];
}

function pickExisting(candidates) {
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch (_) { /* ignore */ }
  }
  return null;
}

/**
 * Rasterise a non-PNG/JPEG source into PNG so PDFKit can embed it.
 * The output is cached under STORAGE_PATH/cache/logo-png/, keyed by
 * the source path + mtime + size — re-uploading the SVG invalidates
 * the cache automatically without us having to clean up old entries.
 *
 * Returns the absolute cached PNG path on success, or null when
 * `sharp` fails (corrupt SVG, unsupported feature inside the SVG,
 * etc.). The caller logs + falls back to the name-only branch.
 */
async function rasteriseToPng(sourcePath, storageRoot) {
  let sharp;
  try {
    sharp = require('sharp');
  } catch (err) {
    logger.warn('PDF logo rasterisation skipped — sharp not installed', { err: err.message });
    return null;
  }
  try {
    const stat = fs.statSync(sourcePath);
    const cacheDir = path.join(storageRoot, 'cache', 'logo-png');
    fs.mkdirSync(cacheDir, { recursive: true });
    // Content-addressed cache: sha1(renderer version + src path + mtime ns
    // + size). Including mtime means re-uploading the source invalidates the
    // cache entry naturally. RASTER_VERSION is bumped whenever the rendering
    // environment changes in a way that affects output (e.g. installing fonts
    // so SVG <text> stops rendering as tofu) — bumping it invalidates every
    // previously-cached PNG without having to clear the cache dir by hand.
    const key = crypto.createHash('sha1')
      .update(`${RASTER_VERSION}|${sourcePath}|${stat.mtimeMs}|${stat.size}`)
      .digest('hex');
    const cachedPath = path.join(cacheDir, `${key}.png`);
    if (fs.existsSync(cachedPath)) {
      return cachedPath;
    }
    // density: 384 gives a crisp render even when the SVG embeds at
    // a small intrinsic size (PDFKit's `fit` will downscale, never
    // upscale). 512px wide is more than enough for a letterhead
    // logo.
    await sharp(sourcePath, { density: 384 })
      .resize({ width: 512, withoutEnlargement: false })
      .png()
      .toFile(cachedPath);
    logger.info('PDF logo rasterised to PNG', { source: sourcePath, cached: cachedPath });
    return cachedPath;
  } catch (err) {
    logger.warn('PDF logo rasterisation failed', {
      source: sourcePath, err: err.message,
    });
    return null;
  }
}

/**
 * @param {object} profile  the business_profile row (or null)
 * @returns {Promise<string|null>}  absolute path to a usable PNG/JPEG, or null
 */
async function resolveLogoFile(profile) {
  const storageRoot = getStoragePath();
  const raws = [];
  const profileLogoPath = (profile?.logo_path || '').toString().trim();
  if (profileLogoPath) raws.push({ source: 'business_profile.logo_path', value: profileLogoPath });

  try {
    const brandingDisk = await getAppSetting('branding_logo_path');
    if (brandingDisk && typeof brandingDisk === 'string' && brandingDisk.trim()) {
      raws.push({ source: 'branding_logo_path', value: brandingDisk.trim() });
    }
  } catch (_) { /* ignore */ }

  try {
    const brandingUrl = await getAppSetting('branding_logo_url');
    if (brandingUrl && typeof brandingUrl === 'string' && brandingUrl.trim()) {
      raws.push({ source: 'branding_logo_url', value: brandingUrl.trim() });
    }
  } catch (_) { /* ignore */ }

  if (raws.length === 0) return null;

  for (const { source, value } of raws) {
    const candidates = generateCandidates(value, storageRoot);
    const found = pickExisting(candidates);
    if (!found) continue;
    if (SUPPORTED_EXT.test(found)) {
      logger.info('Resolved PDF logo', { source, configured: value, resolved: found });
      return found;
    }
    if (CONVERTIBLE_EXT.test(found)) {
      // SVG / WebP / GIF / TIFF / AVIF — rasterise to PNG so PDFKit
      // can embed it. Cached under STORAGE_PATH/cache/logo-png/ so
      // repeated PDF renders don't re-encode the same source.
      const rasterised = await rasteriseToPng(found, storageRoot);
      if (rasterised) {
        logger.info('Resolved PDF logo via rasterisation', {
          source, configured: value, original: found, resolved: rasterised,
        });
        return rasterised;
      }
      logger.warn('PDF logo rasterisation produced no file; trying next source', {
        source, configured: value, found,
      });
      continue;
    }
    // Unknown extension — try anyway, PDFKit may still accept it.
    logger.warn('PDF logo has unusual extension; attempting to render as-is', {
      source, configured: value, found,
    });
    return found;
  }

  logger.warn('PDF logo not found on disk after trying all sources', {
    storageRoot,
    sources: raws.map(({ source, value }) => ({
      source, value, candidates: generateCandidates(value, storageRoot),
    })),
  });
  return null;
}

module.exports = { resolveLogoFile };
