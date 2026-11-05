'use strict';

const fsp = require('fs/promises');
const os = require('os');
const { constants: fsConstants } = require('fs');
const { db } = require('../database/db');
const { getStoragePath } = require('../config/storage');
const { getAppSetting, upsertAppSetting } = require('../utils/appSettings');
const { livePhotos } = require('../utils/photoVisibility');
const { toMillis } = require('../utils/queueTimestamps');
const logger = require('../utils/logger');
const hostMetrics = require('./hostMetrics');
const loadGovernor = require('./loadGovernor');
const { CAPABILITIES, evaluate, isCapability, severity } = require('./capabilities');
const { isStorageUnavailableError } = require('./storage/storageErrors');

/**
 * One view of what PicPeak depends on, with a breaker per dependency.
 *
 * Probes run on a timer and the result is kept in memory, so a guarded request
 * never waits on a dependency and the answer survives the database being down.
 * Each process keeps its own view; replicas probe the same things and agree
 * within a few intervals.
 *
 * A single bad probe changes nothing. TRIP_AFTER failures in a row mean
 * degraded, DOWN_AFTER mean down, and RECOVER_AFTER better readings in a row are
 * needed to come back, so a flapping share does not reopen uploads on every
 * success. Merely slow probes need DOWN_AFTER readings to degrade: the timing is
 * wall-clock, so a burst of uploads or a stalled event loop can slow one on a
 * healthy disk, and that must not pause the uploads causing it. A probe that
 * times out counts as slow too: a full S3 socket pool surfaces as a timeout. A
 * probe still running at the next pass counts as a failure, so a hung mount
 * still goes down. /health is deliberately not fed from here: Docker restarting
 * the app cannot repair a share or a mail server.
 *
 * `detail` is fixed text, because GET /status shows it to settings.view readers;
 * the error itself, with its paths and hosts, goes to the log (`logDetail`).
 */
const PROBE_INTERVAL_MS = 15_000;
const PROBE_TIMEOUT_MS = 5_000;
const SLOW_PROBE_MS = 3_000;
const TRIP_AFTER = 2;
const DOWN_AFTER = 4;
const RECOVER_AFTER = 8;

const GIB = 1024 ** 3;
const OLDEST_PENDING_WARN_MS = 30 * 60 * 1000;
const MEMORY_DEGRADED_PERCENT = 92;
const MEMORY_DOWN_PERCENT = 97;
const EVENT_LOOP_DEGRADED_MS = 500;

const ENFORCEMENT_KEY = 'degradation_enforcement';
const FORCED_OFF_KEY = 'degradation_forced_off';
// One key: the pair is valid together, so it is written together.
const CPU_THRESHOLDS_KEY = 'degradation_cpu_thresholds';

function timed(state, startedAt, detail) {
  const slow = Date.now() - startedAt > SLOW_PROBE_MS;
  return slow && state === 'healthy' ? { state: 'degraded', detail: 'slow', slow: true } : { state, detail };
}

/**
 * Free space judged against the size of the disk, with a ceiling: 10% of a 2 TB
 * disk is 200 GB, which is no reason to stop uploads.
 */
async function freeSpace(dir) {
  const stats = await fsp.statfs(dir);
  const freeBytes = stats.bavail * stats.bsize;
  const totalBytes = stats.blocks * stats.bsize;
  return { state: diskState(freeBytes, totalBytes), metrics: { freeBytes, totalBytes } };
}

function diskState(freeBytes, totalBytes) {
  if (freeBytes < Math.min(totalBytes * 0.03, 5 * GIB)) return 'down';
  if (freeBytes < Math.min(totalBytes * 0.1, 20 * GIB)) return 'degraded';
  return 'healthy';
}

const storageBackend = () => (process.env.STORAGE_BACKEND || 'local').toLowerCase();

