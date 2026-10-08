'use strict';

const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { PortableRestoreJournal } = require('../../src/services/portableRestoreJournal');

// Production uses Linux local filesystems. macOS is a development-only host.
const linux = process.platform === 'linux' ? describe : describe.skip;
linux('durable portable local-file restore journal', () => {
  let fixture;
  let root;
  let source;
  const policy = key => !key.startsWith('business-docs/') && 'Not a portable managed file';
  const key = 'business-docs/a.dat';
  const second = 'business-docs/z.dat';
  const put = async (directory, name, value) => {
    await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await fs.writeFile(path.join(directory, name), value, { mode: 0o600 });
  };
  const read = name => fs.readFile(path.join(root, name), 'utf8');
  const create = () => PortableRestoreJournal.create({ storageRoot: root, validateKey: policy });
  const load = journal => PortableRestoreJournal.load({ storageRoot: root, id: journal.id, validateKey: policy });

  beforeEach(async () => {
    fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-owned-journal-'));
    root = path.join(fixture, 'storage');
    source = path.join(fixture, 'source');
    await fs.mkdir(root);
    await fs.mkdir(source);
    await put(root, key, 'original-first');
    await put(source, key, 'restored-first');
    await put(source, second, 'restored-second');
  });
  afterEach(async () => { await fs.rm(fixture, { recursive: true, force: true }); });

  test('ordinary promotion verifies matching bytes and rollback preserves prior files, metadata and unrelated data', async () => {
    await put(root, 'business-docs/unrelated.dat', 'untouched');
    await fs.chmod(path.join(root, key), 0o640);
    await fs.utimes(path.join(root, key), 1000, 2000);
    const journal = await create();
    await journal.prepare(source, [key, second]);
    expect(await read(key)).toBe('original-first');
    await journal.promote(source);
    await (await load(journal)).verifyCommitted();
    expect(await read(key)).toBe('restored-first');
    expect(await read(second)).toBe('restored-second');
    await (await load(journal)).rollback();
    await (await load(journal)).rollback();
    expect(await read(key)).toBe('original-first');
    expect(await read('business-docs/unrelated.dat')).toBe('untouched');
    await expect(read(second)).rejects.toMatchObject({ code: 'ENOENT' });
    const stat = await fs.stat(path.join(root, key));
    expect(stat.mode & 0o777).toBe(0o640);
    expect(stat.mtimeMs).toBe(2000000);
  });

  test('a later directory collision is rejected before any live replacement', async () => {
    await fs.mkdir(path.join(root, second));
    await put(root, `${second}/sentinel`, 'retained');
    const journal = await create();
    await expect(journal.prepare(source, [key, second])).rejects.toMatchObject({ code: 'RESTORE_JOURNAL_UNSAFE' });
    expect(await read(key)).toBe('original-first');
    expect(await read(`${second}/sentinel`)).toBe('retained');
    await (await load(journal)).rollback();
    await (await load(journal)).rollback();
  });

  test('failure after the first live replacement is recoverable from a fresh journal object', async () => {
    const journal = await create();
    await journal.prepare(source, [key, second]);
    await expect(journal.promote(source, { onStep: () => { throw new Error('injected disk failure'); } })).rejects.toThrow('injected disk failure');
    expect(await read(key)).toBe('restored-first');
    await (await load(journal)).rollback();
    expect(await read(key)).toBe('original-first');
    await expect(read(second)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('a truncated complete-looking prefix is rejected before promotion or recovery writes', async () => {
    const journal = await create();
    await journal.prepare(source, [key, second]);
    const bytes = await fs.readFile(journal.plan, 'utf8');
    await fs.writeFile(journal.plan, `${bytes.split('\n')[0]}\n`);
    await expect(journal.promote(source)).rejects.toMatchObject({ code: 'RESTORE_JOURNAL_UNSAFE' });
    await expect((await load(journal)).rollback()).rejects.toMatchObject({ code: 'RESTORE_JOURNAL_UNSAFE' });
    expect(await read(key)).toBe('original-first');
  });

  test('corrupt later undo refuses the entire rollback without restoring an earlier file', async () => {
    await put(root, second, 'original-second');
    const journal = await create();
    await journal.prepare(source, [key, second]);
    await journal.promote(source);
    await fs.writeFile(path.join(journal.directory, 'undo', '1'), 'corrupt');
    await expect((await load(journal)).rollback()).rejects.toThrow();
    expect(await read(key)).toBe('restored-first');
    expect(await read(second)).toBe('restored-second');
  });

  test('redirected parents and hard-linked destinations never change their targets', async () => {
    const outside = path.join(fixture, 'outside');
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(root, 'business-docs', 'redirect'));
    await put(source, 'business-docs/redirect/target.dat', 'new');
    await expect((await create()).prepare(source, ['business-docs/redirect/target.dat'])).rejects.toThrow();
    await fs.link(path.join(root, key), path.join(root, second));
    await expect((await create()).prepare(source, [key])).rejects.toThrow();
    expect(await read(key)).toBe('original-first');
    expect(await fs.readdir(outside)).toEqual([]);
  });

  test('destination changes after preflight refuse promotion before replacing prior bytes', async () => {
    const journal = await create();
    await journal.prepare(source, [key, second]);
    await put(root, second, 'out-of-band');
    await expect(journal.promote(source)).rejects.toMatchObject({ code: 'RESTORE_JOURNAL_UNSAFE' });
    expect(await read(key)).toBe('original-first');
    expect(await read(second)).toBe('out-of-band');
  });

  test('new nested directories are removed after rollback and absent unpromoted parents are safe', async () => {
    const nested = 'business-docs/new/nested/new.dat';
    await put(source, nested, 'new');
    let journal = await create();
    await journal.prepare(source, [nested]);
    await journal.rollback();
    await expect(fs.stat(path.join(root, 'business-docs/new'))).rejects.toMatchObject({ code: 'ENOENT' });
    journal = await create();
    await journal.prepare(source, [nested]);
    await journal.promote(source);
    await (await load(journal)).rollback();
    await expect(fs.stat(path.join(root, 'business-docs/new'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test.each(['../outside', 'business-docs/../outside', 'business-docs/a\0.dat', '.picpeak-maintenance/evil'])('rejects unsafe key %p', async name => {
    await expect((await create()).prepare(source, [name])).rejects.toMatchObject({ code: 'RESTORE_JOURNAL_UNSAFE' });
    expect(await read(key)).toBe('original-first');
  });

  test('SIGKILL after a durable replacement recovers old bytes in a fresh process', async () => {
    const journal = await create();
    await journal.prepare(source, [key, second]);
    const modulePath = require.resolve('../../src/services/portableRestoreJournal');
    const script = `const {PortableRestoreJournal}=require(process.argv[1]);
      (async()=>{const j=await PortableRestoreJournal.load({storageRoot:process.argv[2],id:process.argv[3],validateKey:k=>!k.startsWith('business-docs/')});
        await j.promote(process.argv[4],{onStep:()=>process.kill(process.pid,'SIGKILL')});})().catch(e=>{console.error(e);process.exit(1)});`;
    const exit = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', script, modulePath, root, journal.id, source], { stdio: ['ignore', 'ignore', 'pipe'] });
      let errors = '';
      child.stderr.on('data', data => { errors += data.toString(); });
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal, errors }));
    });
    expect(exit).toEqual({ code: null, signal: 'SIGKILL', errors: '' });
    expect(await read(key)).toBe('restored-first');
    await (await load(journal)).rollback();
    expect(await read(key)).toBe('original-first');
    await expect(read(second)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
