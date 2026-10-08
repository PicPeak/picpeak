const path = require('path');
const unavailable = () => Object.assign(new Error('A persistent local Linux execution lease is unavailable; run npm run build:native'), { code: 'MEDIA_LEASE_UNAVAILABLE', status: 422 });
function binding() {
  if (process.platform !== 'linux') throw unavailable();
  try { return require('../../bin/local-process-lease.node'); }
  catch (_) { throw unavailable(); }
}
async function probe(leasePath, expected) {
  if (!path.isAbsolute(leasePath || '')) return 'unknown';
  if (expected && (!/^\d+$/.test(expected.device || '') || !/^\d+$/.test(expected.inode || '') || !/^\d+$/.test(expected.filesystem || ''))) return 'unknown';
  try { return binding().probe(leasePath, expected?.device || '', expected?.inode || '', expected?.filesystem || ''); } catch (_) { return 'unknown'; }
}
async function acquire(leasePath) {
  if (!path.isAbsolute(leasePath || '')) throw unavailable();
  const native = binding(), lease = native.acquire(leasePath);
  let released = false;
  return { path: leasePath, device: lease.device, inode: lease.inode, filesystem: lease.filesystem, release: async () => {
    if (!released) { native.release(lease.descriptor); released = true; }
  } };
}
module.exports = { acquire, probe };
