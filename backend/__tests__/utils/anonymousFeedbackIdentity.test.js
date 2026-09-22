const jwt = require('jsonwebtoken');
const { anonymousFeedbackIdentifier } = require('../../src/utils/anonymousFeedbackIdentity');

const makeReq = (cookie, eventId = 1) => ({ event: { id: eventId }, cookies: { picpeak_feedback: cookie },
  res: { cookie: jest.fn(), req: { secure: false, headers: {} } } });
const sign = (payload, options = {}) => jwt.sign(payload, process.env.JWT_SECRET,
  { issuer: 'picpeak-feedback', subject: '0'.repeat(32), expiresIn: '1h', ...options });

test('signed identity is stable within an event and distinct between events', async () => {
  const cookie = sign({ type: 'feedback' });
  expect(await anonymousFeedbackIdentifier(makeReq(cookie, 1))).toBe(await anonymousFeedbackIdentifier(makeReq(cookie, 1)));
  expect(await anonymousFeedbackIdentifier(makeReq(cookie, 1))).not.toBe(await anonymousFeedbackIdentifier(makeReq(cookie, 2)));
  const req = makeReq(cookie);
  await anonymousFeedbackIdentifier(req);
  expect(req.res.cookie).not.toHaveBeenCalled();
});

test.each(['malformed', 'wrong-type', 'wrong-issuer', 'expired', 'tampered'])('replaces an invalid %s cookie with a server-issued identity', async (kind) => {
  let cookie = 'not-a-token';
  if (kind === 'wrong-type') cookie = sign({ type: 'admin' });
  if (kind === 'wrong-issuer') cookie = sign({ type: 'feedback' }, { issuer: 'picpeak-auth' });
  if (kind === 'expired') cookie = sign({ type: 'feedback' }, { expiresIn: -1 });
  if (kind === 'tampered') cookie = sign({ type: 'feedback' }).slice(0, -5) + 'aaaaa';
  const req = makeReq(cookie);
  expect(await anonymousFeedbackIdentifier(req)).toMatch(/^[a-f0-9]{64}$/);
  expect(req.res.cookie).toHaveBeenCalledWith('picpeak_feedback', expect.any(String),
    expect.objectContaining({ httpOnly: true, path: '/api/gallery' }));
  const issued = jwt.verify(req.res.cookie.mock.calls[0][1], process.env.JWT_SECRET, { issuer: 'picpeak-feedback' });
  expect(issued.type).toBe('feedback');
  expect(issued.sub).toMatch(/^[a-f0-9]{32}$/);
});
