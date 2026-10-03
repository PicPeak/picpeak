/**
 * A symlink inside EXTERNAL_MEDIA_ROOT must not lead outside it.
 *
 * safePathJoin checks the string: `root/link/x` is lexically under the root
 * even when `link` points at /etc. Browsing, the import walk and the later
 * photo reads all relied on that check alone, so a link inside the mount let
 * a scoped admin list, import and serve files from anywhere the backend can
 * read. Every path is now also canonicalised with realpath and has to land
 * under the canonical root, and the walk never follows a link.
 *
 * Driven through the real route, service and resolver against a real tree.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const request = require('supertest');

describe('external media symlink containment', () => {
  let tmpDir; let db; let app; let mediaRoot; let outside;
  let list; let resolveExternalPhotoPath; let importExternalFolder;

  const touch = async (full) => {
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, 'not-a-real-jpeg');
  };

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-extlink-'));
    mediaRoot = path.join(tmpDir, 'media');
    outside = path.join(tmpDir, 'outside');

    // root/
    //   inside/a.jpg
    //   inside/linked.jpg      -> outside/secret.jpg       (file link)
    //   inside/nested-link/    -> outside/                 (dir link, nested)
    //   link/                  -> outside/                 (dir link, top level)
    // outside/secret.jpg
    await touch(path.join(mediaRoot, 'inside', 'a.jpg'));
    await touch(path.join(outside, 'secret.jpg'));
    await fs.promises.symlink(path.join(outside, 'secret.jpg'), path.join(mediaRoot, 'inside', 'linked.jpg'));
    await fs.promises.symlink(outside, path.join(mediaRoot, 'inside', 'nested-link'));
    await fs.promises.symlink(outside, path.join(mediaRoot, 'link'));

    process.env.NODE_ENV = 'test';
    process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'data', 'db.sqlite');
    await fs.promises.mkdir(path.dirname(process.env.TEST_DATABASE_PATH), { recursive: true });
    process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
    process.env.EXTERNAL_MEDIA_ROOT = mediaRoot;
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'extlink-secret';

    jest.resetModules();

    jest.doMock('../../src/middleware/auth', () => ({
      adminAuth: (req, _res, next) => { req.admin = { id: 1, username: 'tester', roleName: 'admin' }; next(); },
    }));
    jest.doMock('../../src/middleware/permissions', () => ({
      requirePermission: () => (_req, _res, next) => next(),
    }));
    jest.doMock('../../src/middleware/ownership', () => ({
      requireEventOwnership: (_req, _res, next) => next(),
    }));
    jest.doMock('sharp', () => () => ({ metadata: async () => ({ width: 100, height: 200 }) }));
    jest.doMock('../../src/services/imageProcessor', () => ({
      generateThumbnail: jest.fn(async () => 'thumbnails/mock.jpg'),
      ensureThumbnail: jest.fn(),
      extractCaptureDate: jest.fn(async () => null),
      orientedDimensions: (m) => ({ width: m.width, height: m.height }),
    }));
    jest.doMock('../../src/utils/logger', () => ({
      debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    }));

    ({ db } = await require('./helpers/crmDb').bootCrmDb());
    ({ list, resolveExternalPhotoPath } = require('../../src/services/externalMediaService'));
    ({ importExternalFolder } = require('../../src/services/externalImportService'));

    app = express();
    app.use(express.json());
    app.use('/api/admin/external-media', require('../../src/routes/adminExternalMedia'));
  }, 180000);

  afterAll(async () => {
    if (db) await db.destroy?.();
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  async function seedEvent() {
    const [e] = await db('events').insert({
      slug: `extlink-${Math.random().toString(36).slice(2, 8)}`,
      event_type: 'wedding',
      event_name: 'extlink',
      event_date: '2026-01-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_link: `extlink-${Math.random()}`,
      expires_at: new Date().toISOString(),
      source_mode: 'reference',
    }).returning('id');
    return typeof e === 'object' ? e.id : e;
  }

  describe('browsing', () => {
    it('does not list a link, to a directory or a file', async () => {
      const top = await list('');
      expect(top.entries.map((e) => e.name)).toEqual(['inside']);
      const inside = await list('inside');
      expect(inside.entries.map((e) => e.name)).toEqual(['a.jpg']);
    });

    it('refuses to list through a link', async () => {
      await expect(list('link')).rejects.toThrow('Path traversal attempt detected');
      await expect(list('inside/nested-link')).rejects.toThrow('Path traversal attempt detected');
      const res = await request(app).get('/api/admin/external-media/list').query({ path: 'link' });
      expect(res.status).toBe(400);
    });
  });

  describe('importing', () => {
    it('refuses a folder that is a link out of the root, with a 400', async () => {
      const eventId = await seedEvent();
      const res = await request(app)
        .post(`/api/admin/external-media/events/${eventId}/import-external`)
        .send({ external_path: 'link', recursive: true });
      expect(res.status).toBe(400);
      expect(await db('photos').where({ event_id: eventId })).toEqual([]);
      // The event was not pointed at it either.
      expect((await db('events').where({ id: eventId }).first()).external_path).toBeNull();
    });

    it('refuses a folder reached through a nested link', async () => {
      const eventId = await seedEvent();
      await expect(importExternalFolder({ eventId, externalPath: 'inside/nested-link' }))
        .rejects.toMatchObject({ code: 'PATH_OUTSIDE_BASE' });
    });

    it('walks a real folder recursively without following the links inside it', async () => {
      const eventId = await seedEvent();
      const result = await importExternalFolder({ eventId, externalPath: 'inside', recursive: true });
      expect(result.imported).toBe(1);
      const rows = await db('photos').where({ event_id: eventId });
      expect(rows.map((r) => r.external_relpath)).toEqual([path.join('inside', 'a.jpg')]);
    });
  });

  describe('reading an imported photo', () => {
    it('refuses a stored path that now leads through a link', async () => {
      expect(() => resolveExternalPhotoPath({ external_relpath: 'link/secret.jpg' }))
        .toThrow('Path traversal attempt detected');
      expect(() => resolveExternalPhotoPath({ external_relpath: 'inside/linked.jpg' }))
        .toThrow('Path traversal attempt detected');
    });

    it('still resolves a real file, and a missing one, to the lexical path', () => {
      expect(resolveExternalPhotoPath({ external_relpath: 'inside/a.jpg' }))
        .toBe(path.join(path.resolve(mediaRoot), 'inside', 'a.jpg'));
      expect(resolveExternalPhotoPath({ external_relpath: 'inside/gone.jpg' }))
        .toBe(path.join(path.resolve(mediaRoot), 'inside', 'gone.jpg'));
    });
  });
});
