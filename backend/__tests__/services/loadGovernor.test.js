const { LoadGovernor } = require('../../src/services/loadGovernor');

const reading = (cpuPercent, extra = {}) => ({ cpuPercent, eventLoopDelayMs: 1, memoryPercent: 40, ...extra });

function build() {
  const governor = new LoadGovernor();
  governor.configure({ enforcing: true });
  return governor;
}

function feed(governor, cpu, times) {
  for (let i = 0; i < times; i += 1) governor.observe(reading(cpu));
}

describe('load governor', () => {
  it('ignores one spike', () => {
    const governor = build();
    governor.observe(reading(30));
    governor.observe(reading(100));
    expect(governor.level).toBe(0);
  });

  it('steps down in stages under sustained load', () => {
    const governor = build();
    feed(governor, 90, 2);
    expect(governor.level).toBe(1);
    expect(governor.workerLimit(4)).toBe(2);
    feed(governor, 90, 1);
    expect(governor.level).toBe(1);
    feed(governor, 90, 1);
    expect(governor.level).toBe(2);
    expect(governor.workerLimit(4)).toBe(1);
  });

  it('holds between the limit and the resume point', () => {
    const governor = build();
    feed(governor, 90, 4);
    feed(governor, 60, 10);
    expect(governor.level).toBe(2);
  });

  it('recovers a step at a time', () => {
    const governor = build();
    feed(governor, 90, 4);
    feed(governor, 20, 2);
    expect(governor.level).toBe(1);
    feed(governor, 20, 2);
    expect(governor.level).toBe(0);
  });

  it('never stops photo workers for CPU alone', () => {
    const governor = build();
    feed(governor, 100, 50);
    expect(governor.workerLimit(2)).toBe(1);
  });

  it('pauses only on critical memory, and comes back without a CPU reading', () => {
    const governor = build();
    governor.observe(reading(10, { memoryPercent: 98 }));
    expect(governor.workerLimit(2)).toBe(0);
    governor.observe(reading(10));
    expect(governor.workerLimit(2)).toBe(1);
  });

  it('reacts to a stalled event loop even with a calm CPU', () => {
    const governor = build();
    governor.observe(reading(10, { eventLoopDelayMs: 400 }));
    governor.observe(reading(10, { eventLoopDelayMs: 400 }));
    expect(governor.level).toBe(1);
  });

  it('slows bulk work more at each level', () => {
    const governor = build();
    expect(governor.bulkDelayMs()).toBe(0);
    feed(governor, 90, 2);
    const reduced = governor.bulkDelayMs();
    feed(governor, 90, 2);
    expect(governor.bulkDelayMs()).toBeGreaterThan(reduced);
  });

  it('copes with no CPU reading yet', () => {
    const governor = build();
    governor.observe({ cpuPercent: null, eventLoopDelayMs: null, memoryPercent: 40 });
    governor.observe({ cpuPercent: null, eventLoopDelayMs: null, memoryPercent: 40 });
    expect(governor.level).toBe(0);
  });

  it('honours configured thresholds', () => {
    const governor = build();
    governor.configure({ throttlePercent: 40, resumePercent: 20 });
    feed(governor, 50, 2);
    expect(governor.level).toBe(1);
  });

  it('only reports in observe mode', () => {
    const governor = new LoadGovernor();
    feed(governor, 100, 4);
    expect(governor.level).toBe(2);
    expect(governor.workerLimit(4)).toBe(4);
    expect(governor.bulkDelayMs()).toBe(0);
  });
});
