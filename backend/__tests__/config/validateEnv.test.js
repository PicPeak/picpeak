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
