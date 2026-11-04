'use strict';

/**
 * The capabilities graceful degradation may switch off, and what each needs.
 *
 * This list is the whole of what can degrade. Login, permissions, gallery
 * access and expiry, invoicing, contract signing and document scanning are
 * absent on purpose and must stay absent: when their dependency fails they
 * fail closed through their own checks, never through a weaker path. Degrading
 * only ever removes a capability, so nothing here can grant anything.
 *
 * `needs` maps a dependency to the worst state the capability tolerates.
 * 'healthy' stops it at the first sign of trouble; 'degraded' stops it only
 * once the dependency is down. A dependency with no state yet, or one that is
 * not configured here, says nothing and does not block.
 */
const DEPENDENCY_STATES = Object.freeze(['healthy', 'degraded', 'down']);

const CAPABILITIES = Object.freeze({
  // New uploads only. A chunked upload that already started may finish.
  'uploads.new': Object.freeze({ needs: Object.freeze({ storage: 'healthy', disk: 'healthy' }) }),
  // New archives read every file of a gallery, and gallery builds spool to
  // local disk: the temporary directory, where it is a disk of its own. Single-photo downloads are not listed: they keep working while
  // they can. Admin exports and scheduled archiving are separate jobs an admin
  // starts or a schedule owns, and stay out of this.
  'downloads.archive': Object.freeze({ needs: Object.freeze({ storage: 'degraded', disk: 'healthy', tempDisk: 'healthy', load: 'degraded' }) }),
});

function isCapability(name) {
  return Object.prototype.hasOwnProperty.call(CAPABILITIES, name);
}

function severity(state) {
  return DEPENDENCY_STATES.indexOf(state);
}

/**
 * Pure decision: can `name` run, given each dependency's state and the
 * capabilities an admin forced off? `forcedOff` can only take a capability
 * away. An unknown name throws, so a typo at a call site fails loudly rather
 * than leaving a route unguarded.
 */
function evaluate(name, states = {}, forcedOff = []) {
  if (!isCapability(name)) throw new Error(`Unknown capability: ${name}`);
  const blockedBy = Object.entries(CAPABILITIES[name].needs)
    .filter(([dependency, worst]) => severity(states[dependency]) > severity(worst))
    .map(([dependency]) => dependency);
  const forced = forcedOff.includes(name);
  return { name, available: !forced && blockedBy.length === 0, forced, blockedBy };
}

module.exports = { CAPABILITIES, DEPENDENCY_STATES, isCapability, evaluate, severity };
