/**
 * Website builder (issue 2618): the paths a website page may not take live in
 * one file, backend/src/services/website/reservedSlugs.json. nginx cannot read
 * JSON and the frontend is built from its own directory, so both keep a copy;
 * this test fails as soon as either drifts from the file.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../../..');
const canonical = require('../../src/services/website/reservedSlugs.json');
const sorted = (list) => [...list].sort();

test('the backend validates against the shared list', () => {
  const { RESERVED_SLUGS } = require('../../src/services/website/document');
  expect(sorted(RESERVED_SLUGS)).toEqual(sorted(canonical));
});

test('the nginx website location excludes exactly the shared list', () => {
  const conf = fs.readFileSync(path.join(root, 'frontend/nginx.conf'), 'utf8');
  const match = conf.match(/location ~ "\^\/\(\?!\(\?:([a-z0-9|-]+)\)\/\?\$\)\[a-z0-9\]\+/);
  expect(match).not.toBeNull();
  expect(sorted(match[1].split('|'))).toEqual(sorted(canonical));
});

test('the frontend page editor checks the shared list', () => {
  const source = fs.readFileSync(path.join(root, 'frontend/src/features/website/PagesPanel.tsx'), 'utf8');
  const block = source.match(/export const RESERVED_SLUGS = new Set\(\[([\s\S]*?)\]\);/);
  expect(block).not.toBeNull();
  const slugs = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  expect(sorted(slugs)).toEqual(sorted(canonical));
});
