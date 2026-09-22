/**
 * Placeholder escaping, plain-text context (#1445): values are printed as
 * typed — markdown markers included — and substituted once. Guard for
 * existing behaviour.
 */
const { renderPlaceholders, CONTRACT_PLACEHOLDERS } = require('../../src/utils/placeholders');
const { renderTemplatedBody } = require('../../src/services/contract/renderContext');
const payloads = require('../helpers/placeholderPayloads');

const values = (value) => ({ customer_name: value, event_name: 'Hochzeit' });

test.each(Object.entries(payloads))('%s is printed as typed', (_, value) => {
  expect(renderPlaceholders('Name: {{customer_name}}', values(value), { allowlist: CONTRACT_PLACEHOLDERS }))
    .toBe(`Name: ${value}`);
  expect(renderTemplatedBody('Name: {{customer_name}}', values(value), { output: 'text' })).toBe(`Name: ${value}`);
});
