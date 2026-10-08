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

it('the actual cold fenced listener serves bounded progress and bundled refresh before ordinary initialization', () => {
  execFileSync(process.execPath, ['-e', `
    const fs = require('fs').promises, os = require('os'), path = require('path'), crypto = require('crypto');
    (async () => {
      const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-cold-listener-')));
      process.env.TEST_DATABASE_PATH = path.join(directory, 'control.db');
      process.env.STORAGE_PATH = path.join(directory, 'storage');
      process.env.FRONTEND_DIR = path.join(directory, 'frontend');
      process.env.SERVE_FRONTEND = 'true'; process.env.PORT = '0';
      await fs.mkdir(path.join(process.env.FRONTEND_DIR, 'assets'), {recursive:true});
      await fs.writeFile(path.join(process.env.FRONTEND_DIR, 'index.html'), '<title>\u0024{BRAND_TITLE}</title><script src="/assets/index-AbCd1234.js"></script>');
      await fs.writeFile(path.join(process.env.FRONTEND_DIR, 'assets/index-AbCd1234.js'), 'window.coldMaintenance = true;');
      const { fixtureIngress } = require('./__tests__/integration/helpers/restoreIngress');
      const fixture = await fixtureIngress(path.join(process.env.STORAGE_PATH, '.picpeak-maintenance'));
      fixture.storage.identity = { host:null, bootId:crypto.randomUUID() };
      await fs.mkdir(path.join(fixture.storage.privateRoot, 'runtime'), {mode:0o700});
      const database = require('./src/database/db');
      let ordinaryStarts = 0;
      database.initializeDatabase = async () => { ordinaryStarts++; throw new Error('ordinary startup escaped fence'); };
      await require('./migrations/core/249_portable_restore_control').up(database.db);
      const attempt = crypto.randomUUID(), token = 'e'.repeat(64);
      await database.db('portable_restore_control').insert({id:1, storage_id:fixture.storage.storageId,
        state:'recovery_required', epoch:crypto.randomUUID(), attempt_id:attempt, owner_instance_id:crypto.randomUUID(),
        progress_token_hash:crypto.createHash('sha256').update(token).digest('hex')});
      const work = require('./src/services/activeApplicationWork');
      const policy = require('./src/services/portableRestoreCoordinator');
      const runtime = policy.createCoordinator({ database:database.db, work, leases:fixture.leases, ingress:fixture.ingress,
        worker:{probeWorkerLease:async()=> 'unknown'}, stopServices:async()=>{}, getStorageIdentity:async()=>fixture.storage,
        pollInterval:10, autoPoll:false });
      require.cache[require.resolve('./src/services/portableRestoreCoordinator')].exports = runtime;
      const server = require('./server');
      let listener; const listen = server.listen;
      server.listen = (...args) => { listener = listen.apply(server, args); return listener; };
      const starting = server.startServer();
      for (let i=0; i<100 && !listener?.listening; i++) await new Promise(done=>setTimeout(done,10));
      if (!listener?.listening || ordinaryStarts) throw new Error('Cold maintenance listener did not precede ordinary startup');
      const origin = 'http://127.0.0.1:'+listener.address().port;
      const get = async (route, options={}) => {
        const response = await fetch(origin+route,{...options,signal:AbortSignal.timeout(2000)});
        return {status:response.status,text:await response.text()};
      };
      const progress = await get('/api/admin/backup/picpeak/restore/'+attempt, {headers:{'x-picpeak-restore-progress':token}});
      if (progress.status!==200 || JSON.parse(progress.text).state!=='recovery_required') throw new Error('Cold progress unavailable');
      const shell = await get('/admin/settings?tab=backup');
      if (shell.status!==200 || !shell.text.includes('<title>PicPeak</title>')) throw new Error('Bundled shell refresh unavailable');
      if ((await get('/assets/index-AbCd1234.js')).status!==200) throw new Error('Bundled hashed asset unavailable');
      for (const route of ['/health','/api/public/settings','/api/admin/users','/uploads/logos/test.png','/admin/users']) {
        if ((await get(route)).status!==503) throw new Error('Cold ordinary route escaped: '+route);
      }
      if ((await get('/api/admin/backup/picpeak/import',{method:'POST'})).status!==401) throw new Error('Cold POST auth escaped');
      await server.stopServer(); await starting;
      if (ordinaryStarts) throw new Error('Ordinary initializer ran while fenced');
      await fs.rm(directory,{recursive:true,force:true});
      process.exitCode=0; // Explicit shutdown makes the pending startup reject safely.
    })().catch(error=>{console.error(error.stack);process.exit(1);});
  `], { cwd: path.resolve(__dirname, '../..'), env: { ...process.env, NODE_ENV: 'test', DATABASE_CLIENT: 'sqlite3',
    SKIP_S3_TESTS: 'true', PICPEAK_EVIDENCE_KEY: 'a'.repeat(64),
    JWT_SECRET: 'isolated-cold-startup-secret-with-sufficient-length' }, timeout: 20000, stdio: 'inherit' });
});
