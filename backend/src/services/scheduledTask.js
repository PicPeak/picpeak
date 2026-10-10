const cron = require('node-cron');
const logger = require('../utils/logger');
const applicationWork = require('./activeApplicationWork');
/** One owner for a periodic job, with no overlapping runs and a draining stop. */
function scheduledTask(run, { schedule, interval, initialDelay } = {}) {
  let started = false, timer = null, first = null, running = null;
  const tick = () => {
    if (!started || running) return running;
    running = applicationWork.track('scheduled task', run).catch(error => {
      logger.error('Scheduled task failed', { error: error.message });
    }).finally(() => { running = null; });
    return running;
  };
  return {
    start() {
      if (started) return;
      started = true;
      timer = schedule ? cron.schedule(schedule, tick) : setInterval(tick, interval);
      if (!schedule) timer.unref?.();
      if (initialDelay !== undefined) { first = setTimeout(tick, initialDelay); first.unref?.(); }
    },
    async stop() {
      started = false;
      if (schedule) timer?.stop(); else clearInterval(timer);
      clearTimeout(first); timer = null; first = null;
      await running;
    },
  };
}
module.exports = { scheduledTask };
