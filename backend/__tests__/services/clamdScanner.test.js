/**
 * The clamd scanner (#1444, plan slice 8) against a fake clamd over TCP.
 *
 * The fake (helpers/fakeClamd) speaks the INSTREAM framing and answers the
 * way clamd does. No real ClamAV.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../../src/utils/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }));

const { fakeClamd, EICAR } = require('../integration/helpers/fakeClamd');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clamd-test-'));
const file = (name, content) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, content);
  return p;
};

let clamd;
function useClamd(port, extra = {}) {
  process.env.CLAMAV_HOST = '127.0.0.1';
  process.env.CLAMAV_PORT = String(port);
  process.env.CLAMAV_TIMEOUT_MS = String(extra.timeoutMs || 2000);
  if (extra.maxBytes) process.env.CLAMAV_MAX_BYTES = String(extra.maxBytes); else delete process.env.CLAMAV_MAX_BYTES;
}

beforeEach(() => {
  jest.resetModules();
  clamd = require('../../src/services/scanners/clamd');
});
afterAll(() => {
  for (const k of ['CLAMAV_HOST', 'CLAMAV_PORT', 'CLAMAV_TIMEOUT_MS', 'CLAMAV_MAX_BYTES']) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('clamd INSTREAM scanner', () => {
  it('answers clean for OK and sends the file byte for byte, in chunks', async () => {
    const fake = await fakeClamd();
    useClamd(fake.port);
    const content = Buffer.alloc(200 * 1024, 7); // several 64 KiB chunks
    expect(await clamd.scan(file('big.pdf', content))).toBe('clean');
    expect(fake.received[0].equals(content)).toBe(true);
    expect(clamd._state.lastSuccessAt).toBeTruthy();
    await fake.close();
  });

  it('answers rejected for FOUND (EICAR)', async () => {
    const fake = await fakeClamd();
    useClamd(fake.port);
    expect(await clamd.scan(file('eicar.pdf', EICAR))).toBe('rejected');
    await fake.close();
  });

  it('leaves the file pending on a timeout, a refused connection, an ERROR answer and a dropped connection', async () => {
    const silent = await fakeClamd('silent');
    useClamd(silent.port, { timeoutMs: 300 });
    expect(await clamd.scan(file('a.pdf', 'x'))).toBe('pending');
    expect(clamd._state.lastError).toBe('timeout');
    await silent.close();

    const gone = await fakeClamd();
    const { port } = gone;
    await gone.close();
    useClamd(port);
    expect(await clamd.scan(file('b.pdf', 'x'))).toBe('pending');
    expect(clamd._state.lastError).toBe('refused');

    const erroring = await fakeClamd('error');
    useClamd(erroring.port);
    expect(await clamd.scan(file('c.pdf', 'x'))).toBe('pending');
    expect(clamd._state.lastError).toBe('scanner_error');
    await erroring.close();

    const closing = await fakeClamd('close');
    useClamd(closing.port);
    expect(await clamd.scan(file('d.pdf', 'x'))).toBe('pending');
    await closing.close();
  });

  it('does not send a file over CLAMAV_MAX_BYTES and leaves it pending', async () => {
    const fake = await fakeClamd();
    useClamd(fake.port, { maxBytes: 10 });
    expect(await clamd.scan(file('e.pdf', 'more than ten bytes'))).toBe('pending');
    expect(fake.received).toHaveLength(0);
    await fake.close();
  });

  it('reports health: configured, reachable by PING, never the host', async () => {
    delete process.env.CLAMAV_HOST;
    expect(await clamd.health()).toMatchObject({ configured: false, reachable: false });

    const fake = await fakeClamd();
    useClamd(fake.port);
    const health = await clamd.health();
    expect(health).toMatchObject({ configured: true, reachable: true });
    expect(JSON.stringify(health)).not.toContain('127.0.0.1');
    await fake.close();
  });
});

