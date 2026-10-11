'use strict';

const applicationWork = require('../services/activeApplicationWork');

function createApplicationWorkMiddleware({ work = applicationWork, admitRequest = () => {}, isControlRequest = () => false, enabled = () => true } = {}) {
  return function applicationWorkMiddleware(req, res, next) {
    // Where coordinated restore cannot run there is nothing to drain for: the
    // request passes straight through, as it did before this middleware.
    if (!enabled()) return next();
    if (isControlRequest(req)) return work.runControl(next);
    if (work.isClosed()) {
      return res.status(503).json({ error: 'Application work is paused for coordinated restore', code: 'RESTORE_MAINTENANCE' });
    }
    return work.track('HTTP request', () => {
      const response = new Promise(resolve => {
        const finished = () => {
          res.removeListener('finish', finished);
          res.removeListener('close', finished);
          resolve();
        };
        // Own streaming responses as well as handler promises. Client close
        // releases only the response owner, never a still-running async handler.
        res.once('finish', finished);
        res.once('close', finished);
        if (res.destroyed || res.writableFinished) finished();
      });
      const admission = work.track('HTTP admission', async () => {
        await admitRequest(req);
        // A close while checking the cross-replica fence must not release the
        // final owner and then dispatch an unowned writer afterwards.
        if (!res.destroyed && !res.writableFinished) next();
      }).catch(next);
      return Promise.all([response, admission]);
    }).catch(next);
  };
}

// Express 4 does not own the promises returned by async route/middleware
// handlers. Instrument this constructed app's leaf layers (including nested
// routers), without replacing routers or modifying Express's global prototype.
function ownRouteHandlers(app, work = applicationWork) {
  const owned = new WeakSet();
  function visit(stack) {
    for (const layer of stack || []) {
      if (layer.route) visit(layer.route.stack);
      else if (layer.handle?.stack) visit(layer.handle.stack);
      else {
        const original = layer.handle;
        if (typeof original !== 'function' || owned.has(original) || original.length > 4) continue;
        const invoke = (receiver, args, next) => {
          // Express's own query/init layers run before the ingress owner. In
          // particular, do not reject the ingress middleware before it can
          // send the maintenance response for an unadmitted request.
          if (!work.hasScope() && !work.isControl()) return original.apply(receiver, args);
          // Synchronous next() and synchronous prefixes keep their ordering.
          // A returned promise stays owned even after finish/close.
          const promise = work.track('HTTP handler', () => original.apply(receiver, args));
          promise.catch(next);
          return promise;
        };
        const replacement = original.length === 4
          ? function ownedErrorHandler(error, req, res, next) { return invoke(this, [error, req, res, next], next); }
          : function ownedHandler(req, res, next) { return invoke(this, [req, res, next], next); };
        // Route inventories and middleware diagnostics retain the original name.
        Object.defineProperty(replacement, 'name', { value: original.name, configurable: true });
        owned.add(replacement);
        layer.handle = replacement;
      }
    }
  }
  visit(app._router?.stack || app.stack);
}

module.exports = { createApplicationWorkMiddleware, ownRouteHandlers };
