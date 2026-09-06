const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const mockDb = require('knex')({
  client: 'sqlite3',
  connection: { filename: ':memory:' },
  useNullAsDefault: true
});
jest.mock('../../src/database/db', () => ({
  get db() {
    return mockDb;
  }
}));
jest.mock('../../src/utils/tokenRevocation', () => ({
  isTokenRevoked: jest.fn().mockResolvedValue(false)
}));
jest.mock('../../src/utils/sessionCutoff', () => ({
  isTokenBeforeCutoff: jest.fn().mockResolvedValue(false)
}));
jest.mock('../../src/utils/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  info: jest.fn()
}));
jest.mock('../../src/services/productUsageService', () =>
  Object.fromEntries(
    [
      'tick',
      'status',
      'dismiss',
      'enable',
      'disable',
      'abandon',
      'preview',
      'export',
      'preferences',
      'command',
      'markUsed'
    ].map((key) => [key, jest.fn().mockResolvedValue({ status: 'disabled' })])
  )
);
const service = require('../../src/services/productUsageService');
const { productUsage } = require('../../src/middleware/productUsage');
const { productUsageApi } = require('../../src/middleware/productUsage');
const SECRET = 'usage-auth-test-secret-not-a-live-credential';
const token = (type, id = 1) =>
  jwt.sign({ type, id }, SECRET, {
    issuer: 'picpeak-auth',
    algorithm: 'HS256'
  });
let app;
beforeAll(async () => {
  process.env.JWT_SECRET = SECRET;
  await mockDb.schema.createTable('roles', (t) => {
    t.increments('id');
    t.string('name');
  });
  await mockDb.schema.createTable('admin_users', (t) => {
    t.increments('id');
    t.string('username');
    t.string('email');
    t.integer('role_id');
    t.boolean('is_active');
    t.timestamp('password_changed_at');
  });
  await mockDb.schema.createTable('permissions', (t) => {
    t.increments('id');
    t.string('name');
  });
  await mockDb.schema.createTable('role_permissions', (t) => {
    t.integer('role_id');
    t.integer('permission_id');
  });
  await mockDb('roles').insert([
    { id: 1, name: 'super_admin' },
    { id: 2, name: 'viewer' }
  ]);
  await mockDb('admin_users').insert([
    {
      id: 1,
      username: 'owner',
      email: 'owner@example.test',
      role_id: 1,
      is_active: 1
    },
    {
      id: 2,
      username: 'viewer',
      email: 'viewer@example.test',
      role_id: 2,
      is_active: 1
    }
  ]);
  await mockDb('permissions').insert({ id: 1, name: 'settings.edit' });
  await mockDb('role_permissions').insert({ role_id: 1, permission_id: 1 });
  app = express();
  app.use(express.json());
  app.use('/api/admin/usage', require('../../src/routes/adminUsage'));
  app.use((err, _req, res, _next) =>
    res.status(err.statusCode || 500).json({ code: err.code })
  );
});
afterAll(() => mockDb.destroy());
beforeEach(() => jest.clearAllMocks());

test('scoped API use records only its fixed v2 capability and never triggers a report', () => {
  const simulate = (admin, apiToken, statusCode) => {
    const res = new (require('events').EventEmitter)(); res.statusCode = statusCode;
    productUsageApi({ admin, apiToken, body: { user: 'PRIVATE@example.test' } }, res, () => {});
    res.emit('finish');
  };
  simulate(null, { id: 99 }, 200);
  simulate({ id: 42 }, null, 200);
  simulate({ id: 42 }, { id: 99 }, 403);
  expect(service.markUsed).not.toHaveBeenCalled();
  simulate({ id: 42 }, { id: 99 }, 200);
  expect(service.markUsed).toHaveBeenCalledWith(['api_integration'], { legacyFeatures: [] });
  expect(service.tick).not.toHaveBeenCalled();
  expect(JSON.stringify(service.markUsed.mock.calls)).not.toMatch(/PRIVATE|42|99/);
});

