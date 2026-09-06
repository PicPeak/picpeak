/**
 * The consent dialog tells the operator that this connection only ever runs
 * outwards: PicPeak sends, and reads nothing back but the acknowledgement for
 * the packet it just sent. That is a security claim — it is the reason a
 * compromised collector cannot use this path to push code, configuration or
 * content into an installation — so it is guarded here rather than left to
 * review.
 *
 * These are source-inspection assertions on purpose. A behavioural test only
 * proves the calls that exist today behave; this fails the moment someone adds
 * a "check the collector for messages" fetch, a polling job, or an endpoint the
 * collector could call.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '../../src');
const service = fs.readFileSync(path.join(SRC, 'usage/UsageService.js'), 'utf8');
const route = fs.readFileSync(path.join(SRC, 'routes/adminUsage.js'), 'utf8');
const server = fs.readFileSync(path.resolve(__dirname, '../../server.js'), 'utf8');

test('the collector is contacted from exactly one place, and only by POST', () => {
  // One transport helper. Anything else reaching for the network here would
  // bypass the size cap, the redirect ban and the timeout as well.
  const callSites = service.match(/this\.fetch\(/g) || [];
  expect(callSites).toHaveLength(1);

  const post = service.slice(service.indexOf('async post('));
  expect(post).toContain('method: \'POST\'');
  // A redirect is an instruction from the collector about where to go next.
  expect(post).toContain('redirect: \'error\'');
  expect(post).toContain('AbortSignal.timeout(');
});

test('only the two known collector paths are ever requested', () => {
  const paths = [...service.matchAll(/this\.post\(\s*'([^']+)'/g)].map((m) => m[1]);
  expect(paths.sort()).toEqual(['/api/envelopes', '/api/participant/lookup']);
});

test('nothing is read from a reply except the acknowledgement, checked field by field', () => {
  // Every field of the receipt is compared against the packet that was sent.
  for (const field of ['packet_id', 'installation_id', 'packet_digest', 'action', 'sequence', 'status'])
    expect(service).toMatch(new RegExp(`receipt\\.${field} !==`));
  expect(service).toContain('throw new Error(\'Invalid collector receipt\')');

  // The stored copy drops the one value that is not an echo of what we sent,
  // and no read path hands it back out again.
  expect(service).toContain('delete storedReceipt.session_token');
  expect(service).not.toMatch(/last_receipt:\s*state\.last_receipt/);
  const status = service.slice(service.indexOf('async status()'), service.indexOf('async locked('));
  expect(status).not.toContain('last_receipt');
});

test('the collector has no way in: no inbound route and no scheduled pull', () => {
  // Every usage route is mounted behind adminAuth on the admin surface.
  expect(server).toContain('app.use(\'/api/admin/usage\', require(\'./src/routes/adminUsage\'))');
  expect(route).toContain('router.use(adminAuth)');
  // No public/gallery/webhook mount for anything usage-related.
  const publicMounts = [...server.matchAll(/app\.use\('\/api\/(public|gallery|customer|invite)[^']*',[^\n]*\)/g)]
    .map((m) => m[0]);
  for (const mount of publicMounts) expect(mount).not.toMatch(/[Uu]sage/);

  // Nothing schedules a collector call; the daily rollup is driven only by an
  // authenticated admin hitting /activity.
  expect(service).not.toMatch(/setInterval|setTimeout\s*\(\s*\(\)\s*=>\s*this\.tick/);
  const dir = path.join(SRC, 'services');
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    if (entry.name === 'productUsageService.js') continue;
    expect(fs.readFileSync(path.join(dir, entry.name), 'utf8'))
      .not.toContain('productUsageService');
  }
});
