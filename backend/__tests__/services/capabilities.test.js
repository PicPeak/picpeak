const { CAPABILITIES, DEPENDENCY_STATES, evaluate, isCapability } = require('../../src/services/capabilities');
const documentScanService = require('../../src/services/documentScanService');

describe('capabilities', () => {
  it('needs only states that exist', () => {
    for (const { needs } of Object.values(CAPABILITIES)) {
      for (const worst of Object.values(needs)) expect(DEPENDENCY_STATES).toContain(worst);
    }
  });

  it('runs when every dependency is healthy or has not reported', () => {
    expect(evaluate('uploads.new', { storage: 'healthy', disk: 'healthy' }).available).toBe(true);
    expect(evaluate('uploads.new', {}).available).toBe(true);
  });

  it('pauses new uploads while storage is only degraded', () => {
    expect(evaluate('uploads.new', { storage: 'degraded' })).toMatchObject({ available: false, blockedBy: ['storage'] });
  });

  it('keeps archives running on degraded storage and stops them once it is down', () => {
    expect(evaluate('downloads.archive', { storage: 'degraded' }).available).toBe(true);
    expect(evaluate('downloads.archive', { storage: 'down' }).available).toBe(false);
  });

  it('stops new archives when the temporary space they build in runs low, and leaves uploads alone', () => {
    expect(evaluate('downloads.archive', { tempDisk: 'degraded' })).toMatchObject({ available: false, blockedBy: ['tempDisk'] });
    expect(evaluate('uploads.new', { tempDisk: 'down' }).available).toBe(true);
  });

  it('throws on an unknown name instead of leaving a route unguarded', () => {
    expect(() => evaluate('uploads.nwe')).toThrow('Unknown capability');
  });
});

// The rules below are the security contract of graceful degradation. Loosening
// one of them is a security change, not a tuning change.
describe('graceful degradation security contract', () => {
  it('never lists a security or legally binding function as degradable', () => {
    const forbidden = /auth|login|session|permission|access|password|expir|token|csrf|rate|scan|invoice|contract|sign|payment|audit/i;
    expect(Object.keys(CAPABILITIES).filter((name) => forbidden.test(name))).toEqual([]);
  });

  it('cannot be extended or loosened at runtime', () => {
    expect(Object.isFrozen(CAPABILITIES)).toBe(true);
    for (const capability of Object.values(CAPABILITIES)) {
      expect(Object.isFrozen(capability)).toBe(true);
      expect(Object.isFrozen(capability.needs)).toBe(true);
    }
  });

  it('lets an override only remove a capability', () => {
    expect(evaluate('uploads.new', {}, ['uploads.new'])).toMatchObject({ available: false, forced: true });
    // Forcing some other capability off restores nothing here.
    expect(evaluate('uploads.new', { storage: 'down' }, ['downloads.archive']).available).toBe(false);
    expect(isCapability('auth.bypass')).toBe(false);
  });

  it('keeps a document pending when no scanner can give a verdict', async () => {
    documentScanService.registerScanner(async () => { throw new Error('scanner down'); });
    try {
      await expect(documentScanService.scanFile('/tmp/never-read')).resolves.toBe('pending');
    } finally {
      documentScanService.registerScanner(null);
    }
  });
});
