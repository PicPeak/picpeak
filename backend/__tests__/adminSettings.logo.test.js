const fs = require('fs');
const fsPromises = fs.promises;
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');

describe('Admin settings logo upload flow', () => {
  let tmpDir;
  let router;
  let app;
  let settingsStore;

  const resetModules = () => {
    jest.resetModules();
    jest.clearAllMocks();
  };

  beforeEach(async () => {
    resetModules();

    tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'picpeak-logo-'));
    process.env.STORAGE_PATH = tmpDir;

    settingsStore = new Map();

    const buildQuery = (table) => {
      const filters = [];
      const applyFilters = (rows) => {
        if (filters.length === 0) {
          return rows;
        }
        return rows.filter((row) =>
          filters.every(({ column, value }) => row[column] === value)
        );
      };

      const makeRow = (row) => ({ ...row });

      return {
        where(column, value) {
          filters.push({ column, value });
          return this;
        },
        first() {
          if (table === 'app_settings') {
            const rows = applyFilters(Array.from(settingsStore.values()).map(makeRow));
            return Promise.resolve(rows[0]);
          }
          return Promise.resolve(undefined);
        },
        select() {
          return Promise.resolve([]);
        },
        sum() {
          return Promise.resolve({ total: 0 });
        },
        join() {
          return this;
        },
        groupBy() {
          return this;
        },
        orderBy() {
          return this;
        },
        limit() {
          return this;
        },
        insert(payload) {
          const rows = Array.isArray(payload) ? payload : [payload];
          const upsert = (row, overrides = {}) => {
            if (table === 'app_settings') {
              const key = row.setting_key;
              const existing = settingsStore.get(key) || {};
              settingsStore.set(key, { ...existing, ...row, ...overrides });
            }
            return Promise.resolve();
          };

          return {
            onConflict() {
              return {
                merge(overrides) {
                  return Promise.all(rows.map((row) => upsert(row, overrides))).then(() => undefined);
                }
              };
            }
          };
        }
      };
    };

    const dbMock = jest.fn((table) => buildQuery(table));
    dbMock.raw = jest.fn();
    dbMock.transaction = async (handler) => handler({
      commit: async () => {},
      rollback: async () => {}
    });

    jest.doMock('../src/database/db', () => ({
      db: dbMock,
      logActivity: jest.fn()
    }));

    jest.doMock('../src/middleware/auth', () => ({
      adminAuth: (req, res, next) => {
        req.admin = { id: 1, username: 'tester' };
        next();
      }
    }));

    jest.doMock('../src/services/publicSiteService', () => ({
      clearPublicSiteCache: jest.fn(),
      getDefaultPublicSitePayload: jest.fn(),
      getRawPublicSiteSettings: jest.fn().mockResolvedValue({})
    }));

    jest.doMock('../src/services/rateLimitService', () => ({
      clearSettingsCache: jest.fn()
    }));

    jest.doMock('../src/middleware/maintenance', () => ({
      maintenanceMiddleware: (req, res, next) => next(),
      clearMaintenanceCache: jest.fn()
    }));

    router = require('../src/routes/adminSettings');

    app = express();
    app.use(express.json());
    app.use('/api/admin/settings', router);
  });

  afterEach(async () => {
    resetModules();
    if (tmpDir) {
      await fsPromises.rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
    delete process.env.STORAGE_PATH;
  });

  it('stores logo uploads under STORAGE_PATH and deletes on branding reset', async () => {
    const fileBuffer = Buffer.from('fake image data');

    const uploadResponse = await request(app)
      .post('/api/admin/settings/logo')
      .attach('logo', fileBuffer, 'logo.png');

    expect(uploadResponse.status).toBe(200);
    expect(uploadResponse.body).toHaveProperty('logoUrl');
    const logoUrl = uploadResponse.body.logoUrl;
    expect(logoUrl.startsWith('/uploads/logos/')).toBe(true);

    const storedPath = path.join(tmpDir, logoUrl.replace('/uploads/', 'uploads/'));
    await expect(fsPromises.access(storedPath)).resolves.toBeUndefined();

    await request(app)
      .put('/api/admin/settings/branding')
      .send({
        company_name: 'Test Co',
        company_tagline: 'Tagline',
        support_email: 'test@example.com',
        footer_text: 'Footer',
        watermark_enabled: false,
        watermark_position: 'bottom-right',
        watermark_opacity: 0.5,
        watermark_size: 'medium',
        favicon_url: null,
        logo_url: '',
        watermark_logo_url: null,
        logo_size: 'medium',
        logo_max_height: 120,
        logo_position: 'left',
        logo_display_header: true,
        logo_display_hero: false,
        logo_display_mode: 'default'
      })
      .expect(200);

    await expect(fsPromises.access(storedPath)).rejects.toThrow();
  });
});
