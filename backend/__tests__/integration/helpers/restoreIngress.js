// Explicit injectable protocol fixture. Production never imports this helper,
// and NODE_ENV alone grants neither filesystem nor native lifetime authority.
const fs = require('fs').promises;
const { createIngress } = require('../../../src/services/portableRestoreIngress');
async function fixtureIngress(privateRoot) {
  await fs.mkdir(privateRoot, { mode: 0o700, recursive: true });
  privateRoot = await fs.realpath(privateRoot);
  const storage = { root: require('path').dirname(privateRoot), privateRoot, storageId: require('crypto').randomUUID(),
    device: String((await fs.stat(privateRoot)).dev), filesystem: String(0xef53) };
  const busy = new Set();
  const acquired = [];
  const leases = { acquire: async filename => {
    if (busy.has(filename)) throw Object.assign(new Error('fixture lease busy'), { code: 'MEDIA_LEASE_BUSY' });
    busy.add(filename);
    const file = await fs.open(filename, 'a', 0o600); const stat = await file.stat(); await file.close();
    const lease = { path: filename, device: String(stat.dev), inode: String(stat.ino), filesystem: storage.filesystem,
      release: async () => { busy.delete(filename); lease.released = true; } };
    acquired.push(lease); return lease;
  } };
  const filesystem = new Proxy(fs, { get: (target, key) => key === 'statfs'
    ? async () => ({ type: 0xef53n, bavail: 10n * 1024n ** 3n, bsize: 1n, ffree: 100000n })
    : target[key] });
  const paths = { storageIdentity: async () => storage, syncDirectory: async () => {} };
  return { ingress: createIngress({ paths, leases, filesystem }), storage, leases, filesystem, acquired, paths };
}
module.exports = { fixtureIngress };
