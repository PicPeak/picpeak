'use strict';

/**
 * The declarations a signer confirms (#1446).
 *
 * A template version defines them: `[{ key, required, version, text: { en, de } }]`.
 * Publishing freezes them with the version (they are part of its content
 * hash), sending copies them into the contract's content snapshot (so the
 * hash a signature is bound to covers the wording), and signing records
 * each answer in `contract_signer_consents` with the sha256 of the wording.
 *
 * The admin edits wording, not version numbers: saving a draft keeps a
 * declaration's version while its wording and `required` match the
 * published one, and counts it up when either changed. A declaration is
 * never pre-checked — the signer ticks each one.
 */

const { AppError } = require('../../utils/errors');
const { canonicalSha256 } = require('../../utils/canonicalJson');
const { ensureInt } = require('../../utils/numericHelpers');

const KEY_RE = /^[a-z0-9_]{1,40}$/;
const MAX_CONSENTS = 8;
const MAX_TEXT = 1000;
const LOCALES = ['en', 'de'];

// Today's wording, which every existing version was backfilled with
// (migration 252) and which a contract made without a template signs with.
const DEFAULT_CONSENTS = Object.freeze([Object.freeze({
  key: 'acceptance',
  required: true,
  version: 1,
  text: Object.freeze({
    en: 'I have read this contract and agree to be bound by its terms.',
    de: 'Ich habe diesen Vertrag gelesen und erkläre mich mit seinen Bedingungen einverstanden.',
  }),
})]);

const invalid = (message) => new AppError(message, 400, 'TEMPLATE_INVALID');

/** A stored or snapshotted list, normalised; null when there is none. */
function parseConsents(raw) {
  if (raw == null || raw === '') return null;
  let list = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }
  if (!Array.isArray(list)) return null;
  return list.map((c) => ({
    key: String(c.key),
    required: c.required === true,
    version: ensureInt(c.version) || 1,
    text: Object.fromEntries(LOCALES.filter((l) => c.text && typeof c.text[l] === 'string').map((l) => [l, c.text[l]])),
  }));
}

/**
 * The editor's list, validated, with versions decided against the
 * published version's declarations (`previous`).
 */
function sanitizeConsents(input, previous = []) {
  if (!Array.isArray(input)) throw invalid('Declarations must be a list');
  if (input.length > MAX_CONSENTS) throw invalid(`A template has at most ${MAX_CONSENTS} declarations`);
  const before = new Map((previous || []).map((c) => [c.key, c]));
  const seen = new Set();
  return input.map((entry, index) => {
    const label = `Declaration ${index + 1}`;
    const key = String((entry && entry.key) || '').trim();
    if (!KEY_RE.test(key)) throw invalid(`${label}: the key may use a–z, 0–9 and _ (up to 40)`);
    if (seen.has(key)) throw invalid(`${label}: the key "${key}" is used twice`);
    seen.add(key);
    const text = {};
    for (const locale of LOCALES) {
      const value = entry.text && entry.text[locale] != null ? String(entry.text[locale]).trim() : '';
      if (value.length > MAX_TEXT) throw invalid(`${label}: the text is limited to ${MAX_TEXT} characters`);
      if (value) text[locale] = value;
    }
    if (!Object.keys(text).length) throw invalid(`${label}: enter the wording`);
    const required = entry.required === true;
    const prior = before.get(key);
    const unchanged = prior && prior.required === required && canonicalSha256(prior.text) === canonicalSha256(text);
    return { key, required, version: prior ? (unchanged ? prior.version : prior.version + 1) : 1, text };
  });
}

/**
 * What a contract's signers will be asked to confirm, for its content
 * snapshot: the declarations of the template version it was made from, or
 * today's single one for a contract made without a template.
 */
async function forContract(contract) {
  const { db } = require('../../database/db');
  if (contract.template_version_id) {
    const version = await db('contract_template_versions').where({ id: contract.template_version_id }).first('consents');
    const list = parseConsents(version && version.consents);
    if (list && list.length) return list;
  }
  return parseConsents(JSON.stringify(DEFAULT_CONSENTS));
}

/** Problems that keep a version from being published. */
function publishProblems(consents) {
  if (!consents || !consents.some((c) => c.required)) {
    return ['Add at least one declaration the signer has to confirm'];
  }
  return [];
}

/** The sha256 a declaration's wording is recorded under. */
const textSha256 = (consent) => canonicalSha256(consent.text || {});

/** A declaration's wording in a language, falling back to the other one. */
function pickText(consent, locale) {
  const text = consent.text || {};
  return text[locale] || text.en || text.de || '';
}

/**
 * Check a signer's answers against the frozen declarations. Every required
 * one accepted, none unknown. Returns the rows to record, in snapshot order.
 */
function answers(frozen, submitted) {
  const given = new Map();
  for (const entry of Array.isArray(submitted) ? submitted : []) {
    if (!entry || typeof entry.key !== 'string') continue;
    given.set(entry.key, entry.accepted === true);
  }
  const known = new Set(frozen.map((c) => c.key));
  const unknown = [...given.keys()].filter((key) => !known.has(key));
  if (unknown.length) {
    const err = new AppError('Those declarations are not part of this contract.', 400, 'CONSENT_UNKNOWN');
    err.details = { unknownKeys: unknown };
    throw err;
  }
  const missing = frozen.filter((c) => c.required && given.get(c.key) !== true).map((c) => c.key);
  if (missing.length) {
    const err = new AppError('Confirm every required declaration before signing.', 400, 'CONSENT_REQUIRED');
    err.details = { missingKeys: missing };
    throw err;
  }
  return frozen.map((c) => ({
    key: c.key, version: c.version, textSha256: textSha256(c), accepted: given.get(c.key) === true,
  }));
}

module.exports = {
  DEFAULT_CONSENTS,
  MAX_CONSENTS,
  parseConsents,
  forContract,
  sanitizeConsents,
  publishProblems,
  textSha256,
  pickText,
  answers,
};
