const { execFileSync } = require('child_process');
const path = require('path');

it('loading the constructed server starts no application timer or ordinary database initialization', () => {
  execFileSync(process.execPath, ['-e', `
    const original = global.setInterval;
    const starts = [];
    global.setInterval = (...args) => { starts.push(new Error().stack); return original(...args); };
    const database = require('./src/database/db');
    database.initializeDatabase = async () => { throw new Error('ordinary initialization before recovery'); };
    const server = require('./server');
    if (starts.some(stack => /src[\\/]((services|middleware|utils)[\\/])/.test(stack))) {
      throw new Error('Application timer started at server import');
    }
    if (server.listening || require('./src/services/portableRestoreCoordinator').isInitialized()) {
      throw new Error('Server import started runtime admission');
    }
    database.db.destroy().then(() => {});
  `], { cwd: path.resolve(__dirname, '../..'), env: { ...process.env, NODE_ENV: 'test', DATABASE_CLIENT: 'sqlite3',
    SKIP_S3_TESTS: 'true', JWT_SECRET: 'isolated-startup-fixture-secret-with-sufficient-length' }, timeout: 10000, stdio: 'pipe' });
});

it('new timers and callbacks constructed by runUncontrolled do not retain maintenance authority', async () => {
  const work = require('../../src/services/activeApplicationWork').createWorkRegistry();
  work.closeAdmission();
  await work.runControl(() => work.runUncontrolled(() => new Promise((resolve, reject) => {
    setImmediate(async () => {
      try {
        expect(work.isControl()).toBe(false);
        await expect(work.track('ordinary callback', async () => {})).rejects.toMatchObject({ code: 'RESTORE_MAINTENANCE' });
        resolve();
      } catch (error) { reject(error); }
    });
  })));
});

it('the actual unstarted server fails closed before health/static/ordinary admin and OPTIONS dispatch', () => {
  execFileSync(process.execPath, ['-e', `
    const request = require('supertest');
    const server = require('./server');
    (async () => {
      for (const [method, url] of [['get','/health'], ['get','/api/admin/users'], ['get','/uploads/logos/test.png'],
        ['get','/api/public/settings'], ['options','/api/admin/users']]) {
        const response = await request(server)[method](url).set('X-Picpeak-Restore-Progress', 'a'.repeat(64));
        if (response.status !== 503 || response.body.code !== 'RESTORE_MAINTENANCE') throw new Error('Unstarted ingress escaped fence');
      }
      const control = await request(server).post('/api/admin/backup/picpeak/import');
      if (control.status !== 401) throw new Error('Exact control admission is not typed admin auth');
      await require('./src/database/db').db.destroy();
    })().catch(error => { console.error(error.message); process.exitCode = 1; });
  `], { cwd: path.resolve(__dirname, '../..'), env: { ...process.env, NODE_ENV: 'test', DATABASE_CLIENT: 'sqlite3',
    SKIP_S3_TESTS: 'true', JWT_SECRET: 'isolated-startup-fixture-secret-with-sufficient-length' }, timeout: 10000, stdio: 'pipe' });
});
