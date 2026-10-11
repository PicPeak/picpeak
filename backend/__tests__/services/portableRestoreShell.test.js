'use strict';

const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');
const { createRestoreShellRouter, SHELL_PATHS } = require('../../src/routes/portableRestoreShell');

describe('DB-free retained maintenance shell', () => {
  let directory, app;
  beforeAll(async () => {
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-restore-shell-')));
    await fs.mkdir(path.join(directory, 'assets'));
    await fs.writeFile(path.join(directory, 'index.html'), '<title>${BRAND_TITLE}</title><meta content="${BRAND_DESCRIPTION}"><script src="/assets/index-AbCd1234.js"></script>');
    await fs.writeFile(path.join(directory, 'assets/index-AbCd1234.js'), 'window.maintenanceFixture = true;');
    await fs.writeFile(path.join(directory, 'assets/unhashed.js'), 'unhashed');
    await fs.writeFile(path.join(directory, 'bootstrap.js'), 'window.bootstrapFixture = true;');
    await fs.writeFile(path.join(directory, 'favicon-32x32.png'), 'builtin favicon');
    await fs.symlink(path.join(directory, 'index.html'), path.join(directory, 'assets/escape-AbCd1234.js'));
    app = express(); app.use(createRestoreShellRouter({ frontendDir: directory, serveFrontend: 'true' }));
    app.use((_req, res) => res.status(503).json({ code: 'RESTORE_MAINTENANCE' }));
  });
  afterAll(async () => { await fs.rm(directory, { recursive: true, force: true }); });

  it.each(SHELL_PATHS)('retains only the exact read-only shell %s without branding DB work', async route => {
    const response = await request(app).get(`${route}?tab=backup`).expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.text).toContain('<title>PicPeak</title>');
    expect(response.text).not.toContain('${BRAND_');
  });
  it.each(['/assets/index-AbCd1234.js', '/bootstrap.js', '/favicon.ico', '/apple-touch-icon.png'])('retains shipped readonly %s', async route => {
    await request(app).get(route).expect(200);
  });
  it.each(['/admin/users', '/admin/backups', '/api/admin/users', '/api/public/settings', '/uploads/logos/favicon.png',
    '/photos/photo.png', '/health', '/assets/unhashed.js', '/assets/escape-AbCd1234.js', '/assets/index-AbCd1234.js.map',
    '/assets/%2e%2e/index.html', '/'])('does not grant a static or API-prefix bypass to %s', async route => {
    await request(app).get(route).expect(503);
  });
  it('does not open mutating shell requests', async () => {
    await request(app).post('/admin/settings').expect(503);
  });
  it('keeps ordinary OPTIONS behind the maintenance gate', async () => {
    await request(app).options('/api/admin/users').expect(503);
  });
  it('a healthy runtime keeps its normal branding and asset compression while maintenance retains the DB-free fallback', async () => {
    let maintenance = false;
    const ordinary = express();
    ordinary.use(createRestoreShellRouter({ frontendDir: directory, serveFrontend: 'true', shouldServe: () => maintenance }));
    ordinary.use(require('compression')());
    ordinary.get('/admin', (_req, res) => res.type('html').send('<title>AIO Smoke</title>'));
    ordinary.get('/assets/index-AbCd1234.js', (_req, res) => res.type('js').send('window.ordinary = true;'.repeat(200)));
    ordinary.use((_req, res) => res.status(503).json({ code: 'RESTORE_MAINTENANCE' }));
    expect((await request(ordinary).get('/admin').expect(200)).text).toContain('<title>AIO Smoke</title>');
    const asset = await request(ordinary).get('/assets/index-AbCd1234.js').set('Accept-Encoding', 'gzip').expect(200);
    expect(asset.headers['content-encoding']).toBe('gzip');
    maintenance = true;
    expect((await request(ordinary).get('/admin').expect(200)).text).toContain('<title>PicPeak</title>');
    expect((await request(ordinary).get('/assets/index-AbCd1234.js').expect(200)).text).toContain('maintenanceFixture');
  });
  it('respects explicit frontend disable', async () => {
    const disabled = express(); disabled.use(createRestoreShellRouter({ frontendDir: directory, serveFrontend: 'false' }));
    disabled.use((_req, res) => res.sendStatus(503)); await request(disabled).get('/admin/settings').expect(503);
  });
});
