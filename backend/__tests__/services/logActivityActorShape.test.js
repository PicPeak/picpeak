/**
 * logActivity(type, metadata, eventId, actor, executor) reads `actor` as
 * `{ type, id, name }`. A string such as `admin:${adminId}` or 'scheduler'
 * is stored as the system with no id, so the entry is attributed to nobody;
 * the quote, invoice, contract and billing services all did that once.
 *
 * Source scan over backend/src: every logActivity call's actor argument must
 * not be a string or template literal at its top level. A literal nested in
 * a call or an object (`normalizeActor(adminId || 'public:x')`,
 * `actor || { type: 'system' }`) is fine.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '../../src');

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '__tests__' || entry.name === 'node_modules') return [];
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return entry.name.endsWith('.js') ? [file] : [];
  });
}

// Index just past the quoted string or template starting at `i`, recursing
// into `${...}` so a nested template does not end the outer one early.
function skipQuoted(src, i) {
  const quote = src[i];
  let j = i + 1;
  while (j < src.length && src[j] !== quote) {
    if (src[j] === '\\') j += 2;
    else if (quote === '`' && src[j] === '$' && src[j + 1] === '{') j = skipBalanced(src, j + 1);
    else j += 1;
  }
  return j + 1;
}

// Index just past the bracket group opening at `i`.
function skipBalanced(src, i) {
  let depth = 0;
  for (let j = i; j < src.length;) {
    const c = src[j];
    if (c === '\'' || c === '"' || c === '`') { j = skipQuoted(src, j); continue; }
    if (c === '/' && src[j + 1] === '/') { j = src.indexOf('\n', j); continue; }
    if (c === '/' && src[j + 1] === '*') { j = src.indexOf('*/', j) + 2; continue; }
    if ('([{'.includes(c)) depth += 1;
    if (')]}'.includes(c)) { depth -= 1; if (depth === 0) return j + 1; }
    j += 1;
  }
  throw new Error(`unbalanced bracket at ${i}`);
}

// The top-level arguments of the call whose `(` is at `open`, each as
// { text, topLevelString } — the latter true when a string or template
// literal sits outside any bracket of that argument. A ternary's condition
// does not count (`role === 'admin' ? {...} : {...}`), only its branches.
function callArguments(src, open) {
  const args = [];
  let start = open + 1;
  let topLevelString = false;
  const end = skipBalanced(src, open) - 1;
  for (let j = open + 1; j <= end;) {
    const c = src[j];
    if (j === end || c === ',') {
      const text = src.slice(start, j).trim();
      if (text) args.push({ text, topLevelString });
      start = j + 1; topLevelString = false; j += 1;
    } else if (c === '\'' || c === '"' || c === '`') {
      topLevelString = true; j = skipQuoted(src, j);
    } else if (c === '?' && src[j + 1] !== '.' && src[j + 1] !== '?' && src[j - 1] !== '?') {
      topLevelString = false; j += 1;
    } else if (c === '/' && src[j + 1] === '/') {
      j = src.indexOf('\n', j);
    } else if (c === '/' && src[j + 1] === '*') {
      j = src.indexOf('*/', j) + 2;
    } else if ('([{'.includes(c)) {
      j = skipBalanced(src, j);
    } else {
      j += 1;
    }
  }
  return args;
}

function stringActorCalls(file, src) {
  const offenders = [];
  for (const match of src.matchAll(/\blogActivity\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    const actor = callArguments(src, open)[3];
    if (actor && actor.topLevelString) {
      const line = src.slice(0, match.index).split('\n').length;
      offenders.push(`${path.relative(SRC, file)}:${line} ${actor.text}`);
    }
  }
  return offenders;
}

describe('logActivity actor shape', () => {
  it('the scan catches the string shapes it guards against', () => {
    const src = [
      'logActivity(\'a\', {}, null, `admin:${adminId}`);',
      'logActivity(\'b\', {}, null, \'scheduler\');',
      'logActivity(\'c\', { x: \')\' }, id,\n  adminId ? `admin:${adminId}` : \'public:x\', trx);',
      'logActivity(\'d\', {}, null, { type: \'admin\', id: adminId }, trx);',
      'logActivity(\'e\', {}, null, normalizeActor(adminId || \'public:x\'));',
      'logActivity(\'f\', {}, null, actor || { type: \'system\' });',
      'logActivity(\'g\', { note: `${a}, ${b}` }, null, actor);',
      'logActivity(\'h\', {});',
      'logActivity(\'i\', {}, null, role === \'admin\' ? { type: \'admin\' } : actor);',
      'logActivity(\'j\', {}, null, actor ?? \'system\');',
    ].join('\n');
    expect(stringActorCalls(path.join(SRC, 'x.js'), src).map((o) => o.split(' ')[0]))
      .toEqual(['x.js:1', 'x.js:2', 'x.js:3', 'x.js:11']);
  });

  it('no logActivity call in backend/src passes a string actor', () => {
    const offenders = sourceFiles(SRC).flatMap((file) => stringActorCalls(file, fs.readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