const ROUTES = [
  ['get', '/'],
  ['post', '/activity'],
  ['post', '/enable'],
  ['post', '/consent'],
  ['post', '/disable'],
  ['post', '/abandon'],
  ['post', '/retry'],
  ['post', '/dismiss'],
  ['get', '/preview'],
  ['get', '/export'],
  ['put', '/feedback-preferences'],
  ['post', '/feedback'],
  ['post', '/vote'],
  ['post', '/portal-session']
];
test.each(ROUTES)(
  '%s %s rejects unauthenticated and gallery tokens',
  async (method, route) => {
    await request(app)[method](`/api/admin/usage${route}`).send({}).expect(401);
    await request(app)[method](`/api/admin/usage${route}`)
      .set('Authorization', `Bearer ${token('gallery')}`)
      .send({})
      .expect(403);
    expect(service.tick).not.toHaveBeenCalled();
    expect(service.enable).not.toHaveBeenCalled();
  }
);
test.each(ROUTES.filter(([, route]) => route !== '/activity'))(
  '%s %s requires settings.edit',
  async (method, route) => {
    await request(app)[method](`/api/admin/usage${route}`)
      .set('Authorization', `Bearer ${token('admin', 2)}`)
      .send({})
      .expect(403);
  }
);
test('an authenticated admin can trigger cadence without seeing identity or packet data', async () => {
  const response = await request(app)
    .post('/api/admin/usage/activity')
    .set('Authorization', `Bearer ${token('admin', 2)}`)
    .expect(200);
  expect(response.body).toEqual({ ok: true });
  expect(service.tick).toHaveBeenCalledTimes(1);
});
test('owner sees no-store status and supplies consent to the service', async () => {
  await request(app)
    .get('/api/admin/usage')
    .set('Authorization', `Bearer ${token('admin')}`)
    .expect('Cache-Control', 'no-store')
    .expect(200);
  await request(app)
    .post('/api/admin/usage/enable')
    .set('Authorization', `Bearer ${token('admin')}`)
    .send({ consent_version: 'usage-consent.v1' })
    .expect(200);
  expect(service.enable).toHaveBeenCalledWith('usage-consent.v1');
});
test('public/gallery paths and failed/unauthenticated admin operations never set feature markers', async () => {
  const { EventEmitter } = require('events');
  const simulate = (path, admin, statusCode) => {
    const res = new EventEmitter();
    res.locals = {};
    res.statusCode = statusCode;
    productUsage({ path, method: 'POST', admin }, res, () => {});
    res.emit('finish');
  };
  simulate('/gallery/example', null, 200);
  simulate('/customers', null, 200);
  simulate('/quotes', { id: 1 }, 403);
  expect(service.markUsed).not.toHaveBeenCalled();
  simulate('/customers/42/hour-entries', { id: 1 }, 200);
  // The second argument tells markUsed whether this operation writes to the
  // configured backup destination; a CRM route never does.
  expect(service.markUsed).toHaveBeenCalledWith(
    expect.arrayContaining(['crm', 'crm_hours']),
    expect.objectContaining({ destinationBackup: false })
  );
  expect(JSON.stringify(service.markUsed.mock.calls)).not.toContain('42');
});

test('consent upgrade accepts exactly the explicit v2 choice, never extra fields', async () => {
  for (const data of [{}, { consent_version: 'usage-consent.v1' }, { consent_version: 'usage-consent.v2', user: 'PRIVATE' }])
    await request(app).post('/api/admin/usage/consent').set('Authorization', `Bearer ${token('admin')}`).send(data).expect(400);
  expect(service.command).not.toHaveBeenCalled();
  await request(app).post('/api/admin/usage/consent').set('Authorization', `Bearer ${token('admin')}`)
    .send({ consent_version: 'usage-consent.v2' }).expect(200);
  expect(service.command).toHaveBeenCalledWith('consent', { consent_version: 'usage-consent.v2' });
});

