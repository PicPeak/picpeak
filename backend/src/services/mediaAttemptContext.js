const { AsyncLocalStorage } = require('async_hooks');
const context = new AsyncLocalStorage();
module.exports = { current: () => context.getStore(), run: (attempt, callback) => context.run(attempt, callback) };
