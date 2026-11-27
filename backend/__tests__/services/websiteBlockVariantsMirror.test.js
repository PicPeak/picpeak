/**
 * Website builder (issue 2618): the editor offers the block types and
 * layouts the backend accepts. The frontend keeps its own copy
 * (frontend/src/features/website/blocks.ts); this test holds it to
 * document.js.
 */
const fs = require('fs');
const path = require('path');

test('the editor\'s block types and layouts are the ones the backend accepts', () => {
  const { BLOCK_VARIANTS } = require('../../src/services/website/document');
  const source = fs.readFileSync(path.resolve(__dirname, '../../../frontend/src/features/website/blocks.ts'), 'utf8');
  const body = source.match(/export const BLOCK_VARIANTS[^=]*= \{([\s\S]*?)\n\};/);
  expect(body).not.toBeNull();
  const frontend = {};
  for (const [, type, list] of body[1].matchAll(/^\s+(\w+): \[([^\]]*)\],/gm)) {
    frontend[type] = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  }
  expect(frontend).toEqual(BLOCK_VARIANTS);
});
