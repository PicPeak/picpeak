/** An idle deadline, not a maximum duration for a healthy large build. */
function createBuildProgress(timeoutMs) {
  const controller = new AbortController();
  let lastProgress = Date.now();
  let revision = 0;
  const timer = setInterval(() => {
    if (Date.now() - lastProgress >= timeoutMs) {
      controller.abort(new Error('Download preparation stopped making progress. Please try again'));
    }
  }, Math.min(1000, timeoutMs));
  timer.unref();
  return {
    signal: controller.signal,
    get revision() { return revision; },
    touch() { lastProgress = Date.now(); revision += 1; },
    abort(error) { controller.abort(error); },
    close() { clearInterval(timer); },
    wait(promise) {
      // Attach both outcomes even after an abort: a late source/render must
      // not produce an unhandled rejection or resume the abandoned build.
      return new Promise((resolve, reject) => {
        const aborted = () => reject(controller.signal.reason);
        const finish = (callback, value) => {
          controller.signal.removeEventListener('abort', aborted);
          callback(value);
        };
        if (controller.signal.aborted) aborted();
        else controller.signal.addEventListener('abort', aborted, { once: true });
        Promise.resolve(promise).then((value) => finish(resolve, value), (error) => finish(reject, error));
      });
    },
  };
}

module.exports = { createBuildProgress };
