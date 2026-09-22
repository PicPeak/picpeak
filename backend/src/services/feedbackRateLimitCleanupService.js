/**
 * feedbackRateLimitCleanupService — backstop sweep for stale
 * feedback_rate_limits rows (#1585).
 *
 * consumeFeedbackLimit() (middleware/feedbackRateLimit.js) only deletes rows
 * for the event/action-type pair it is currently handling, so rows for a
 * gallery that goes quiet, or an action type nobody uses again, are never
 * removed by the request path. Without this sweep the table grows without
 * bound — each accepted feedback action writes two rows.
 *
 * Runs hourly, offset from the other hourly cleanup schedulers so they don't
 * all wake at once.
 */

const { scheduledTask } = require('./scheduledTask');
const logger = require('../utils/logger');
const { sweepStaleFeedbackRateLimits } = require('../middleware/feedbackRateLimit');

const task = scheduledTask(runFeedbackRateLimitCleanup, { schedule: '40 * * * *' });
function startFeedbackRateLimitCleanup() { task.start(); }
const stopFeedbackRateLimitCleanup = () => task.stop();

async function runFeedbackRateLimitCleanup() {
  try {
    await sweepStaleFeedbackRateLimits();
  } catch (err) {
    logger.error('Feedback rate-limit cleanup failed', { error: err.message });
  }
}

module.exports = {
  stopFeedbackRateLimitCleanup,
  startFeedbackRateLimitCleanup,
  // exported for tests / manual invocation
  runFeedbackRateLimitCleanup,
};
