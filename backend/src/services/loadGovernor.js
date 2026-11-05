'use strict';

const logger = require('../utils/logger');

/**
 * Slows background work down when the server is busy, so guests stay fast.
 *
 * Fed by the `load` probe every 15 seconds. When the average of two fresh
 * readings is above the limit the level rises one step, below the resume point
 * (with a calm event loop) it falls one step, and anything between holds. The gap keeps it from flipping on and off, which
 * matters because preview generation causes much of the load it reacts to.
 *
 *   level 0  normal
 *   level 1  half the photo workers, bulk work paced
 *   level 2  one photo worker, bulk work paced harder
 *   level 3  critical memory only: photo workers wait
 *
 * CPU alone never stops photo processing. On a small server previews are often
 * the load, so a full stop could mean they never finish. Previews a guest is
 * waiting for are untouched: they run in the request and isolatedSharp puts
 * them ahead of queued work.
 *
 * Each process governs itself. Applied only in enforce mode; in observe mode
 * the level is worked out and shown, and the workers keep their full speed.
 */
const LEVELS = Object.freeze({ NORMAL: 0, REDUCED: 1, MINIMUM: 2, PAUSED: 3 });
const BULK_DELAYS_MS = Object.freeze([0, 2_000, 10_000, 30_000]);
const WINDOW = 2;
const EVENT_LOOP_THROTTLE_MS = 200;
const EVENT_LOOP_RESUME_MS = 50;
const MEMORY_CRITICAL_PERCENT = 97;

const DEFAULT_THROTTLE_PERCENT = 70;
const DEFAULT_RESUME_PERCENT = 50;

class LoadGovernor {
  constructor() {
    this.level = LEVELS.NORMAL;
    this.enforcing = false;
    this.throttlePercent = DEFAULT_THROTTLE_PERCENT;
    this.resumePercent = DEFAULT_RESUME_PERCENT;
    this.readings = [];
  }

  configure({ enforcing, throttlePercent, resumePercent }) {
    if (enforcing !== undefined) this.enforcing = enforcing;
    if (throttlePercent !== undefined) this.throttlePercent = throttlePercent;
    if (resumePercent !== undefined) this.resumePercent = resumePercent;
  }

  observe({ cpuPercent, eventLoopDelayMs, memoryPercent }) {
    this.readings = [...this.readings, { cpuPercent, eventLoopDelayMs }].slice(-WINDOW);
    const previous = this.level;

    if (memoryPercent >= MEMORY_CRITICAL_PERCENT) {
      this.level = LEVELS.PAUSED;
    } else if (this.level === LEVELS.PAUSED) {
      this.level = LEVELS.MINIMUM;
    } else if (this.readings.length === WINDOW) {
      const known = this.readings.filter((reading) => typeof reading.cpuPercent === 'number');
      const cpu = known.length
        ? known.reduce((sum, reading) => sum + reading.cpuPercent, 0) / known.length
        : null;
      const delays = this.readings.map((reading) => reading.eventLoopDelayMs || 0);
      const busy = (cpu !== null && cpu >= this.throttlePercent)
        || delays.every((delay) => delay >= EVENT_LOOP_THROTTLE_MS);
      const calm = (cpu === null || cpu < this.resumePercent)
        && delays.every((delay) => delay < EVENT_LOOP_RESUME_MS);
      if (busy && this.level < LEVELS.MINIMUM) this.level += 1;
      else if (calm && this.level > LEVELS.NORMAL) this.level -= 1;
    }

    if (this.level !== previous) {
      // The next step needs fresh readings, taken after this one took effect.
      this.readings = [];
      logger.info(`Load level ${previous} -> ${this.level}${this.enforcing ? '' : ' (observe mode)'}`);
    }
    return this.level;
  }

  appliedLevel() {
    return this.enforcing ? this.level : LEVELS.NORMAL;
  }

  /** How many of `configured` workers may run now. A worker above it waits. */
  workerLimit(configured) {
    const level = this.appliedLevel();
    if (level === LEVELS.PAUSED) return 0;
    if (level === LEVELS.MINIMUM) return Math.min(1, configured);
    if (level === LEVELS.REDUCED) return Math.ceil(configured / 2);
    return configured;
  }

  /** Pause before the next item of low-priority work. Slows it, never drops it. */
  bulkDelayMs() {
    return BULK_DELAYS_MS[this.appliedLevel()];
  }

  status() {
    return {
      level: this.level,
      applied: this.enforcing,
      throttlePercent: this.throttlePercent,
      resumePercent: this.resumePercent,
    };
  }
}

module.exports = new LoadGovernor();
module.exports.LoadGovernor = LoadGovernor;
module.exports.DEFAULT_THROTTLE_PERCENT = DEFAULT_THROTTLE_PERCENT;
module.exports.DEFAULT_RESUME_PERCENT = DEFAULT_RESUME_PERCENT;