const defaultProbes = {
  async database() {
    const startedAt = Date.now();
    await db.raw('SELECT 1');
    return timed('healthy', startedAt);
  },

  async storage() {
    const startedAt = Date.now();
    if (storageBackend() === 'local') {
      await fsp.access(getStoragePath(), fsConstants.R_OK | fsConstants.W_OK);
    }
    // stat() resolves null for a missing key and throws when the backend
    // cannot answer, so an object that never exists tests the connection.
    try {
      await require('./storage').getStorage().stat('.picpeak-health-probe');
    } catch (error) {
      // An answer, even a refusal, means the backend is there. S3 says 403 for
      // a missing key when the policy lacks ListBucket.
      if (isStorageUnavailableError(error)) throw error;
    }
    return timed('healthy', startedAt);
  },

  async disk() {
    try {
      return await freeSpace(getStoragePath());
    } catch (error) {
      // S3 outside Docker can run without a local storage directory, leaving no
      // disk here to judge.
      if (error.code === 'ENOENT' && storageBackend() !== 'local') return null;
      throw error;
    }
  },

  // ZIP builds stage under os.tmpdir(). In Docker that is /tmp on the
  // container's own layer, apart from the storage mount, and nothing sets
  // TMPDIR. Left out when it is the storage disk, which `disk` already reads.
  async tempDisk() {
    const tmp = os.tmpdir();
    const [tmpStat, storageStat] = await Promise.all([
      fsp.stat(tmp),
      fsp.stat(getStoragePath()).catch(() => null),
    ]);
    if (storageStat && storageStat.dev === tmpStat.dev) return null;
    return freeSpace(tmp);
  },

  async mail() {
    const { getQueueProcessorStatus } = require('./emailProcessor');
    const status = getQueueProcessorStatus();
    if (!status.started) return { state: 'degraded', detail: 'processor not running' };
    // Mail is queued, so a failing server is never worse than degraded.
    if (status.outage) return { state: 'degraded', detail: 'mail server unavailable', logDetail: status.outage.error };
    if (status.lastError) return { state: 'degraded', detail: 'last queue pass failed', logDetail: status.lastError };
    return { state: 'healthy' };
  },

  async faceSidecar() {
    const faceSettings = require('./faceSettings');
    // Nothing may contact the sidecar unless the feature is on (faceSettings).
    if (!await faceSettings.isFeatureEnabled()) return null;
    const health = await require('./faceClient').checkHealth();
    return health.ok ? { state: 'healthy' } : { state: 'down', detail: 'sidecar not answering', logDetail: health.error };
  },

  async queues() {
    const [row] = await livePhotos(db).where({ processing_status: 'pending' })
      .count('* as pending').min('uploaded_at as oldest');
    const pending = Number(row?.pending || 0);
    const oldest = row?.oldest ? toMillis(row.oldest) : null;
    const waitingMs = oldest ? Math.max(0, Date.now() - oldest) : 0;
    return {
      state: waitingMs > OLDEST_PENDING_WARN_MS ? 'degraded' : 'healthy',
      metrics: { pendingPhotos: pending, oldestPendingMs: waitingMs },
    };
  },

  async load() {
    const sample = hostMetrics.sample();
    loadGovernor.observe(sample);
    let state = 'healthy';
    if (sample.memoryPercent >= MEMORY_DOWN_PERCENT) state = 'down';
    else if (sample.memoryPercent >= MEMORY_DEGRADED_PERCENT
      || sample.eventLoopDelayMs >= EVENT_LOOP_DEGRADED_MS) state = 'degraded';
    return { state, metrics: sample };
  },
};

function withTimeout(promise) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('probe timed out'), { code: 'PROBE_TIMEOUT' })), PROBE_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

class DependencyHealth {
  constructor({ probes = defaultProbes } = {}) {
    this.probes = probes;
    this.dependencies = new Map();
    this.enforcement = 'observe';
    this.forcedOff = [];
    this.timer = null;
    this.running = null;
    this.inFlight = new Set();
  }

  applyProbe(name, outcome, { reset = false } = {}) {
    const entry = this.dependencies.get(name) || {
      state: 'healthy', since: new Date().toISOString(), bad: 0, failures: 0, better: 0,
    };
    const raw = outcome.state;
    entry.bad = raw === 'healthy' ? 0 : entry.bad + 1;
    entry.failures = raw === 'down' ? entry.failures + 1 : 0;
    entry.better = severity(raw) < severity(entry.state) ? entry.better + 1 : 0;

    let next = entry.state;
    if (entry.better && (reset || entry.better >= RECOVER_AFTER)) {
      next = raw;
    } else if (entry.failures >= DOWN_AFTER) {
      next = 'down';
    } else if (entry.state === 'healthy'
      && (entry.failures >= TRIP_AFTER || (raw === 'degraded' && entry.bad >= (outcome.slow ? DOWN_AFTER : TRIP_AFTER)))) {
      next = 'degraded';
    }

    if (next !== entry.state) {
      logger[next === 'healthy' ? 'info' : 'warn'](`Dependency ${name}: ${entry.state} -> ${next}`, {
        detail: outcome.logDetail || outcome.detail,
      });
      entry.state = next;
      entry.better = 0;
      entry.since = new Date().toISOString();
    }
    entry.lastCheckedAt = new Date().toISOString();
    entry.detail = outcome.detail || null;
    entry.metrics = outcome.metrics || null;
    this.dependencies.set(name, entry);
  }

  async refreshSettings() {
    // A failed read keeps the last answer: losing the database must not
    // silently change what an admin decided.
    try {
      const enforcement = await getAppSetting(ENFORCEMENT_KEY, 'observe');
      const forcedOff = await getAppSetting(FORCED_OFF_KEY, []);
      this.enforcement = enforcement === 'enforce' ? 'enforce' : 'observe';
      this.forcedOff = Array.isArray(forcedOff) ? forcedOff.filter(isCapability) : [];
      const thresholds = await getAppSetting(CPU_THRESHOLDS_KEY, null);
      loadGovernor.configure({
        enforcing: this.enforcement === 'enforce',
        throttlePercent: thresholds?.throttlePercent ?? loadGovernor.DEFAULT_THROTTLE_PERCENT,
        resumePercent: thresholds?.resumePercent ?? loadGovernor.DEFAULT_RESUME_PERCENT,
      });
    } catch (error) {
      logger.warn('Degradation settings not refreshed', { error: error.message });
    }
  }

