'use strict';
const crypto = require('crypto');

// JSON's array replacer is NOT a recursive sorter. Preserve every nested
// field, including algorithm/key identifiers and restore-critical metadata.
function canonicalize(value) {
  if (value instanceof Date) return value.toJSON();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      Object.defineProperty(result, key, { value: canonicalize(value[key]), enumerable: true });
      return result;
    }, {});
  }
  return value;
}

function recoveryDigest(manifest) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(manifest))).digest('hex');
}

module.exports = { canonicalize, recoveryDigest };
