const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { execFileSync, spawn } = require('child_process');
const runner = require('../src/services/nativeProcessRunner');
const { parseStat } = require('../src/services/linuxProcessLease');
const linux = process.platform === 'linux' ? describe : describe.skip;

linux('mandatory native media process boundary', () => {
  let dir, fixture;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'owned-media-runner-test-'));
    fixture = path.join(dir, 'fixture');
    execFileSync(process.env.CC || 'cc', ['-O0', path.join(__dirname, 'fixtures/mediaProcessFixture.c'), '-o', fixture]);
  });
  beforeEach(() => runner.start());
  afterEach(() => runner.stop());
  afterAll(async () => fs.rm(dir, { recursive: true, force: true }));
  const run = (mode, options = {}, args = []) => runner.run(fixture, [mode, ...args], {
    memoryBytes: 64 * 1024 * 1024, cpuSeconds: 1, wallMs: 5000, fileBytes: 65536,
    ...options,
  });
  async function dead(pid) {
    for (let n = 0; n < 200; n++) {
      try { if (['Z', 'X'].includes(parseStat(await fs.readFile(`/proc/${pid}/stat`, 'utf8')).state)) return; }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Owned native PID ${pid} remained live`);
  }
  test('ordinary child observes hard AS/CPU/file limits and cannot multiply them with fork', async () => {
    expect((await run('limits')).stdout.toString().trim()).toBe('67108864 1 65536');
    expect((await run('fork')).stdout.toString().trim()).toBe('process fork denied');
  });
  test('ordinary supervised Node retains FD9 and runs SQLite, crypto and worker threads under a hard native cap', async () => {
    const code = `(async()=>{
      const fs=require('fs'), crypto=require('crypto');
      const db=require('knex')({client:'sqlite3',connection:{filename:':memory:'},useNullAsDefault:true});
      await db.schema.createTable('control',t=>t.integer('id'));
      await db('control').insert({id:7});
      const {Worker}=require('worker_threads');
      const worker=new Worker("require('worker_threads').parentPort.postMessage(42)",{eval:true});
      const thread=await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject)});
      await worker.terminate();
      process.stdout.write(JSON.stringify({fd9:fs.fstatSync(9).isFile(),crypto:crypto.randomBytes(8).length,sqlite:(await db('control').first()).id,thread}));
      await db.destroy();
    })().catch(error=>{process.stderr.write(error.stack);process.exitCode=1})`;
    const result = await runner.run(process.execPath, ['--jitless', '--max-old-space-size=384', '-e', code], {
      memoryBytes: 768 * 1024 * 1024, cpuSeconds: 30, wallMs: 30000, leasePath: path.join(dir, 'node-worker.lease'),
    });
    expect(JSON.parse(result.stdout.toString())).toEqual({ fd9: true, crypto: 8, sqlite: 7, thread: 42 });
  });
  test('memory, CPU, file and pipe-output refusals terminate before promises settle', async () => {
    for (const [mode, options, args] of [
      ['memory', {}, []], ['spin', {}, []], ['file', {}, [path.join(dir, 'oversized')]],
      ['output', { outputBytes: 1024 }, []],
    ]) {
      let pid;
      await expect(run(mode, { ...options, onStart: lease => { pid = lease.pid; } }, args)).rejects.toMatchObject({ code: expect.stringMatching(/^MEDIA_(RESOURCE|OUTPUT)_LIMIT$/) });
      await dead(pid);
    }
  });
  test('queue-inclusive timeout, cancellation and stop await termination and lease writes', async () => {
    let pid;
    await expect(run('sleep', { wallMs: 100, onStart: lease => { pid = lease.pid; } })).rejects.toMatchObject({ code: 'MEDIA_TIMEOUT' });
    if (pid) await dead(pid);
    const controller = new AbortController();
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    let releaseFinish;
    const finish = new Promise(resolve => { releaseFinish = resolve; });
    const job = run('sleep', { signal: controller.signal, onStart: lease => { pid = lease.pid; started(); }, onFinish: () => finish });
    const observed = expect(job).rejects.toMatchObject({ code: 'MEDIA_CANCELLED' });
    await ready; controller.abort();
    let stopped = false;
    const stopping = runner.stop().then(() => { stopped = true; });
    await dead(pid); expect(stopped).toBe(false);
    releaseFinish(); await stopping; await observed;
  });
  test('parent death kills its guardian and native execution without host listeners', async () => {
    const controller = spawn(process.execPath, ['-e', `
      const runner=require(${JSON.stringify(path.join(__dirname, '../src/services/nativeProcessRunner'))});
      runner.run(${JSON.stringify(fixture)},['sleep'],{memoryBytes:67108864,cpuSeconds:1,wallMs:5000,
        onStart:lease=>process.stdout.write(JSON.stringify(lease)+'\\n')}).catch(()=>{});
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    const lease = await new Promise((resolve, reject) => {
      let text = '';
      controller.stdout.on('data', chunk => { text += chunk; if (text.includes('\n')) resolve(JSON.parse(text.split('\n')[0])); });
      controller.on('error', reject); controller.on('exit', () => { if (!text) reject(new Error('Owned controller exited before handshake')); });
    });
    controller.kill('SIGKILL');
    await new Promise(resolve => controller.once('close', resolve));
    await dead(lease.pid); await dead(lease.guardianPid);
  });
  test('persistent local kernel lease rejects concurrent reuse and symlinks, then becomes free only after reap', async () => {
    const kernelLease = require('../src/services/linuxKernelLease');
    const leasePath = path.join(dir, 'persistent.lease');
    expect(await kernelLease.probe(leasePath)).toBe('unknown');
    const controller = new AbortController();
    let ready;
    const started = new Promise(resolve => { ready = resolve; });
    const job = run('sleep', { leasePath, signal: controller.signal, onStart: ready });
    const observed = expect(job).rejects.toMatchObject({ code: 'MEDIA_CANCELLED' });
    await started;
    expect(await kernelLease.probe(leasePath)).toBe('busy');
    await expect(run('limits', { leasePath })).rejects.toMatchObject({ code: 'MEDIA_LEASE_BUSY' });
    controller.abort(); await observed;
    expect(await kernelLease.probe(leasePath)).toBe('free');
    const holder = await kernelLease.acquire(leasePath);
    expect(await kernelLease.probe(leasePath)).toBe('busy');
    await holder.release(); expect(await kernelLease.probe(leasePath)).toBe('free');
    expect(await kernelLease.probe(leasePath, holder)).toBe('free');
    expect(await kernelLease.probe(leasePath, { ...holder, inode: '0' })).toBe('unknown');
    expect(await kernelLease.probe(leasePath, { ...holder, filesystem: '0' })).toBe('unknown');
    const alias = path.join(dir, 'alias.lease'); await fs.symlink(leasePath, alias);
    expect(await kernelLease.probe(alias)).toBe('unknown');
  });
  test('the actual Node owner lifetime lock remains held until that Node dies, not a helper heartbeat', async () => {
    const kernelLease = require('../src/services/linuxKernelLease');
    const leasePath = path.join(dir, 'node-owner.lease');
    const owner = spawn(process.execPath, ['-e', `
      require(${JSON.stringify(path.join(__dirname, '../src/services/linuxKernelLease'))}).acquire(${JSON.stringify(leasePath)})
        .then(lease=>{process.stdout.write(JSON.stringify(lease)+'\\n');setInterval(()=>{},1000)}).catch(error=>{process.stderr.write(error.stack);process.exitCode=1});
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    const identity = await new Promise((resolve, reject) => {
      let text = '';
      owner.stdout.on('data', chunk => { text += chunk; if (text.includes('\n')) resolve(JSON.parse(text.split('\n')[0])); });
      owner.on('error', reject); owner.on('exit', () => { if (!text) reject(new Error('Owned Node lease acquisition failed')); });
    });
    expect(await kernelLease.probe(leasePath, identity)).toBe('busy');
    owner.kill('SIGKILL'); await new Promise(resolve => owner.once('close', resolve));
    expect(await kernelLease.probe(leasePath, identity)).toBe('free');
  });
  test('native code cannot unlock the guardian lease through FD9 or a duplicate, including abnormal guardian death', async () => {
    const kernelLease = require('../src/services/linuxKernelLease');
    const leasePath = path.join(dir, 'protected.lease'), ready = path.join(dir, 'unlock-denied');
    let lease;
    const job = run('unlock', { leasePath, onStart: value => { lease = value; } }, [ready]);
    const rejected = expect(job).rejects.toMatchObject({ code: 'MEDIA_WORKER_FAILED' });
    for (let n = 0; n < 200; n++) {
      try { await fs.access(ready); break; } catch (_) { await new Promise(resolve => setTimeout(resolve, 5)); }
    }
    expect(await fs.readFile(ready, 'utf8')).toContain('duplicate unlock denied');
    expect(await kernelLease.probe(leasePath, lease)).toBe('busy');
    process.kill(lease.guardianPid, 'SIGKILL');
    await rejected; await dead(lease.pid);
    expect(await kernelLease.probe(leasePath, lease)).toBe('free');
  });
});
