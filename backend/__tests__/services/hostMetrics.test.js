const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-cgroup-'));
process.env.PICPEAK_CGROUP_ROOT = root;
const hostMetrics = require('../../src/services/hostMetrics');

const write = (file, value) => fs.writeFileSync(path.join(root, file), value);

describe('hostMetrics under a cgroup limit', () => {
  afterAll(() => hostMetrics.stop());

  it('does not count page cache as used memory', () => {
    const MIB = 1024 ** 2;
    write('memory.current', String(2048 * MIB));
    write('memory.max', String(2048 * MIB));
    write('memory.stat', `anon ${600 * MIB}\nactive_file ${1000 * MIB}\ninactive_file ${448 * MIB}\n`);
    expect(hostMetrics.sample().memoryPercent).toBeCloseTo(29.3, 1);
  });

  it('measures CPU against the cores the container may use', () => {
    write('cpu.max', '200000 100000');
    write('cpu.stat', 'usage_usec 1000000\n');
    expect(hostMetrics.sample().cores).toBe(Math.min(2, os.availableParallelism()));
  });
});
