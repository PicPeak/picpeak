'use strict';

/**
 * Where this install's SQLite database lives.
 *
 * Extracted from knexfile.js so the engine guard (#1038) resolves EXACTLY the
 * same path knex opens. When the two disagree — a DATABASE_PATH with stray
 * whitespace, or the legacy duplicated-backend form this collapses — the guard
 * probes a file nobody uses, concludes there is no SQLite data, and lets the
 * boot switch to an empty Postgres while the real galleries sit in the file it
 * failed to look at.
 *
 * Behaviour is unchanged from the original; only its home moved.
 */

const path = require('path');

const BACKEND_ROOT = path.resolve(__dirname, '..', '..');

function resolveSqliteFilename(filenameEnv, baseDir = BACKEND_ROOT) {
  const fallback = path.join(baseDir, './data/photo_sharing.db');

  if (!filenameEnv) {
    return fallback;
  }

  const trimmed = String(filenameEnv).trim();
  if (!trimmed) {
    return fallback;
  }

  let resolved;
  if (path.isAbsolute(trimmed)) {
    resolved = trimmed;
  } else if (trimmed.startsWith('./') || trimmed.startsWith('../')) {
    resolved = path.resolve(baseDir, trimmed);
  } else {
    resolved = path.join(baseDir, trimmed);
  }

  const normalized = path.normalize(resolved);
  const baseSuffix = path.relative(path.parse(baseDir).root, path.normalize(baseDir));
  const duplicatePattern = `${path.sep}${baseSuffix}${path.sep}${baseSuffix}`;

  if (normalized.includes(duplicatePattern)) {
    return normalized.replace(duplicatePattern, `${path.sep}${baseSuffix}`);
  }

  return normalized;
}

module.exports = { resolveSqliteFilename };
