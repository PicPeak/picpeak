/**
 * Where the setup token can actually be found (#1218).
 *
 * The canonical copy goes to DATA_DIR. The all-in-one image points that at
 * /data/db — a subdirectory of its single volume — so the file lands beside the
 * database, and a NAS user browsing the volume they mounted sees `db/`,
 * `storage/`, `logs/`, `backup/` and no token. It was persisted and correct the
 * whole time, just somewhere nobody opens.
 *
 * So when DATA_ROOT names a different directory, a second copy goes there: the
 * first thing visible on opening the volume. Both are 0600 and both go away the
 * instant setup completes, which is the property that makes a second copy of a
 * single-use bootstrap secret acceptable.
 *
 * The compose stack sets no DATA_ROOT and must keep exactly one file.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('setup token discoverability (#1218)', () => {
  let tmpRoot;

  const load = ({ dataDir, dataRoot }) => {
    jest.resetModules();
    if (dataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = dataDir;
    if (dataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = dataRoot;
    return require('../../src/services/setupService');
  };

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-setup-paths-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.DATA_ROOT;
    delete process.env.DATA_DIR;
  });

  it('writes one file for the compose layout, where DATA_ROOT is unset', () => {
    const svc = load({ dataDir: path.join(tmpRoot, 'app-data') });
    expect(svc.setupTokenFilePaths()).toEqual([path.join(tmpRoot, 'app-data', 'SETUP_TOKEN')]);
  });

  it('adds a volume-root copy for the all-in-one layout', () => {
    // The shape Dockerfile.aio produces: DATA_ROOT=/data, DATA_DIR=/data/db.
    const svc = load({ dataDir: path.join(tmpRoot, 'db'), dataRoot: tmpRoot });

    expect(svc.setupTokenFilePaths()).toEqual([
      path.join(tmpRoot, 'db', 'SETUP_TOKEN'),
      path.join(tmpRoot, 'SETUP_TOKEN'),
    ]);
  });

  it('does not write the same file twice when DATA_ROOT and DATA_DIR agree', () => {
    // Nothing in the tree sets them equal today, but an operator pinning both
    // by hand must not get a duplicate write and a duplicate unlink.
    const svc = load({ dataDir: tmpRoot, dataRoot: tmpRoot });
    expect(svc.setupTokenFilePaths()).toEqual([path.join(tmpRoot, 'SETUP_TOKEN')]);
  });

  it('resolves DATA_ROOT and DATA_DIR to the same file through a trailing slash', () => {
    const svc = load({ dataDir: tmpRoot, dataRoot: `${tmpRoot}/` });
    expect(svc.setupTokenFilePaths()).toEqual([path.join(tmpRoot, 'SETUP_TOKEN')]);
  });

  it('keeps the canonical path first, so the wizard hint and the docs still match', () => {
    const svc = load({ dataDir: path.join(tmpRoot, 'db'), dataRoot: tmpRoot });
    // Callers that want one path to point at — the startup banner's first line,
    // writtenSetupTokenFile() — must get DATA_DIR, which is what every existing
    // instruction names.
    expect(svc.setupTokenFilePaths()[0]).toBe(svc.setupTokenFilePath());
  });
});
