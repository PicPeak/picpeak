'use strict';

// Handlers for the public /health and /api/health probes (mounted in
// server.js). Docker HEALTHCHECKs, compose `service_healthy` gates and the
// install smoke test read only `status`; the restore flow adds
// `maintenance`. Nothing else goes into an anonymous answer: the process id
// and uptime told any visitor when the server last restarted. Admins read
// uptime from the authenticated system status endpoint instead.
function createHealthHandlers({ db, restoreCoordinator, logger }) {
  return {
    // A restore keeps this process alive and busy on purpose. While one runs
    // the probe answers 200 from memory, outside the request fence and
    // without touching the database, so a health-based restarter does not
    // kill it halfway.
    duringRestore(req, res, next) {
      if (!restoreCoordinator.isFenced()) return next();
      return res.json({
        status: 'ok',
        maintenance: restoreCoordinator.status().restartRequired ? 'restart_required' : 'restoring'
      });
    },

    async ordinary(req, res) {
      try {
        await db.raw('SELECT 1');
        res.json({ status: 'ok' });
      } catch (error) {
        logger.error('Health check failed:', error);
        res.status(503).json({ status: 'error' });
      }
    }
  };
}

module.exports = { createHealthHandlers };
