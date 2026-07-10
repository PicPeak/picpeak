/**
 * resolveLogoFile — verifies the path-priority chain + the
 * unsupported-format guard. fs + appSettings + storage config are
 * mocked so the test is fully deterministic.
 */

jest.mock('../../src/utils/appSettings', () => ({
  getAppSetting: jest.fn(),
}));
jest.mock('../../src/config/storage', () => ({
  getStoragePath: jest.fn(() => '/app/storage'),
}));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const fs = require('fs');
const { resolveLogoFile } = require('../../src/utils/resolveLogoFile');
const { getAppSetting } = require('../../src/utils/appSettings');

describe('resolveLogoFile', () => {
  let existsSpy, statSpy;

  beforeEach(() => {
    existsSpy = jest.spyOn(fs, 'existsSync');
    statSpy = jest.spyOn(fs, 'statSync');
    existsSpy.mockReturnValue(false);
    statSpy.mockImplementation(() => ({ isFile: () => true }));
    getAppSetting.mockReset();
  });

  afterEach(() => {
    existsSpy.mockRestore();
    statSpy.mockRestore();
  });

  it('returns null when no sources are configured', async () => {
    getAppSetting.mockResolvedValue(null);
    const out = await resolveLogoFile({});
    expect(out).toBeNull();
  });

  it('prefers business_profile.logo_path over branding fallbacks', async () => {
    // The profile path exists, branding doesn't.
    existsSpy.mockImplementation((p) => p === '/app/storage/uploads/logos/profile.png');
    getAppSetting.mockResolvedValue('/uploads/logos/branding.png');
    const out = await resolveLogoFile({
      logo_path: 'uploads/logos/profile.png',
    });
    expect(out).toBe('/app/storage/uploads/logos/profile.png');
  });

  it('falls back to branding_logo_path when profile is empty', async () => {
    existsSpy.mockImplementation((p) => p === '/app/storage/uploads/logos/branding.png');
    getAppSetting.mockImplementation(async (key) => {
      if (key === 'branding_logo_path') return '/app/storage/uploads/logos/branding.png';
      return null;
    });
    const out = await resolveLogoFile({ logo_path: '' });
    expect(out).toBe('/app/storage/uploads/logos/branding.png');
  });

  it('falls back to branding_logo_url when branding_logo_path is absent', async () => {
    existsSpy.mockImplementation((p) => p === '/app/storage/uploads/logos/branding.png');
    getAppSetting.mockImplementation(async (key) => {
      if (key === 'branding_logo_url') return '/uploads/logos/branding.png';
      return null;
    });
    const out = await resolveLogoFile({});
    expect(out).toBe('/app/storage/uploads/logos/branding.png');
  });

  it('skips SVG (PDFKit cannot embed)', async () => {
    existsSpy.mockImplementation((p) => p === '/app/storage/uploads/logos/logo.svg');
    getAppSetting.mockResolvedValue(null);
    const out = await resolveLogoFile({ logo_path: 'uploads/logos/logo.svg' });
    expect(out).toBeNull();
  });

  it('also rejects WebP / GIF / TIFF', async () => {
    for (const ext of ['webp', 'gif', 'tif', 'tiff']) {
      existsSpy.mockReturnValue(true);
      statSpy.mockImplementation(() => ({ isFile: () => true }));
      existsSpy.mockImplementation((p) => p === `/app/storage/uploads/logos/logo.${ext}`);
      getAppSetting.mockResolvedValue(null);
      const out = await resolveLogoFile({ logo_path: `uploads/logos/logo.${ext}` });
      expect(out).toBeNull();
    }
  });

  it('accepts PNG and JPEG', async () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'PNG', 'JPG']) {
      existsSpy.mockImplementation((p) => p === `/app/storage/uploads/logos/logo.${ext}`);
      getAppSetting.mockResolvedValue(null);
      const out = await resolveLogoFile({ logo_path: `uploads/logos/logo.${ext}` });
      expect(out).toBe(`/app/storage/uploads/logos/logo.${ext}`);
    }
  });

  it('treats absolute paths as-is when they exist', async () => {
    existsSpy.mockImplementation((p) => p === '/abs/path/logo.png');
    getAppSetting.mockResolvedValue(null);
    const out = await resolveLogoFile({ logo_path: '/abs/path/logo.png' });
    expect(out).toBe('/abs/path/logo.png');
  });
});
