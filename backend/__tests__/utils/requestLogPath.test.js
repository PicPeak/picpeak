const EventEmitter = require('events');
jest.mock('../../src/utils/logger', () => ({ info: jest.fn() }));
const logger = require('../../src/utils/logger');
const middleware = require('../../src/middleware/apiRequestLogger');
const { requestLogPath } = require('../../src/utils/requestLogPath');
const marker = 'SECRET_TEST_CAPABILITY';
it.each([
  `/api/gallery/g/photos?token=${marker}&password=${marker}`,
  `/api/gallery/g/verify-token/${marker}`,
  `/api/gallery/g/show/${marker}/state`,
  `/api/public/contracts/${marker}/sign`,
  `/api/customer/auth/password-reset/${marker}`,
  `/api/public/newsletter/unsubscribe/${marker}`,
])('does not log capabilities on request or response: %s', (originalUrl) => {
  logger.info.mockClear();
  const res = new EventEmitter(); res.statusCode = 200;
  middleware({ originalUrl, method: 'GET' }, res, jest.fn());
  res.emit('finish');
  expect(logger.info).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(logger.info.mock.calls)).not.toContain(marker);
});
it('retains useful non-secret routes and removes control characters', () => {
  expect(requestLogPath('/api/admin/events/12?search=private')).toBe('/api/admin/events/12');
  expect(requestLogPath('/api/admin/events\nforged')).not.toContain('\n');
});
