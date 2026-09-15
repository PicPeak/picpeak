/**
 * Request ids tie a failed request, its error response and its log lines
 * together (issue 1447). A proxy's correlation id is kept end to end; anything
 * that does not look like an id is replaced, so a client cannot write arbitrary
 * text into the logs through the header.
 */

const requestId = require('../../src/middleware/requestId');

function run(inbound) {
  const req = { headers: inbound === undefined ? {} : { 'x-request-id': inbound } };
  const headers = {};
  const res = { setHeader: (name, value) => { headers[name] = value; } };
  const next = jest.fn();
  requestId(req, res, next);
  return { req, headers, next };
}

describe('requestId middleware', () => {
  it('generates an id and returns it in the response header', () => {
    const { req, headers, next } = run(undefined);

    expect(req.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(headers['X-Request-Id']).toBe(req.id);
    expect(next).toHaveBeenCalled();
  });

  it('keeps a well-formed id from a reverse proxy', () => {
    const { req, headers } = run('proxy-7f3a9c2e.41');

    expect(req.id).toBe('proxy-7f3a9c2e.41');
    expect(headers['X-Request-Id']).toBe('proxy-7f3a9c2e.41');
  });

  it.each([
    ['log injection', 'abc123\nERROR forged line'],
    ['too short', 'abc'],
    ['too long', 'a'.repeat(129)],
    ['spaces', 'not an id at all'],
  ])('replaces an inbound id that is not an id (%s)', (_label, inbound) => {
    const { req } = run(inbound);

    expect(req.id).not.toBe(inbound);
    expect(req.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
