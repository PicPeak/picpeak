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
 * The flag is projected unconditionally by sessionAccessService, so this path
 * deliberately does NOT pass includeProfile - that would also pull in
 * roles.display_name and make the query fail, and fall back to a fabricated
 * super_admin, on a schema missing only that column.
 *
 * That contract lives in two places, so it is pinned in two places: the
 * projection itself is covered by
 * __tests__/middleware/adminAuthRoleFallbackMustChangePassword.test.js, whose
 * db mock honours select(); this file covers the enforcement, and asserts the
 * call does not opt into the profile.
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
    // Model sessionAccessService's real contract: the flag is projected
    // unconditionally, so it comes back whether or not options are passed.
    mockAdminSpy.mockImplementation(() => Promise.resolve({ ...adminAccount }));
  });

  it('does not opt into the profile, which would add a roles.display_name dependency', async () => {
    await access.authorize(EVENT, grantFor());
    const [, opts] = mockAdminSpy.mock.calls[0];
    expect(opts?.includeProfile).toBeFalsy();
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
