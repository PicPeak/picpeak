/**
 * Human-readable byte size, e.g. 1536 -> "1.5 KB".
 * Falsy/undefined input returns '0 Bytes'.
 */
function formatBytes(bytes, decimals = 2) {
  if (!bytes) {
    return '0 Bytes';
  }

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

module.exports = { formatBytes };
