/**
 * The /fonts mount for uploaded fonts kept in an object store (issue 2618).
 *
 * With local storage the uploads are files under STORAGE_PATH/fonts and the
 * static mounts in server.js serve them. With S3 they live in the bucket, so
 * every replica serves what any replica uploaded: a request for
 * /fonts/<Family>/<weight>.<format> is answered from a local copy, fetched
 * from the store when missing or older than a few minutes (a replaced or
 * removed file is picked up again). Only font files, only under fonts/;
 * anything else goes on to the next mount.
 */
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { getStorage } = require('../services/storage');
const secureStatic = require('./secureStatic');
const { isPublicFontFile } = secureStatic;
const logger = require('../utils/logger');

/** What every /fonts mount serves with: fonts only, a week's cache, nosniff. */
const fontStaticOpts = {
  maxAge: '7d',
  onlyServe: isPublicFontFile,
  setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
};

const FONT_PATH = /^\/([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)\/(\d{1,4}\.(?:woff2|woff|ttf))$/;
const FRESH_MS = 10 * 60 * 1000;

function fontReadThrough({ cacheDir = path.join(os.tmpdir(), 'picpeak-font-cache') } = {}) {
  const serve = secureStatic(cacheDir, fontStaticOpts);
  return async (req, res, next) => {
    try {
      const storage = getStorage();
      if (storage.kind() !== 's3') return next();
      const match = FONT_PATH.exec(req.path);
      if (!match) return next();
      const local = path.join(cacheDir, match[1], match[2]);
      const cached = await fs.stat(local).catch(() => null);
      if (!cached || Date.now() - cached.mtimeMs > FRESH_MS) {
        const key = `fonts/${match[1]}/${match[2]}`;
        if (!(await storage.exists(key))) {
          await fs.rm(local, { force: true });
          return next();
        }
        // Fetched beside, then moved in: a reader never sees half a file.
        const tmp = `${local}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        await storage.getToFile(key, tmp);
        await fs.rename(tmp, local);
      }
      return serve(req, res, next);
    } catch (error) {
      logger.warn('[fonts] Could not serve an uploaded font from storage', { error: error.message });
      return next();
    }
  };
}

module.exports = { fontReadThrough, fontStaticOpts };
