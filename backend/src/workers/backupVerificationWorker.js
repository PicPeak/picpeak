'use strict';

// Entry point of a backup restore test child process. See
// services/backupVerificationWorker.js for what each mode does.
const { main } = require('../services/backupVerificationWorker');

main(process.argv[2]).then(() => {
  // A pool or a timer left open by a library must not keep the drill alive.
  setTimeout(() => process.exit(0), 100).unref();
}, (error) => {
  process.stderr.write(`Backup verification worker failed: ${error && error.message}\n`);
  process.exit(1);
});
