const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { execFileSync, spawn } = require('child_process');
const runner = require('../src/services/nativeProcessRunner');
const capabilities = require('../src/services/mediaCapabilities');
const { parseStat } = require('../src/services/linuxProcessLease');
// The guarded path itself: only where it can exist. Everything a host
// without it does instead is in __tests__/services/mediaDegradation.test.js.
const built = process.platform === 'linux' && require('fs').existsSync(capabilities.GUARD) &&
  require('fs').existsSync(path.join(path.dirname(capabilities.GUARD), 'local-process-lease.node'));
const linux = built ? describe : describe.skip;

linux('the process guard and kernel leases, where the host has them', () => {
  let dir, fixture;
  beforeAll(async () => {
    // If this fails the guard is built but cannot trace here (seccomp,
    // ptrace_scope): the backend would run unguarded and say so at startup.
    expect(await capabilities.probe()).toMatchObject({ guard: true, leases: true });
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'owned-media-runner-test-'));
    fixture = path.join(dir, 'fixture');
    execFileSync(process.env.CC || 'cc', ['-O0', '-pthread', path.join(__dirname, 'fixtures/mediaProcessFixture.c'), '-o', fixture]);
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
      catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return; throw error; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Owned native PID ${pid} remained live`);
  }
  test('ordinary child observes hard AS/CPU/file limits and cannot multiply them with fork', async () => {
    expect((await run('limits')).stdout.toString().trim()).toBe('67108864 1 65536');
    expect((await run('fork')).stdout.toString().trim()).toBe('process fork denied');
    expect((await run('untraced')).stdout.toString().trim()).toBe('untraced clone denied');
    expect((await run('uring')).stdout.toString().trim()).toBe('kernel IO thread creation denied');
    // 0 means "no limit of its own" for memory and CPU time (a transcode).
    expect((await run('limits', { memoryBytes: 0, cpuSeconds: 0 })).stdout.toString().trim()).toBe('18446744073709551615 18446744073709551615 65536');
  });
  test('a command that itself exits 125 is its own failure; the guard stays in use', async () => {
    await expect(run('exit125')).rejects.toMatchObject({ exitCode: 125, message: expect.stringMatching(/failed \(125\)/) });
    expect(capabilities.current().guard).toBe(true);
    expect((await run('limits')).stdout.toString().trim()).toBe('67108864 1 65536');
  });
  test('a job that waited longer than its whole budget still gets all of it once it starts', async () => {
    const slow = [run('sleep', { wallMs: 700 }).catch(error => error), run('sleep', { wallMs: 700 }).catch(error => error)];
    const queued = run('limits', { wallMs: 300 });
    expect((await queued).stdout.toString().trim()).toBe('67108864 1 65536');
    for (const outcome of await Promise.all(slow)) expect(outcome.code).toBe('MEDIA_TIMEOUT');
  });
  test('even a job outside a durable attempt holds a protected kernel lease until terminal cleanup', async () => {
    const kernelLease = require('../src/services/linuxKernelLease');
    let automaticPath;
    await run('limits', { onStart: async lease => {
      automaticPath = await fs.readlink(`/proc/${lease.pid}/fd/9`);
      expect(await kernelLease.probe(automaticPath, lease)).toBe('busy');
    } });
    expect(path.dirname(automaticPath)).toBe(capabilities.current().leaseRoot);
    expect(path.basename(automaticPath)).toMatch(/^[0-9a-f-]{36}\.exec\.lease$/);
    await expect(fs.stat(automaticPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  test('guardian death cannot bypass a busy same-inode kernel proof with a missing or zombie leader', async () => {
    const kernelLease = require('../src/services/linuxKernelLease');
    const originalProbe = kernelLease.probe;
    const leasePath = path.join(dir, 'last-thread-proof.lease');
    let held = true, lease, finished = false, stopped = false;
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const probe = jest.spyOn(kernelLease, 'probe').mockImplementation((filename, expected) =>
      filename === leasePath && held ? Promise.resolve('busy') : originalProbe(filename, expected));
    const failure = new Error('Owned guardian died during registration');
    const job = run('sleep', { leasePath,
      onStart: value => { lease = value; process.kill(value.guardianPid, 'SIGKILL'); started(); throw failure; },
      onFinish: () => { finished = true; },
    });
    const observed = expect(job).rejects.toBe(failure);
    try {
      await ready; await dead(lease.pid);
      const stopping = runner.stop().then(() => { stopped = true; });
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(finished).toBe(false); expect(stopped).toBe(false);
      expect(probe).toHaveBeenCalledWith(leasePath, { device: lease.device, inode: lease.inode, filesystem: lease.filesystem });
      held = false; await stopping; await observed;
      expect(finished).toBe(true);
    } finally { held = false; probe.mockRestore(); await runner.stop(); }
  });
  test('tiny-stack native threads cannot exceed the hard per-job count', async () => {
    let pid;
    await expect(run('threads', { memoryBytes: 256 * 1024 * 1024, threadLimit: 8, onStart: lease => { pid = lease.pid; } }))
      .rejects.toMatchObject({ code: 'MEDIA_RESOURCE_LIMIT', threadLimit: true });
    await dead(pid);
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
      memoryBytes: 768 * 1024 * 1024, cpuSeconds: 30, wallMs: 30000, leasePath: path.join(dir, 'node-worker.lease'), env: { UV_USE_IO_URING: '1' },
    });
    expect(JSON.parse(result.stdout.toString())).toEqual({ fd9: true, crypto: 8, sqlite: 7, thread: 42 });
  });
  test('the ordinary image worker can load and decode Sharp under its production native cap', async () => {
    const result = await runner.run(process.execPath,
      ['--jitless', '--no-expose-wasm', '--max-old-space-size=64', '-e',
        "const sharp=require('sharp');sharp({create:{width:16,height:16,channels:3,background:'white'}}).jpeg().toBuffer().then(bytes=>sharp(bytes).metadata()).then(meta=>process.stdout.write(JSON.stringify({width:meta.width,height:meta.height,format:meta.format}))).catch(error=>{process.stderr.write(error.stack);process.exitCode=1})"],
      { memoryBytes: 768 * 1024 * 1024, cpuSeconds: 30, wallMs: 30000 }).catch(error => {
      throw new Error(`Owned ordinary Sharp control failed (${error.exitCode}/${error.signal}): ${error.cause?.message || error.message}`, { cause: error });
    });
    expect(JSON.parse(result.stdout.toString())).toEqual({ width: 16, height: 16, format: 'jpeg' });
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
  test('an ordinary wrapped FFmpeg errno is not misclassified as a native resource signal', async () => {
    await expect(run('ordinary-error')).rejects.toMatchObject({ exitCode: 234 });
  });
  test('timeout, cancellation and stop await termination and lease writes', async () => {
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
      // The controller also prints the one-line capability report; the lease is the JSON line.
      controller.stdout.on('data', chunk => {
        text += chunk;
        const line = text.split('\n').slice(0, -1).find(item => item.startsWith('{'));
        if (line) resolve(JSON.parse(line));
      });
      controller.on('error', reject); controller.on('exit', () => { if (!text) reject(new Error('Owned controller exited before handshake')); });
    });
    controller.kill('SIGKILL');
    await new Promise(resolve => controller.once('close', resolve));
    await dead(lease.pid); await dead(lease.guardianPid);
  });
  test('registration failure cannot skip abnormal child-death proof or the finish I/O barrier', async () => {
    const failure = new Error('Owned registration failed');
    let finishStarted, releaseFinish, lease;
    const ready = new Promise(resolve => { finishStarted = resolve; });
    const barrier = new Promise(resolve => { releaseFinish = resolve; });
    const job = run('sleep', {
      onStart: async value => {
        lease = value; process.kill(value.guardianPid, 'SIGKILL'); throw failure;
      },
      onFinish: async () => { await dead(lease.pid); finishStarted(); await barrier; },
    });
    const rejected = expect(job).rejects.toBe(failure);
    await ready;
    let stopped = false;
    const stopping = runner.stop().then(() => { stopped = true; });
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(stopped).toBe(false);
    releaseFinish(); await stopping; await rejected;
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
  test('a replaced busy inode cannot acknowledge the recorded execution owner', async () => {
    const kernelLease = require('../src/services/linuxKernelLease');
    const originalPath = path.join(dir, 'replaced.lease'), movedPath = path.join(dir, 'recorded.lease');
    const recorded = await kernelLease.acquire(originalPath);
    let replacement;
    try {
      await fs.rename(originalPath, movedPath);
      replacement = await kernelLease.acquire(originalPath);
      expect(await kernelLease.probe(originalPath)).toBe('busy');
      expect(await kernelLease.probe(originalPath, recorded)).toBe('unknown');
      expect(await kernelLease.probe(originalPath, replacement)).toBe('busy');
      expect(await kernelLease.probe(movedPath, recorded)).toBe('busy');
    } finally {
      if (replacement) await replacement.release();
      await recorded.release();
    }
    expect(await kernelLease.probe(originalPath, replacement)).toBe('free');
    expect(await kernelLease.probe(movedPath, recorded)).toBe('free');
  });
  test('native code cannot unlock the guardian lease through FD9 or a duplicate, including abnormal guardian death', async () => {
    const kernelLease = require('../src/services/linuxKernelLease');
    const leasePath = path.join(dir, 'protected.lease'), ready = path.join(dir, 'unlock-denied');
    let lease;
    const job = run('unlock', { leasePath, onStart: value => { lease = value; } }, [ready]);
    // A guardian killed from outside is "not now", not a verdict on the media.
    const rejected = expect(job).rejects.toMatchObject({ code: 'MEDIA_WORKER_UNAVAILABLE', status: 503 });
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
