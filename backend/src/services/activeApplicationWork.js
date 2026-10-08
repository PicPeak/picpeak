'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const logger = require('../utils/logger');

// Detached work must have a promise owner: stopping a timer does not prove its
// last callback stopped writing. This registry is shared by the restore drain
// and the normal shutdown owners; closing admission never cancels live work.
function createWorkRegistry() {
  const context = new AsyncLocalStorage();
  const pending = new Set();
  let closed = false;

  function hold(promise, scope) {
    scope.count += 1;
    const item = { promise: Promise.resolve(promise), scope };
    pending.add(item);
    item.promise.then(() => release(item), () => release(item));
    return item.promise;
  }

  function release(item) {
    pending.delete(item);
    item.scope.count -= 1;
  }

  function track(label, run) {
    const inherited = context.getStore();
    if (inherited?.control) {
      try { return Promise.resolve(run()); } catch (error) { return Promise.reject(error); }
    }
    if (closed && !(inherited && inherited.count > 0)) {
      const error = new Error('Application work is paused for coordinated restore');
      error.code = 'RESTORE_MAINTENANCE';
      error.statusCode = 503;
      return Promise.reject(error);
    }
    const scope = inherited?.count > 0 ? inherited : { label, count: 0 };
    // Reserve before invoking run, including its synchronous prefix and nested
    // calls. Existing accepted work may finish its own children after closure.
    let resolve;
    let reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    hold(promise, scope);
    context.run(scope, () => {
      try {
        // Preserve the synchronous prefix of existing async entry points:
        // backup's isRunning guard must become true before this call returns.
        Promise.resolve(run()).then(resolve, reject);
      } catch (error) {
        reject(error);
      }
    });
    return promise;
  }

  async function drain() {
    for (;;) {
      const current = [...pending].map(item => item.promise);
      if (current.length === 0) return;
      await Promise.allSettled(current);
      // A parent can enqueue a child before resolving. Repeat, rather than
      // declaring the initial snapshot of promises the complete work set.
    }
  }

  function defer(label, run) {
    const promise = track(label, () => new Promise((resolve, reject) => {
      setImmediate(() => {
        try { Promise.resolve(run()).then(resolve, reject); } catch (error) { reject(error); }
      });
    }));
    // Detached callers do not have a response channel. Preserve the failure
    // for promise owners and also report it instead of an unhandled rejection.
    promise.catch(error => logger.error('Detached application work failed', { label, error: error.message }));
    return promise;
  }

  // Internal maintenance operations use a separate owner; they must not wait
  // for themselves when draining ordinary work. Never derive this capability
  // from headers, role strings, or a missing request context.
  const runControl = run => context.run({ control: true, count: 0 }, () => {
    // Adopt Knex/other thenables while still inside the internal capability;
    // returning a raw builder would execute it later in the caller's context.
    try { return Promise.resolve(run()); } catch (error) { return Promise.reject(error); }
  });

  return { track, defer, drain, runControl, isControl: () => context.getStore()?.control === true,
    hasScope: () => (context.getStore()?.count || 0) > 0,
    closeAdmission: () => { closed = true; },
    isClosed: () => closed, pendingCount: () => pending.size };
}

const registry = createWorkRegistry();
module.exports = { ...registry, createWorkRegistry };
