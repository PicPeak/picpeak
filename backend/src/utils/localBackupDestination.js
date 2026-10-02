const fs = require('fs').promises;
const { constants: fsConstants } = require('fs');
const path = require('path');
const { getStoragePath } = require('../config/storage');

/**
 * What stops the backend from writing to dir, or null when nothing does: dir
 * is writable as it stands, or missing below a writable ancestor, which is
 * what `mkdir -p` needs. A present-but-read-only directory is a blocker.
 *
 * The blocker names the nearest existing ancestor, so a host path typed into
 * a Docker install ("/home/ubuntu/...") reports the "/home" the container
 * does have rather than the path it does not (issue 1365). `code` is the
 * errno, or BROKEN_SYMLINK for a link whose target is gone.
 */
async function findWriteBlocker(dir) {
  // Normalised lexically, which is what path.join does to every file the
  // backup writes below the destination, and what settles a ".." that
  // follows a component not created yet.
  let current = path.resolve(dir);
  for (;;) {
    try {
      // Creating an entry needs search permission on the directory as well.
      // The trailing "." makes the kernel insist on a directory: a writable,
      // executable file would pass otherwise, and mkdir -p fails on it.
      await fs.access(current + path.sep + '.', fsConstants.W_OK | fsConstants.X_OK);
      return null;
    } catch (error) {
      if (error.code !== 'ENOENT') return { path: current, code: error.code };
    }
    // ENOENT for a name that is there: a dangling symlink, which mkdir can
    // neither create through nor replace.
    if (await fs.lstat(current).then(() => true, () => false)) {
      return { path: current, code: 'BROKEN_SYMLINK' };
    }
    const parent = path.dirname(current);
    if (parent === current) return { path: current, code: 'ENOENT' };
    current = parent;
  }
}

// Appended to every "cannot write there" message: the path a Docker admin
// types is one they see on the host, and nothing else says it is not.
function localDestinationHint() {
  return 'The path is resolved where the backend runs: under Docker that is inside the backend container, ' +
    'not on the host. Use a directory the backend can write to, such as a mounted volume ' +
    `(for example ${path.join(getStoragePath(), 'backups')}).`;
}

module.exports = {
  findWriteBlocker,
  localDestinationHint
};
