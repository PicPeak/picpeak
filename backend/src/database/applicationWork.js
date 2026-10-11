'use strict';

const applicationWork = require('../services/activeApplicationWork');
const installed = new WeakMap();

// Detached query promises, raw SQL, schema builders and transactions all reach
// these Knex client methods. Transaction clients inherit this dialect prototype
// as well; wrapping only the exported db Proxy would leave that copy unowned.
// Install only when the live server's maintenance protocol is initialized.
function installApplicationWork(client, work = applicationWork) {
  const prototype = client.constructor.prototype;
  const current = installed.get(prototype);
  if (current) {
    if (current.work !== work) throw new Error('Database work owner is already installed');
    return current.dispose;
  }
  const originals = new Map();
  const replacements = new Map();
  for (const method of ['runner', 'query', 'stream']) {
    const original = prototype[method];
    if (typeof original !== 'function') continue;
    originals.set(method, Object.getOwnPropertyDescriptor(prototype, method));
    const replacement = function ownedDatabaseOperation(...args) {
      if (method === 'runner') {
        const runner = original.apply(this, args);
        const run = runner.run;
        // Own execution before its asynchronous connection acquisition, not
        // only the eventual SQL call after its origin handler has returned.
        runner.run = function ownedQueryRunner(...runArgs) {
          return work.track('database runner', () => run.apply(this, runArgs));
        };
        return runner;
      }
      return work.track(`database ${method}`, () => original.apply(this, args));
    };
    replacements.set(method, replacement);
    Object.defineProperty(prototype, method, { value: replacement, configurable: true, writable: true });
  }
  const dispose = () => {
    for (const [method, replacement] of replacements) {
      if (prototype[method] !== replacement) throw new Error('Database work owner changed before removal');
      const descriptor = originals.get(method);
      if (descriptor) Object.defineProperty(prototype, method, descriptor);
      else delete prototype[method];
    }
    installed.delete(prototype);
  };
  installed.set(prototype, { work, dispose });
  return dispose;
}

module.exports = { installApplicationWork };
