const path = require('path');

/**
 * Storage keys an upload is promoting into the watched folder right now
 * (issue 1970).
 *
 * Every upload path stores the file under events/active/ BEFORE its photo row
 * exists. The file watcher watches that folder, so a row arriving more than
 * FILE_WATCHER_STABILITY_MS late let the watcher import the file first: a
 * public row next to the upload's own (held-for-review) row, and the gallery
 * showed the photo twice.
 *
 * An upload claims the key before it stores the file and releases it once
 * its row is committed, or once a failure has removed what it stored. The
 * watcher waits for a claimed key to settle and then runs its usual
 * "already imported?" check, so a file dropped in by hand is imported as
 * before and a failed upload's leftover is treated like one.
 *
 * In-process on purpose: the watcher and every upload route run in the
 * backend process (server.js starts both), and the backend runs as a single
 * replica (README-DOCKER.md).
 */
const claims = new Map();

const normalize = (key) => path.posix.normalize(String(key).replace(/\\/g, '/'));

/** Claim a storage key; returns an idempotent release function. */
function claimPromotion(key) {
  const k = normalize(key);
  let entry = claims.get(k);
  if (!entry) {
    let resolve;
    const settled = new Promise((r) => { resolve = r; });
    entry = { count: 0, settled, resolve };
    claims.set(k, entry);
  }
  entry.count += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.count -= 1;
    if (entry.count === 0) {
      claims.delete(k);
      entry.resolve();
    }
  };
}

/** A promise that settles when the key's promotion does, or null if none runs. */
function promotionSettled(key) {
  const entry = claims.get(normalize(key));
  return entry ? entry.settled : null;
}

module.exports = { claimPromotion, promotionSettled };