test('only a backup that writes to the configured destination flags S3', () => {
  // /database-backup/* and /backup/picpeak/export produce a local file, so
  // they must not imply S3 use just because S3 is the configured destination.
  const seen = [];
  const simulate = (pathname) => {
    service.markUsed.mockClear();
    const res = new (require('events').EventEmitter)();
    res.locals = {};
    res.statusCode = 200;
    productUsage({ path: pathname, method: pathname.endsWith('/export') ? 'GET' : 'POST', admin: { id: 1 } }, res, () => {});
    res.emit('finish');
    seen.push([pathname, service.markUsed.mock.calls[0]?.[1]?.destinationBackup]);
  };
  simulate('/backup/run');
  simulate('/database-backup/backup');
  simulate('/backup/picpeak/export');
  expect(seen).toEqual([
    ['/backup/run', true],
    ['/database-backup/backup', false],
    ['/backup/picpeak/export', false],
  ]);
});

// The route allowlist and the packet schema have to agree. The allowlist used
// to let `name`, `allow_public` and `allow_marketing` be omitted while the
// schema requires all three, so an API caller got a bare INVALID_PACKET from
// deep inside signing instead of being told which field was missing.
const VALID_FEEDBACK = {
  kind: 'feedback',
  title: 'Title',
  body: 'Body',
  name: '',
  allow_public: false,
  allow_marketing: false
};
test.each([
  ['no body at all', {}],
  ['missing name', { ...VALID_FEEDBACK, name: undefined }],
  ['missing allow_public', { ...VALID_FEEDBACK, allow_public: undefined }],
  ['missing allow_marketing', { ...VALID_FEEDBACK, allow_marketing: undefined }],
  ['a boolean sent as a string', { ...VALID_FEEDBACK, allow_public: 'true' }],
  ['a title of only whitespace', { ...VALID_FEEDBACK, title: '   ' }],
  ['an unknown field', { ...VALID_FEEDBACK, ownerId: 7 }]
])('feedback rejects %s before anything is signed', async (_label, data) => {
  const response = await request(app)
    .post('/api/admin/usage/feedback')
    .set('Authorization', `Bearer ${token('admin')}`)
    .send(JSON.parse(JSON.stringify(data)))
    .expect(400);
  // Named, not a bare protocol failure the caller cannot act on.
  expect(response.body.code).toBe('VALIDATION_ERROR');
  expect(service.command).not.toHaveBeenCalled();
});
test('feedback accepts the complete payload and mints the id server-side', async () => {
  await request(app)
    .post('/api/admin/usage/feedback')
    .set('Authorization', `Bearer ${token('admin')}`)
    .send({ ...VALID_FEEDBACK, name: 'QA' })
    .expect(200);
  expect(service.command).toHaveBeenCalledWith(
    'feedback',
    expect.objectContaining({ name: 'QA', feedback_id: expect.any(String) })
  );
});

// Runs last on purpose: the limiter's budget is per-process and shared with
// every test above that reaches an outbound route, so consuming it here cannot
// starve them. The assertion is deliberately about the property — some request
// is refused and the service stops being called — rather than an exact count,
// which would depend on how much budget earlier tests used.
test('the outbound routes are throttled so an admin session cannot flood the collector', async () => {
  const codes = [];
  for (let i = 0; i < 45; i += 1) {
    const response = await request(app)
      .post('/api/admin/usage/feedback')
      .set('Authorization', `Bearer ${token('admin')}`)
      .send({ ...VALID_FEEDBACK, title: `flood ${i}` });
    codes.push(response.status);
    if (response.status === 429) {
      expect(response.body.code).toBe('USAGE_RATE_LIMITED');
      break;
    }
  }
  expect(codes).toContain(429);
  expect(service.command.mock.calls.length).toBeLessThan(codes.length);

  // The same budget covers the other two routes that relay to the collector.
  await request(app)
    .post('/api/admin/usage/vote')
    .set('Authorization', `Bearer ${token('admin')}`)
    .send({ feedback_id: '11111111-1111-4111-8111-111111111111', voted: true })
    .expect(429);
  await request(app)
    .post('/api/admin/usage/portal-session')
    .set('Authorization', `Bearer ${token('admin')}`)
    .expect(429);

  // Reading status and withdrawing must never be throttled: those are how an
  // operator sees what is happening and how they get out.
  await request(app)
    .get('/api/admin/usage')
    .set('Authorization', `Bearer ${token('admin')}`)
    .expect(200);
  await request(app)
    .post('/api/admin/usage/disable')
    .set('Authorization', `Bearer ${token('admin')}`)
    .expect(200);
});
