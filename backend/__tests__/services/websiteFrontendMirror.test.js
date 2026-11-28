/**
 * Website builder (issue 2618): what the frontend keeps a copy of, held to
 * the backend's. The editor offers the block types and layouts the backend
 * accepts (blocks.ts), names the legal pages the backend knows
 * (cms.service.ts), and checks an e-mail address by the backend's rule
 * (fields.tsx).
 */
const fs = require('fs');
const path = require('path');

const frontend = (file) => fs.readFileSync(path.resolve(__dirname, '../../../frontend/src', file), 'utf8');

test('the editor\'s block types and layouts are the ones the backend accepts', () => {
  const { BLOCK_VARIANTS } = require('../../src/services/website/document');
  const body = frontend('features/website/blocks.ts').match(/export const BLOCK_VARIANTS[^=]*= \{([\s\S]*?)\n\};/);
  expect(body).not.toBeNull();
  const variants = {};
  for (const [, type, list] of body[1].matchAll(/^\s+(\w+): \[([^\]]*)\],/gm)) {
    variants[type] = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  }
  expect(variants).toEqual(BLOCK_VARIANTS);
});

test('the frontend\'s legal pages are the backend\'s, in its order', () => {
  const { LEGAL_SLUGS } = require('../../src/services/website/document');
  const list = frontend('services/cms.service.ts').match(/export const LEGAL_PAGE_SLUGS = \[([^\]]*)\] as const;/);
  expect(list).not.toBeNull();
  expect([...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1])).toEqual(LEGAL_SLUGS);
});

test('the editor checks an e-mail address by the backend\'s rule', () => {
  const { EMAIL_PATTERN } = require('../../src/services/website/validators');
  const literal = frontend('features/website/fields.tsx').match(/export const EMAIL_PATTERN = \/(.+)\/;\n/);
  expect(literal).not.toBeNull();
  expect(literal[1]).toBe(EMAIL_PATTERN.source);
});
