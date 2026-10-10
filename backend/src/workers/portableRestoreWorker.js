'use strict';

// One process owns the complete transaction/file/repair lifetime. The Linux
// guardian supplies hard limits, a pre-exec admission gate and protected FD9.
const { runWorkerProcess } = require('../services/portableRestoreWorker');

(async () => {
  try {
    const result = await runWorkerProcess(process.argv[2], process.argv[3]);
    process.stdout.write(`PICPEAK_RESTORE_RESULT=${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`Portable restore recovery remains fenced (${error.code || 'RESTORE_RECOVERY_REQUIRED'})\n`);
    process.exitCode = 1;
  } finally {
    try { await require('../database/db').db.destroy(); } catch (_) { /* Process termination retains the fence on failure. */ }
  }
})();
