'use strict';

const express = require('express');
const multer = require('multer');
const { adminAuth } = require('../middleware/auth');
const { requireSuperAdmin } = require('../middleware/permissions');
const { sessionTimeoutMiddleware } = require('../middleware/sessionTimeout');
const csrf = require('../middleware/csrf');
const applicationWork = require('../services/activeApplicationWork');
const coordinator = require('../services/portableRestoreCoordinator');
const ingressService = require('../services/portableRestoreIngress');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');

const IMPORT = '/api/admin/backup/picpeak/import';
const PROGRESS = '/api/admin/backup/picpeak/restore/:attemptId';
const TOKEN_HEADER = 'x-picpeak-restore-progress';

function createRestoreControlRouter({ restore = coordinator, work = applicationWork,
  authenticate = adminAuth, superAdmin = requireSuperAdmin(), cors = (_req, _res, next) => next(), ingress = ingressService } = {}) {
  const router = express.Router();
  const control = (_req, _res, next) => work.runControl(next).catch(next);
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  // Only these exact read-only preflights are available, not an API-prefix
  // exemption. The origin policy is the same one as ordinary server CORS.
  router.options([IMPORT, PROGRESS], cors, (_req, res) => res.sendStatus(204));
  router.post(IMPORT, cors, control, csrf, authenticate, sessionTimeoutMiddleware, superAdmin, wrap(async (req, res) => {
    await restore.admitUpload();
    ingress.validateRequestEnvelope(req);
    const result = await ingress.withIngress(async () => {
      // Busboy signals at equality; the measured storage ceiling is exact.
      // A second part is always rejected by files/fields limits independently.
      const upload = multer({ storage: ingress.storage(), limits: { fileSize: ingressService.MAX_ARCHIVE_BYTES + 1,
        files: 1, fields: 0, parts: 2, fieldNameSize: 100, fieldSize: 0, headerPairs: 32, fieldArrayIndexLimit: 0 } });
      await new Promise((resolve, reject) => upload.single('backup')(req, res, error => error ? reject(error) : resolve()));
      if (!req.file) throw new AppError('No backup file uploaded', 400, 'RESTORE_REQUEST_INVALID');
      // A disconnected/unfinished multipart request never admits a worker.
      if (req.aborted || !req.complete || res.destroyed) return;
      return restore.start({ archivePath: req.file.path, operatorId: Number(req.admin.id), options: {} });
    });
    // Success is not observable until every owned stream and upload cleanup
    // is terminal and the actual shared-volume ingress lease is released.
    if (result && !res.destroyed) res.status(202).json(result);
  }));
  router.get(PROGRESS, cors, control, (req, res, next) => {
    if (req.get(TOKEN_HEADER)) return next();
    return authenticate(req, res, error => {
      if (error) return next(error);
      return sessionTimeoutMiddleware(req, res, timeoutError => {
        if (timeoutError) return next(timeoutError);
        return superAdmin(req, res, failure => {
          if (failure) return next(failure);
          req.restoreProgressSuperAdmin = true;
          return next();
        });
      });
    });
  }, wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await restore.progress(req.params.attemptId, req.get(TOKEN_HEADER), req.restoreProgressSuperAdmin === true));
  }));
  router.use((error, req, res, next) => {
    // Never log the capability, uploaded archive, database metadata or stack.
    logger.error('Portable restore control failed', { code: error.code || 'RESTORE_CONTROL_FAILED' });
    if (res.headersSent) return next(error);
    const allowed = ['RESTORE_NOT_FOUND', 'RESTORE_CONFLICT', 'RESTORE_OPTIONS_INVALID', 'RESTORE_ARCHIVE_INVALID',
      'RESTORE_ARCHIVE_LIMIT', 'RESTORE_REQUEST_INVALID', 'RESTORE_UPLOAD_ABORTED', 'RESTORE_CAPACITY_LIMIT', 'RESTORE_CAPACITY_UNKNOWN'];
    const status = allowed.includes(error.code) ? error.statusCode : (error instanceof multer.MulterError ? 400 : 503);
    return res.status(status).json({ code: allowed.includes(error.code) ? error.code : 'RESTORE_MAINTENANCE',
      error: status === 404 ? 'Restore attempt not found' : 'Coordinated restore is unavailable; the application remains fenced' });
  });
  return router;
}

module.exports = { createRestoreControlRouter, TOKEN_HEADER, IMPORT, PROGRESS };
