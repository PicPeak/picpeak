'use strict';

const express = require('express');
const multer = require('multer');
const os = require('os');
const fs = require('fs').promises;
const crypto = require('crypto');
const { adminAuth } = require('../middleware/auth');
const { requireSuperAdmin } = require('../middleware/permissions');
const csrf = require('../middleware/csrf');
const applicationWork = require('../services/activeApplicationWork');
const coordinator = require('../services/portableRestoreCoordinator');
const logger = require('../utils/logger');

const IMPORT = '/api/admin/backup/picpeak/import';
const PROGRESS = '/api/admin/backup/picpeak/restore/:attemptId';
const TOKEN_HEADER = 'x-picpeak-restore-progress';

function createRestoreControlRouter({ restore = coordinator, work = applicationWork,
  authenticate = adminAuth, superAdmin = requireSuperAdmin(), cors = (_req, _res, next) => next(), uploadRoot = os.tmpdir() } = {}) {
  const router = express.Router();
  const upload = multer({ storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadRoot),
    filename: (_req, _file, cb) => cb(null, `picpeak-upload-${crypto.randomUUID()}.picpeak`),
  }), limits: { fileSize: 5 * 1024 ** 3, files: 1, fields: 0, fieldArrayIndexLimit: 0 } });
  const control = (_req, _res, next) => work.runControl(next).catch(next);
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  // Only these exact read-only preflights are available, not an API-prefix
  // exemption. The origin policy is the same one as ordinary server CORS.
  router.options([IMPORT, PROGRESS], cors, (_req, res) => res.sendStatus(204));
  router.post(IMPORT, cors, control, csrf, authenticate, superAdmin, upload.single('backup'), wrap(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No backup file uploaded' });
    try {
      // A disconnected/unfinished multipart request never admits a worker.
      if (req.aborted || !req.complete || res.destroyed) return;
      const result = await restore.start({ archivePath: req.file.path, operatorId: Number(req.admin.id), options: {} });
      return res.status(202).json(result);
    } finally { await fs.unlink(req.file.path).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }));
  router.get(PROGRESS, cors, control, (req, res, next) => {
    if (req.get(TOKEN_HEADER)) return next();
    return authenticate(req, res, error => {
      if (error) return next(error);
      return superAdmin(req, res, failure => {
        if (failure) return next(failure);
        req.restoreProgressSuperAdmin = true;
        return next();
      });
    });
  }, wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await restore.progress(req.params.attemptId, req.get(TOKEN_HEADER), req.restoreProgressSuperAdmin === true));
  }));
  router.use((error, req, res, next) => {
    // Never log the capability, uploaded archive, database metadata or stack.
    logger.error('Portable restore control failed', { code: error.code || 'RESTORE_CONTROL_FAILED' });
    if (req.file) void fs.unlink(req.file.path).catch(() => {});
    if (res.headersSent) return next(error);
    const allowed = ['RESTORE_NOT_FOUND', 'RESTORE_CONFLICT', 'RESTORE_OPTIONS_INVALID', 'RESTORE_ARCHIVE_INVALID'];
    const status = allowed.includes(error.code) ? error.statusCode : (error instanceof multer.MulterError ? 400 : 503);
    return res.status(status).json({ code: allowed.includes(error.code) ? error.code : 'RESTORE_MAINTENANCE',
      error: status === 404 ? 'Restore attempt not found' : 'Coordinated restore is unavailable; the application remains fenced' });
  });
  return router;
}

module.exports = { createRestoreControlRouter, TOKEN_HEADER, IMPORT, PROGRESS };
