const crypto = require('crypto');

jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const logger = require('../../src/utils/logger');
const { validateEnvironment } = require('../../src/config/validateEnv');

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

describe('startup evidence key form', () => {
  const prev = { secret: process.env.JWT_SECRET, key: process.env.PICPEAK_EVIDENCE_KEY };
  let exit;
  const passphraseWarned = () => logger.warn.mock.calls.some(([m]) => /PICPEAK_EVIDENCE_KEY is a passphrase/.test(m));

  beforeEach(() => {
    process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
    jest.clearAllMocks();
    exit = jest.spyOn(process, 'exit').mockImplementation(() => {});
  });
  afterEach(() => {
    for (const [name, value] of [['JWT_SECRET', prev.secret], ['PICPEAK_EVIDENCE_KEY', prev.key]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    exit.mockRestore();
  });

  test('warns when the key is a passphrase, without logging it', () => {
    const passphrase = `correct horse battery staple ${crypto.randomBytes(4).toString('hex')}`;
    process.env.PICPEAK_EVIDENCE_KEY = passphrase;
    validateEnvironment();
    expect(exit).not.toHaveBeenCalled();
    expect(passphraseWarned()).toBe(true);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(passphrase);
  });

  test.each([
    ['hex', () => crypto.randomBytes(32).toString('hex')],
    ['base64', () => crypto.randomBytes(32).toString('base64')],
  ])('does not warn for a raw %s key', (_, make) => {
    process.env.PICPEAK_EVIDENCE_KEY = make();
    validateEnvironment();
    expect(passphraseWarned()).toBe(false);
  });
});