  /** Validated by the route; `forcedOff` holds catalog names only either way. */
  async updateSettings({ enforcement, forcedOff, cpuThresholds }) {
    if (enforcement !== undefined) {
      await upsertAppSetting(ENFORCEMENT_KEY, JSON.stringify(enforcement), 'system');
    }
    if (forcedOff !== undefined) {
      await upsertAppSetting(FORCED_OFF_KEY, JSON.stringify(forcedOff.filter(isCapability)), 'system');
    }
    if (cpuThresholds !== undefined) {
      await upsertAppSetting(CPU_THRESHOLDS_KEY, JSON.stringify(cpuThresholds), 'system');
    }
    await this.refreshSettings();
    return this.snapshot();
  }

  async runProbes(options) {
    // Beside the probes, so a stored force-off holds from the first pass.
    const settings = withTimeout(this.refreshSettings()).catch((error) => {
      logger.warn('Degradation settings not refreshed', { error: error.message });
    });
    await Promise.all(Object.entries(this.probes).map(async ([name, probe]) => {
      // A timeout abandons a probe but cannot cancel it. On a hung mount each new
      // one would pin another libuv thread, so it waits for the last to return.
      if (this.inFlight.has(name)) {
        this.applyProbe(name, { state: 'down', detail: 'previous check has not returned' }, options);
        return;
      }
      this.inFlight.add(name);
      const run = new Promise((resolve) => { resolve(probe()); }).finally(() => this.inFlight.delete(name));
      let outcome;
      try {
        outcome = await withTimeout(run);
      } catch (error) {
        run.catch(() => {});
        outcome = error?.code === 'PROBE_TIMEOUT'
          ? { state: 'degraded', detail: 'check timed out', slow: true }
          : { state: 'down', detail: 'check failed', logDetail: error?.message };
      }
      if (outcome) this.applyProbe(name, outcome, options);
      else this.dependencies.delete(name);
    }));
    // Bounded: a hung database must not freeze every other dependency's state.
    await settings;
  }

  /** One pass at a time: a slow probe must not pile up on the next tick. */
  tick(options) {
    if (!this.running) {
      this.running = this.runProbes(options).finally(() => { this.running = null; });
    }
    return this.running;
  }

  /** An admin's "check again": a dependency that answers well recovers at once. */
  async recheck() {
    await this.running;
    await this.tick({ reset: true });
    return this.snapshot();
  }

  states() {
    return Object.fromEntries([...this.dependencies].map(([name, entry]) => [name, entry.state]));
  }

  /** In probe order: results arrive as probes finish, which would reshuffle the page. */
  ordered() {
    return Object.keys(this.probes).filter((name) => this.dependencies.has(name))
      .map((name) => [name, this.dependencies.get(name)]);
  }

  /** `available` is what the dependencies allow, `paused` what is actually refused. */
  evaluate(name) {
    const decision = evaluate(name, this.states(), this.forcedOff);
    return { ...decision, paused: !decision.available && (decision.forced || this.enforcement === 'enforce') };
  }

  snapshot() {
    return {
      enforcement: this.enforcement,
      forcedOff: [...this.forcedOff],
      load: loadGovernor.status(),
      dependencies: Object.fromEntries(this.ordered().map(([name, entry]) => [name, {
        state: entry.state,
        since: entry.since,
        lastCheckedAt: entry.lastCheckedAt,
        detail: entry.detail,
        metrics: entry.metrics,
      }])),
      capabilities: Object.keys(CAPABILITIES).map((name) => this.evaluate(name)),
    };
  }

  start() {
    if (this.timer) return;
    this.tick().catch((error) => logger.warn('Dependency probe failed', { error: error.message }));
    this.timer = setInterval(() => {
      this.tick().catch((error) => logger.warn('Dependency probe failed', { error: error.message }));
    }, PROBE_INTERVAL_MS);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    // Not awaited: probes only read, and a hung one must not eat the shutdown window.
    hostMetrics.stop();
  }
}

module.exports = new DependencyHealth();
module.exports.DependencyHealth = DependencyHealth;
module.exports.diskState = diskState;
module.exports.ENFORCEMENT_KEY = ENFORCEMENT_KEY;
module.exports.FORCED_OFF_KEY = FORCED_OFF_KEY;
module.exports.TRIP_AFTER = TRIP_AFTER;
module.exports.DOWN_AFTER = DOWN_AFTER;
module.exports.RECOVER_AFTER = RECOVER_AFTER;
