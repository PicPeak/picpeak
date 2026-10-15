/**
 * POST /api/admin/backup/manifest(s)/validate (issue 2089): the endpoints
 * resolve names against the directories manifests are really written to,
 * never against a fixed ../../../backups, and never put the server's absolute
 * path in the response.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';

const mockState = { config: {}, validated: [] };

jest.mock('../../src/middleware/auth', () => ({
  adminAuth: (req, _res, next) => { req.admin = { id: 1, username: 'tester' }; next(); },
}));
jest.mock('../../src/middleware/permissions', () => ({
  requirePermission: () => (_req, _res, next) => next(),
  requireSuperAdmin: () => (_req, _res, next) => next(),
}));
jest.mock('../../src/services/backupService', () => {
  const actual = jest.requireActual('../../src/services/backupService');
  return {
    ...actual,
    validateBackupManifest: jest.fn(async (file) => {
      mockState.validated.push(file);
      return { valid: false, error: `ENOENT: no such file or directory, open '${file}'` };
    }),
    // The real resolver, fed the test's configuration instead of the database.
    resolveManifestFile: (manifestPath) => actual.resolveManifestFile(manifestPath, mockState.config),
  };
});

const request = require('supertest');
const express = require('express');

describe('backup manifest validate endpoints (issue 2089)', () => {
  let app; let manifestDir; let root;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-manifest-validate-'));
    manifestDir = path.join(root, 'manifests');
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(path.join(manifestDir, 'backup-manifest-1.json'), '{}');
    mockState.config = { backup_manifest_path: manifestDir, backup_destination_path: root };
    const router = require('../../src/routes/adminBackup');
    app = express();
    app.use(express.json());
    app.use('/backup', router);
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  beforeEach(() => { mockState.validated.length = 0; });

  const post = (url, body) => request(app).post(url).send(body);

  it.each(['/backup/manifest/validate', '/backup/manifests/validate'])(
    '%s finds a manifest in the configured manifest directory', async (url) => {
      const res = await post(url, { manifestPath: 'backup-manifest-1.json' });
      expect(res.status).toBe(200);
      expect(mockState.validated).toEqual([path.join(manifestDir, 'backup-manifest-1.json')]);
      // The absolute path is replaced by the file name.
      expect(JSON.stringify(res.body)).not.toContain(root);
    },
  );

  it('does not list the destination for a manifest found in a configured directory', async () => {
    const readdir = jest.spyOn(fs.promises, 'readdir');
    try {
      const res = await post('/backup/manifest/validate', { manifestPath: 'backup-manifest-1.json' });
      expect(res.status).toBe(200);
      expect(readdir).not.toHaveBeenCalled();
    } finally {
      readdir.mockRestore();
    }
  });

  it('accepts the absolute path the status endpoint reports, when inside the directory', async () => {
    const res = await post('/backup/manifest/validate', { manifestPath: path.join(manifestDir, 'backup-manifest-1.json') });
    expect(res.status).toBe(200);
    expect(mockState.validated).toHaveLength(1);
  });

  it('finds a manifest a local backup wrote into its own run directory, by name or reported path', async () => {
    const runManifests = path.join(root, 'backup-0b1c', 'manifests');
    fs.mkdirSync(runManifests, { recursive: true });
    fs.writeFileSync(path.join(runManifests, 'backup-manifest-2.json'), '{}');
    fs.mkdirSync(path.join(root, 'backup-0b1c', 'files'), { recursive: true });
    fs.writeFileSync(path.join(root, 'backup-0b1c', 'files', 'data.json'), '{}');

    for (const manifestPath of ['backup-manifest-2.json', path.join(runManifests, 'backup-manifest-2.json')]) {
      mockState.validated.length = 0;
      const res = await post('/backup/manifest/validate', { manifestPath });
      expect(res.status).toBe(200);
      expect(mockState.validated).toEqual([path.join(runManifests, 'backup-manifest-2.json')]);
    }
    // The run's backed-up files are not manifests and stay out of reach.
    mockState.validated.length = 0;
    const res = await post('/backup/manifest/validate', { manifestPath: path.join(root, 'backup-0b1c', 'files', 'data.json') });
    expect([400, 404]).toContain(res.status);
    expect(mockState.validated).toHaveLength(0);
  });

  it('does not follow a run\'s manifests folder that is a symlink out of the destination', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-manifest-outside-'));
    fs.writeFileSync(path.join(outside, 'secret-manifest.json'), '{}');
    fs.mkdirSync(path.join(root, 'backup-link'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'backup-link', 'manifests'));
    try {
      for (const manifestPath of ['secret-manifest.json', path.join(root, 'backup-link', 'manifests', 'secret-manifest.json')]) {
        const res = await post('/backup/manifest/validate', { manifestPath });
        expect([400, 404]).toContain(res.status);
      }
      expect(mockState.validated).toHaveLength(0);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('answers 404 without a path for a manifest that does not exist', async () => {
    const res = await post('/backup/manifest/validate', { manifestPath: 'nope.json' });
    expect(res.status).toBe(404);
    expect(res.body.valid).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain(root);
    expect(mockState.validated).toHaveLength(0);
  });

  it('answers 400 for a symlink in the directory that leads outside it, and reads nothing', async () => {
    const outside = path.join(root, 'outside.json');
    fs.writeFileSync(outside, '{}');
    fs.symlinkSync(outside, path.join(manifestDir, 'escape.json'));
    const res = await post('/backup/manifest/validate', { manifestPath: 'escape.json' });
    expect(res.status).toBe(400);
    expect(mockState.validated).toHaveLength(0);
  });

  it('answers 400 for a traversal input and reads nothing', async () => {
    const res = await post('/backup/manifests/validate', { manifestPath: '../../../etc/passwd' });
    expect(res.status).toBe(400);
    expect(mockState.validated).toHaveLength(0);
  });
});
