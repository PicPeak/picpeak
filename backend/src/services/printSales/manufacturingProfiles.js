'use strict';
// Preparatory domain contract only; no routes, storage or rendering side effects.
const V = require('../albumProducts/validation');
const G = require('../albumProducts/library');
const { ValidationError, ConflictError } = require('../../utils/errors');

const MAX_PROFILES = 100;
const MAX_OUTPUT_PIXELS = 60e6;
const fail = (message) => { throw new ValidationError(message); };

function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !keys.includes(key)))
    fail(`Invalid ${label}`);
  return value;
}

function number(value, min, max, label) {
  if (!Number.isFinite(value) || value < min || value > max)
    fail(`Invalid ${label}`);
  return value;
}

function edges(value, label) {
  object(value, ['top', 'right', 'bottom', 'left'], label);
  return Object.fromEntries(['top', 'right', 'bottom', 'left'].map((side) =>
    [side, number(value[side], 0, 100, label)]));
}

/** Resolve complete choices through the existing catalogue, including dependencies. */
function select(catalogue, input) {
  object(input, ['productId', 'productVersion', 'values'], 'product selection');
  V.uuid(input.productId);
  const product = G.resolve(
    catalogue.products.find((p) => p.id === input.productId), catalogue,
  );
  // Legacy model/colour definitions do not describe rectangular manufacturing.
  if (!product?.attributes) fail('Choose a shared-library product');
  return G.selection(product, input);
}

/** Compare complete choices independently of object/option order and empty extras. */
function selectionKey(selection) {
  return V.hash({
    productId: selection.product.id,
    productVersion: selection.productVersion,
    values: selection.attributes
      .map((a) => [a.id, a.options.map((o) => o.id).sort()])
      .sort(([a], [b]) => a.localeCompare(b)),
  });
}

function manufacturing(input) {
  object(input, ['capability', 'trimMm', 'bleedMm', 'safeInsetMm',
    'resolution', 'output', 'fitModes'], 'manufacturing requirements');
  if (input.capability !== 'single-photo-rectangle')
    fail('Only single-photo rectangular artwork is supported');
  object(input.trimMm, ['width', 'height'], 'trim dimensions');
  const trimMm = {
    width: number(input.trimMm.width, 1, 2000, 'trim width'),
    height: number(input.trimMm.height, 1, 2000, 'trim height'),
  };
  const bleedMm = edges(input.bleedMm, 'bleed'),
    safeInsetMm = edges(input.safeInsetMm, 'safe inset');
  if (safeInsetMm.left + safeInsetMm.right >= trimMm.width ||
      safeInsetMm.top + safeInsetMm.bottom >= trimMm.height)
    fail('Safe insets must leave a positive area inside the trim');
  object(input.resolution, ['targetDpi', 'minimumDpi'], 'resolution');
  const resolution = {
    targetDpi: number(input.resolution.targetDpi, 72, 600, 'target resolution'),
    minimumDpi: number(input.resolution.minimumDpi, 72, 600, 'minimum resolution'),
  };
  if (resolution.minimumDpi > resolution.targetDpi)
    fail('Minimum resolution must not exceed target resolution');
  // This is a capability declaration, not a claim that arbitrary ICC transforms
  // or soft proofing have been implemented. Reject unsupported requirements.
  object(input.output, ['format', 'colourSpace'], 'output requirements');
  if (input.output.format !== 'jpeg' || input.output.colourSpace !== 'srgb')
    fail('Only sRGB JPEG output is supported');
  if (!Array.isArray(input.fitModes) || !input.fitModes.length ||
      input.fitModes.length > 2 || new Set(input.fitModes).size !== input.fitModes.length ||
      input.fitModes.some((mode) => !['cover', 'contain'].includes(mode)))
    fail('Choose supported crop/fit modes');
  return {
    capability: input.capability, trimMm, bleedMm, safeInsetMm, resolution,
    output: { format: 'jpeg', colourSpace: 'srgb' },
    fitModes: [...input.fitModes].sort(),
  };
}

/** Compile one trusted studio definition into a detached, content-versioned snapshot. */
function defineProfile(catalogue, input) {
  object(input, ['id', 'revision', 'enabled', 'selection', 'manufacturing',
    'labReference'], 'manufacturing profile');
  V.uuid(input.id);
  if (!Number.isSafeInteger(input.revision) || input.revision < 1)
    fail('Profile revision must be a positive integer');
  if (typeof input.enabled !== 'boolean') fail('Profile enablement is required');
  const selection = select(catalogue, input.selection),
    spec = manufacturing(input.manufacturing);
  const widthMm = spec.trimMm.width + spec.bleedMm.left + spec.bleedMm.right,
    heightMm = spec.trimMm.height + spec.bleedMm.top + spec.bleedMm.bottom,
    widthPx = Math.round(widthMm * spec.resolution.targetDpi / 25.4),
    heightPx = Math.round(heightMm * spec.resolution.targetDpi / 25.4);
  if (widthPx * heightPx > MAX_OUTPUT_PIXELS)
    fail('Artwork exceeds the 60 megapixel output limit');
  const snapshot = {
    schemaVersion: 1,
    id: input.id,
    revision: input.revision,
    enabled: input.enabled,
    selection,
    manufacturing: spec,
    artwork: { widthMm, heightMm, widthPx, heightPx },
    labReference: V.text(input.labReference ?? '', 200),
  };
  return { ...snapshot, version: V.hash(snapshot) };
}

/**
 * Resolve exactly one enabled definition for current complete choices. Definitions
 * come from studio configuration, never the buyer. No wildcard/default profile.
 */
function resolveProfile(catalogue, definitions, input) {
  if (!Array.isArray(definitions) || definitions.length > MAX_PROFILES)
    fail(`Use at most ${MAX_PROFILES} manufacturing profiles`);
  const selection = select(catalogue, input), key = selectionKey(selection);
  const matches = definitions
    .filter((p) => p?.enabled === true &&
      p.selection?.productId === selection.product.id &&
      p.selection?.productVersion === selection.productVersion)
    .map((p) => defineProfile(catalogue, p))
    .filter((p) => selectionKey(p.selection) === key);
  if (!matches.length)
    throw new ConflictError('No enabled manufacturing profile matches these choices');
  if (matches.length !== 1)
    throw new ConflictError('Multiple manufacturing profiles match these choices');
  return matches[0];
}

module.exports = { defineProfile, resolveProfile };
