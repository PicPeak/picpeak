/**
 * The admin gallery preview must honour must_change_password.
 *
 * adminAuth gates the whole admin API on the flag (middleware/auth.js:52), but
 * the gallery preview never passes through adminAuth — galleryAccessService
 * authorizes it directly. So an admin issued a temporary password was locked
 * out of the admin API and could still list, view and download that gallery's
 * photos through `?admin_preview=1`: routes/gallery/{photos,media,downloads,
 * metadata}.js all accept the admin grant. The flag exists to force a rotation,
 * and a path that ignores it makes the rotation optional.
 *
 * Two halves to the fix, and the test pins both: the call now asks for
 * includeProfile (without it sessionAccessService does not select the column at
 * all, so the gate would read undefined and pass), and the flag is then
 * enforced.
 *
 * Same mocking shape as verifyGalleryAccess.customerRevoke.test.js — every
 * collaborator stubbed so this stays a fast unit test.
 */

jest.mock('../database/db', () => ({ db: jest.fn(), withRetry: jest.fn((fn) => fn()) }));
jest.mock('../utils/sessionCutoff', () => ({ isTokenBeforeCutoff: jest.fn().mockResolvedValue(false) }));
jest.mock('../utils/galleryLifecycle', () => ({
  assertGalleryAvailable: jest.fn(),
  requiresGalleryPassword: jest.fn().mockReturnValue(false),
}));
jest.mock('../middleware/permissions', () => ({ userHasAllPermissions: jest.fn().mockResolvedValue(true) }));
jest.mock('../middleware/ownership', () => ({ canAccessEvent: jest.fn().mockReturnValue(true) }));
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const adminAccount = {
  id: 4,
  username: 'rotating',
  role_name: 'super_admin',
  must_change_password: false,
};
// `mock`-prefixed so jest's module-factory hoisting allows the reference,
// same as adminAuthRoleFallback.test.js.
const mockAdminSpy = jest.fn();
jest.mock('../services/sessionAccessService', () => ({
  admin: (...args) => mockAdminSpy(...args),
  assertActive: jest.fn().mockResolvedValue(undefined),
  customer: jest.fn(),
}));

const access = require('../services/galleryAccessService');

const EVENT = { id: 11, slug: 'preview-me', is_active: true };

function grantFor() {
  return access.grant(EVENT, 'admin', { type: 'admin', id: adminAccount.id, iat: Math.floor(Date.now() / 1000) });
}

describe('admin gallery preview honours must_change_password', () => {
  beforeEach(() => {
    mockAdminSpy.mockReset();
    // Model sessionAccessService: the column only comes back when asked for.
    mockAdminSpy.mockImplementation((_session, opts = {}) => Promise.resolve(
      opts.includeProfile
        ? { ...adminAccount }
        : { id: adminAccount.id, username: adminAccount.username, role_name: adminAccount.role_name },
    ));
  });

  it('asks for the profile, so the flag is actually available to check', async () => {
    await access.authorize(EVENT, grantFor());
    expect(mockAdminSpy).toHaveBeenCalledWith(expect.anything(), { includeProfile: true });
  });

  it('denies a flagged admin with MUST_CHANGE_PASSWORD', async () => {
    adminAccount.must_change_password = true;
    try {
      await access.authorize(EVENT, grantFor());
      throw new Error('expected authorize() to reject');
    } catch (err) {
      // Fails against the previous code, which authorized the preview and let
      // the request through to the photo list.
      expect(err.code).toBe('MUST_CHANGE_PASSWORD');
      expect(err.status ?? err.statusCode).toBe(403);
    } finally {
      adminAccount.must_change_password = false;
    }
  });

  it('still lets an unflagged admin preview', async () => {
    adminAccount.must_change_password = false;
    await expect(access.authorize(EVENT, grantFor())).resolves.not.toThrow();
  });
});
