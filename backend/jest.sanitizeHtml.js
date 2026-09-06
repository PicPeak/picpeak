/**
 * sanitize-html 2.17.6+ depends on htmlparser2 12, which ships ESM only.
 * Node 22.12+ loads it fine through require(esm); Jest 29's CommonJS module
 * registry cannot evaluate an ESM file and fails every suite that imports a
 * route or service using the sanitiser. Rather than bolting a Babel
 * transform onto node_modules for one dependency, hand this single module to
 * Node's own loader.
 *
 * process.getBuiltinModule (Node 22.3+) is the real core `module` even inside
 * Jest — a plain require('module') here returns Jest's wrapper, whose
 * createRequire() hands back an empty object for this package. createRequire()
 * on the real one resolves from backend/node_modules exactly like production.
 *
 * Wired in via moduleNameMapper in jest.config.js. The module is stateless,
 * so sharing one instance across test files changes nothing; it just cannot
 * be jest.mock()ed, and nothing mocks it.
 */
module.exports = process.getBuiltinModule('module').createRequire(__filename)('sanitize-html');
