#!/usr/bin/env node
'use strict';

/**
 * Clear a portable-restore fence that the backend cannot lift itself.
 *
 *   node scripts/clear-portable-restore-fence.js            # show the state
 *   node scripts/clear-portable-restore-fence.js --confirm  # clear it
 *   ... --confirm --force     # even though a backend process still holds it
 *
 * Stop the backend first. If the interrupted restore had not committed, its
 * files are rolled back and the instance is what it was before; if it had,
 * the restored data stays. Start the backend afterwards. The action is
 * written to the log and the activity log. See docs/PORTABLE_RESTORE.md.
 */
const fs = require('fs');
const path = require('path');

async function main() {
  const { db } = require('../src/database/db');
  const reset = require('../src/services/portableRestoreFenceReset');
  const args = process.argv.slice(2);
  const run = async () => {
    const row = await reset.describe(db);
    if (!row) { console.log('This instance has never run a portable restore; there is no fence.'); return; }
    console.log(`Restore control: state=${row.state} attempt=${row.attempt_id || '-'} generation=${row.generation}`);
    if (row.state === 'open' && !args.includes('--confirm')) { console.log('The instance is open; nothing to clear.'); return; }
    if (!args.includes('--confirm')) { console.log('Stop the backend, then run again with --confirm to clear the fence.'); return; }
    const result = await reset.clearFence({ db, force: args.includes('--force'), actor: 'clear-portable-restore-fence' });
    console.log(result.cleared
      ? `Fence cleared (the interrupted restore was ${result.outcome === 'committed' ? 'already committed; the restored data stays' : 'rolled back'}). Start the backend now.`
      : 'The instance is open; nothing to clear.');
  };
  // The CRM access policy, where this build has one, denies an actor-less
  // caller; an operator script is a trusted one.
  const policy = path.join(__dirname, '../src/database/crmAccess.js');
  if (fs.existsSync(policy)) await require(policy).withTrustedCrmAccess('operator CLI: clear-portable-restore-fence', run);
  else await run();
  await db.destroy();
}

main().catch(error => {
  console.error(`Could not clear the restore fence: ${error.message}`);
  process.exit(1);
});
