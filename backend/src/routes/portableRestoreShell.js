'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');

// The retained maintenance UI is application code, not business data. This
// exact read-only surface precedes ordinary ingress without consulting DB
// branding, public-site rendering, uploaded logos or any dynamic API.
const SHELL_PATHS = ['/admin', '/admin/login', '/admin/settings', '/admin/backup', '/index.html'];
const HASHED_ASSET = /^\/assets\/[a-zA-Z0-9_-]{1,120}-[a-zA-Z0-9_-]{8,32}\.(js|css|png|svg|webp|jpg|jpeg|gif|ico|woff2?|ttf)$/;

function createRestoreShellRouter({ frontendDir = process.env.FRONTEND_DIR || path.resolve(__dirname, '../../../frontend/dist'),
  serveFrontend = process.env.SERVE_FRONTEND } = {}) {
  const router = express.Router();
  if (serveFrontend === 'false') return router;
  let root, html;
  try {
    root = fs.realpathSync(frontendDir);
    const filename = path.join(root, 'index.html');
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return router;
    html = fs.readFileSync(filename, 'utf8')
      .split('${BRAND_TITLE}').join('PicPeak')
      .split('${BRAND_DESCRIPTION}').join('PicPeak maintenance and restore progress.');
  } catch (_) { return router; }

  router.get(SHELL_PATHS, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.type('html').send(html);
  });
  const files = new Map([['/bootstrap.js', 'bootstrap.js'], ['/favicon.ico', 'favicon-32x32.png'],
    ['/apple-touch-icon.png', 'favicon-32x32.png']]);
  router.get('*', async (req, res, next) => {
    const leaf = files.get(req.path) || (HASHED_ASSET.test(req.path) ? req.path.slice(1) : null);
    if (!leaf) return next();
    const filename = path.join(root, leaf);
    try {
      const stat = await fs.promises.lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || await fs.promises.realpath(filename) !== filename) return next();
      res.set('Cache-Control', files.has(req.path) ? 'no-store' : 'public, max-age=31536000, immutable');
      if (req.path === '/favicon.ico') res.type('png');
      return res.sendFile(filename, error => { if (error) next(error); });
    } catch (_) { return next(); }
  });
  return router;
}

module.exports = { createRestoreShellRouter, SHELL_PATHS };
