'use strict';

const fs = require('fs');
const os = require('os');
const { monitorEventLoopDelay } = require('perf_hooks');

/**
 * CPU, memory and event loop readings for this process's container.
 *
 * Inside Docker `os.cpus()` and the load average describe the host, so a
 * container limited to two cores on a 32-core server would never look busy.
 * cgroup v2 files are read first and host numbers are the fallback (bare
 * metal, macOS, cgroup v1). Temperature is left out: containers cannot read it.
 */
const CGROUP_ROOT = process.env.PICPEAK_CGROUP_ROOT || '/sys/fs/cgroup';

function readCgroup(file) {
  try {
    return fs.readFileSync(`${CGROUP_ROOT}/${file}`, 'utf8').trim();
  } catch (_) {
    return null;
  }
}

function cgroupCpuUsageMicros() {
  const stat = readCgroup('cpu.stat');
  const match = stat && /^usage_usec (\d+)$/m.exec(stat);
  return match ? Number(match[1]) : null;
}

function cpuCores() {
  const [quota, period] = (readCgroup('cpu.max') || '').split(/\s+/);
  const limit = Number(quota) / Number(period);
  const available = os.availableParallelism();
  return Number.isFinite(limit) && limit > 0 ? Math.min(limit, available) : available;
}

function hostCpuTimes() {
  let busy = 0;
  let total = 0;
  for (const { times } of os.cpus()) {
    const all = times.user + times.nice + times.sys + times.idle + times.irq;
    total += all;
    busy += all - times.idle;
  }
  return { busy, total };
}

function memoryPercent() {
  const current = Number(readCgroup('memory.current'));
  const limit = Number(readCgroup('memory.max'));
  if (current > 0 && limit > 0) {
    // Page cache is reclaimable. Counting it would call every file server full.
    const stat = readCgroup('memory.stat') || '';
    const cache = ['active_file', 'inactive_file']
      .reduce((sum, field) => sum + Number(new RegExp(`^${field} (\\d+)$`, 'm').exec(stat)?.[1] || 0), 0);
    return (Math.max(0, current - cache) / limit) * 100;
  }
  // Linux counts reclaimable memory as free. macOS does not, so a healthy Mac
  // reads as nearly full: there it stays unknown rather than raising an alarm.
  if (process.platform !== 'linux') return null;
  return ((os.totalmem() - os.freemem()) / os.totalmem()) * 100;
}

class HostMetrics {
  constructor() {
    this.delay = null;
    this.previous = null;
  }

  /** CPU percent since the previous call, of the cores this container may use. */
  cpuPercent() {
    const now = Date.now();
    const usage = cgroupCpuUsageMicros();
    const previous = this.previous;
    if (usage !== null) {
      this.previous = { now, usage };
      if (previous?.usage === undefined) return null;
      const elapsedMicros = (now - previous.now) * 1000;
      return elapsedMicros > 0 ? Math.min(100, ((usage - previous.usage) / (elapsedMicros * cpuCores())) * 100) : null;
    }
    const times = hostCpuTimes();
    this.previous = { now, times };
    if (!previous?.times) return null;
    const total = times.total - previous.times.total;
    return total > 0 ? Math.min(100, ((times.busy - previous.times.busy) / total) * 100) : null;
  }

  /** Worst-case event loop delay since the previous call, in milliseconds. */
  eventLoopDelayMs() {
    if (!this.delay) {
      this.delay = monitorEventLoopDelay({ resolution: 20 });
      this.delay.enable();
      return null;
    }
    const value = this.delay.percentile(99) / 1e6;
    this.delay.reset();
    return value;
  }

  sample() {
    return {
      cpuPercent: this.cpuPercent(),
      memoryPercent: memoryPercent(),
      eventLoopDelayMs: this.eventLoopDelayMs(),
      cores: cpuCores(),
    };
  }

  stop() {
    this.delay?.disable();
    this.delay = null;
    this.previous = null;
  }
}

module.exports = new HostMetrics();
