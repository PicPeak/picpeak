'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ValidationError } = require('../../utils/errors');
// Fixed, redistributable RGB profiles. Never resolve a caller-provided path.
// Keep these bytes for accepted orders; replacements require a new identifier.
const profiles = {
  srgb: { label: 'sRGB', icc: 'srgb' },
  'adobe-rgb-1998': { label: 'Adobe RGB (1998) compatible', file: 'AdobeCompat-v2.icc', sha256: '60fb2adecacf82132db0b1c09b303316f3bbd9e2823e7ba096d01627d12d57c9' },
  'display-p3': { label: 'Display P3', file: 'DisplayP3-v2-magic.icc', sha256: 'fa7905dea9d49e775f4e367966e6fc3411e843b44ea91fd7908104b7943a1446' },
  'prophoto-rgb': { label: 'ProPhoto RGB (ROMM RGB)', file: 'ProPhoto-v2-magic.icc', sha256: '59d1ef4f6b882d0d923bdaed86268f55dd30a8d102f4882aad9c2bbe9fb340c9' },
};
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function profile(id) {
  if (!Object.hasOwn(profiles, id)) throw new ValidationError('Choose a supported RGB output profile');
  const p = profiles[id];
  if (!p.file) return { ...p };
  return { ...p, icc: path.join(__dirname, 'icc', p.file) };
}
function verifiedProfile(id) {
  const p = profile(id);
  if (p.sha256 && digest(fs.readFileSync(p.icc)) !== p.sha256) throw new Error('Bundled output ICC profile identity changed');
  return p;
}
function allowed(icc) {
  const match = Object.entries(profiles).find(([, p]) => icc === (p.file ? path.join(__dirname, 'icc', p.file) : p.icc));
  if (!match) return false;
  verifiedProfile(match[0]); return true;
}
function verify(metadata, output) {
  if (output.profileSha256 && (!metadata.icc || digest(metadata.icc) !== output.profileSha256))
    throw new Error('Prepared artwork does not embed the frozen output ICC profile');
}
module.exports = { profile, verifiedProfile, allowed, verify };
