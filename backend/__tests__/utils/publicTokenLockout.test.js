const { _internal: guards } = require('../../src/utils/publicTokenGuards');
beforeEach(() => guards.badAttempts.clear());
afterEach(() => jest.restoreAllMocks());

test('guess penalties are isolated by endpoint family', () => {
  for (let i = 0; i < 20; i++) guards.recordBadAttempt('192.0.2.1', 'quote_action_tokens');
  expect(guards.isIpLocked('192.0.2.1', 'quote_action_tokens')).toBe(true);
  expect(guards.isIpLocked('192.0.2.1', 'contract_action_tokens')).toBe(false);
  expect(guards.isIpLocked('192.0.2.1', 'transfer_uploads')).toBe(false);
  expect(guards.isIpLocked('192.0.2.2', 'quote_action_tokens')).toBe(false);
});
test('counter memory is bounded even for source-address churn', () => {
  for (let i = 0; i < guards.MAX_BAD_ATTEMPT_IPS + 25; i++) guards.recordBadAttempt(`source-${i}`, 'quote_action_tokens');
  expect(guards.badAttempts.size).toBe(guards.MAX_BAD_ATTEMPT_IPS);
});
test('expired addresses are removed without requiring another request from each address', () => {
  const now = Date.now();
  const time = jest.spyOn(Date, 'now').mockReturnValue(now);
  guards.recordBadAttempt('192.0.2.1', 'quote_action_tokens');
  time.mockReturnValue(now + 16 * 60 * 1000);
  guards.recordBadAttempt('192.0.2.2', 'quote_action_tokens');
  expect(guards.badAttempts.size).toBe(1);
  expect(guards.isIpLocked('192.0.2.1', 'quote_action_tokens')).toBe(false);
});
