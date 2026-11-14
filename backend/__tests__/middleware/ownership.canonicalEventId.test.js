/**
 * requireEventOwnership / requireEventOwner decide on one event and the
 * handler must act on that same event. The route id is checked as a plain
 * positive integer and written back in canonical form, so a handler that
 * reads req.params with parseInt or Number sees the id that was checked.
 */
const EVENTS = [
  { id: 1, created_by: 99 }, // another admin's gallery
  { id: 10, created_by: 7 }, // the caller's own gallery
];

const lookups = [];
jest.mock('../../src/database/db', () => ({
  db: () => ({
    where(_col, value) {
      lookups.push(value);
      // SQLite numeric affinity: a numeric-looking string matches by value.
      this._match = EVENTS.find((e) => e.id === Number(value));
      return this;
    },
    first() { return Promise.resolve(this._match); },
  }),
}));

const { requireEventOwnership, requireEventOwner } = require('../../src/middleware/ownership');

function run(middleware, params, admin = { id: 7, roleName: 'editor' }) {
  return new Promise((resolve) => {
    const req = { params: { ...params }, admin };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ req, status: this.statusCode, body, nextCalled: false }); },
    };
    middleware(req, res, () => resolve({ req, status: 200, nextCalled: true }));
  });
}

beforeEach(() => { lookups.length = 0; });

describe.each([
  ['requireEventOwnership', requireEventOwnership],
  ['requireEventOwner', requireEventOwner],
])('%s canonical event id', (_name, middleware) => {
  it.each(['1e1', '1.0', '10.9', ' 10', '10 ', '+10', '-10', '0', '0x0a', 'abc', '99999999999999999999'])(
    'refuses %j before looking the event up',
    async (raw) => {
      const out = await run(middleware, { eventId: raw });
      expect(out.nextCalled).toBe(false);
      expect(out.status).toBe(404);
      expect(lookups).toEqual([]);
    },
  );

  it('writes the checked id back for :eventId', async () => {
    const out = await run(middleware, { eventId: '010' });
    expect(out.nextCalled).toBe(true);
    expect(out.req.params.eventId).toBe('10');
    expect(lookups).toEqual([10]);
  });

  it('writes the checked id back for :id', async () => {
    const out = await run(middleware, { id: '10' });
    expect(out.nextCalled).toBe(true);
    expect(out.req.params.id).toBe('10');
  });

  it('still refuses the foreign gallery by its plain id', async () => {
    const out = await run(middleware, { eventId: '1' });
    expect(out.status).toBe(403);
  });

  it('canonicalises for roles that manage every gallery too', async () => {
    const out = await run(middleware, { id: '007' }, { id: 1, roleName: 'super_admin' });
    expect(out.nextCalled).toBe(true);
    expect(out.req.params.id).toBe('7');
    const bad = await run(middleware, { id: '1e1' }, { id: 1, roleName: 'super_admin' });
    expect(bad.status).toBe(404);
  });

  it('asks for an id when none is given', async () => {
    const out = await run(middleware, {});
    expect(out.status).toBe(400);
  });
});
