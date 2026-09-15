'use strict';

/**
 * Canonical JSON: object keys sorted at every level, no whitespace, arrays
 * in their given order. Two equal values always serialise to the same
 * string, so a sha256 over it identifies content rather than formatting —
 * used for contract template versions and sent contract content (#1445).
 * `undefined` members are dropped like JSON.stringify does.
 */

const crypto = require('crypto');

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value === undefined ? null : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

function canonicalSha256(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

module.exports = { canonicalJson, canonicalSha256 };
