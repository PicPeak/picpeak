const crypto = require('crypto');

jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const logger = require('../../src/utils/logger');
const { validateEnvironment } = require('../../src/config/validateEnv');
describe('startup backup manifest trust anchor', () => {
  let previous; let exit; let status;
  const keys = ['JWT_SECRET', 'BACKUP_MANIFEST_RECOVERY_SHA256', 'BACKUP_MANIFEST_RECOVERY_REASON'];
  beforeEach(() => {
    previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
    delete process.env.BACKUP_MANIFEST_RECOVERY_SHA256;
    delete process.env.BACKUP_MANIFEST_RECOVERY_REASON;
    jest.clearAllMocks();
    exit = jest.spyOn(process, 'exit').mockImplementation(() => {});
    status = jest.spyOn(require('../../src/utils/backupManifestKey'), 'keyStatus');
  });
  afterEach(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    status.mockRestore();
    exit.mockRestore();
  });

  test('missing retained key warns without creating a replacement at startup', () => {
    status.mockReturnValue({ ready: false, source: 'missing', keyId: null });
    validateEnvironment();
    expect(exit).not.toHaveBeenCalled();
    expect(logger.warn.mock.calls.some(([message]) => /retain that external key separately/.test(message))).toBe(true);
  });

  test('invalid key configuration fails startup without disclosing material', () => {
    status.mockReturnValue({ ready: false, source: 'invalid', keyId: null });
    validateEnvironment();
    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.error.mock.calls.some(([message]) => /signing key configuration is invalid/.test(message))).toBe(true);
  });

  test('a ready external trust anchor permits normal startup', () => {
    status.mockReturnValue({ ready: true, source: 'file', keyId: 'fixture-key-id' });
    validateEnvironment();
    expect(exit).not.toHaveBeenCalled();
    expect(logger.warn.mock.calls.some(([message]) => /Backup manifest key not provisioned/.test(message))).toBe(false);
  });

  test('host recovery approval is explicitly warned without leaking its digest or reason', () => {
    status.mockReturnValue({ ready: true, source: 'file', keyId: 'fixture-key-id' });
    process.env.BACKUP_MANIFEST_RECOVERY_SHA256 = crypto.randomBytes(32).toString('hex');
    process.env.BACKUP_MANIFEST_RECOVERY_REASON = 'Private offline inspection reason';
    validateEnvironment();
    expect(exit).not.toHaveBeenCalled();
    expect(logger.warn.mock.calls.some(([message]) => /UNAUTHENTICATED backup recovery approval/.test(message))).toBe(true);
    const logged = JSON.stringify([...logger.warn.mock.calls, ...logger.error.mock.calls]);
    expect(logged).not.toContain(process.env.BACKUP_MANIFEST_RECOVERY_SHA256);
    expect(logged).not.toContain(process.env.BACKUP_MANIFEST_RECOVERY_REASON);
  });
});

describe('startup signing secret validation', () => {
  let originalSecret;
  let exit;

  beforeEach(() => {
    originalSecret = process.env.JWT_SECRET;
    jest.clearAllMocks();
    exit = jest.spyOn(process, 'exit').mockImplementation(() => {});
  });
  afterEach(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
    exit.mockRestore();
  });

  test.each([
    undefined, '', '   ', 'your-secret-key',
    'your_very_long_random_jwt_secret_here',
    'your-very-secure-jwt-secret-at-least-32-characters-long-example123456',
    ' your-very-secure-jwt-secret-at-least-32-characters-long-example123456 ',
    'a'.repeat(31), `${' '.repeat(32)}short`
  ])('refuses missing, short, or published secret %#', (secret) => {
    if (secret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = secret;
    validateEnvironment();
    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.info).not.toHaveBeenCalledWith('Environment validation passed');
  });

  test('accepts generated container/native secrets without logging them', () => {
    const secret = crypto.randomBytes(32).toString('hex');
    process.env.JWT_SECRET = secret;
    validateEnvironment();
    expect(exit).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('Environment validation passed');
    expect(JSON.stringify([...logger.info.mock.calls, ...logger.error.mock.calls])).not.toContain(secret);
  });

  test('does not expose rejected secret material in errors', () => {
    const secret = crypto.randomBytes(8).toString('hex');
    process.env.JWT_SECRET = secret;
    validateEnvironment();
    expect(exit).toHaveBeenCalledWith(1);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(secret);
  });
});
