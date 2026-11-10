'use strict';

/**
 * Naming and guard rules for the restore drill's throwaway database.
 *
 * A restore drill loads a backup dump into a database of its own. The one
 * thing it must never do is load into, migrate, or drop the live database,
 * so every place that touches a drill database goes through
 * assertDrillDatabaseName first: the name must carry the drill prefix and
 * must differ from the live database's name. Anything else aborts.
 */

const DRILL_PREFIX = 'picpeak_drill_';
const DRILL_NAME_RE = /^picpeak_drill_[a-z0-9_]{1,40}$/;
const DRILL_TEMP_PREFIX = 'backup-verify-';

// Several installs may share one PostgreSQL server (production and a beta,
// say). Each install's drills carry a tag derived from its own database name,
// so one install's boot sweep never drops another install's running drill.
function installTag(liveName) {
  return require('crypto').createHash('sha256').update(String(liveName || '')).digest('hex').slice(0, 8);
}

function drillPrefixFor(liveName) {
  return `${DRILL_PREFIX}${installTag(liveName)}_`;
}

function drillDatabaseName(verificationId, liveName) {
  const id = String(verificationId).replace(/[^0-9]/g, '');
  if (!id) throw new Error('A restore drill needs a numeric verification id');
  return `${drillPrefixFor(liveName)}${id}`;
}

function assertDrillDatabaseName(name, liveName) {
  if (typeof name !== 'string' || !DRILL_NAME_RE.test(name)) {
    throw new Error(`Refusing to use "${name}" as a restore-drill database: the name must start with ${DRILL_PREFIX}`);
  }
  if (typeof liveName === 'string' && name.toLowerCase() === liveName.trim().toLowerCase()) {
    throw new Error('Refusing to use the live database as a restore-drill database');
  }
  return name;
}

module.exports = { DRILL_PREFIX, DRILL_NAME_RE, DRILL_TEMP_PREFIX, drillDatabaseName, drillPrefixFor, assertDrillDatabaseName };
