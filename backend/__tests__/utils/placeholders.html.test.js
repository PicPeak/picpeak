/**
 * Placeholder escaping, HTML context (#1445): a value lands as text, never as
 * markup, and is substituted once. Guard for existing behaviour.
 */
const { renderPlaceholders, CONTRACT_PLACEHOLDERS } = require('../../src/utils/placeholders');
const payloads = require('../helpers/placeholderPayloads');

const render = (text, value) => renderPlaceholders(text, { customer_name: value, event_name: 'Hochzeit' },
  { allowlist: CONTRACT_PLACEHOLDERS, output: 'html' });

test('markup in a value is escaped', () => {
  expect(render('<p>{{customer_name}}</p>', payloads.html)).toBe('<p>&lt;img src=x onerror=1&gt;</p>');
});

test('a value that looks like a placeholder or a conditional is printed, not expanded', () => {
  expect(render('{{customer_name}}', payloads.placeholder)).toBe('{{customer_name}}');
  expect(render('{{customer_name}}', payloads.conditional)).toBe('{{#if event_name}}shown{{/if}}');
});

test('long, right-to-left and emoji values pass through whole', () => {
  expect(render('{{customer_name}}', payloads.long)).toBe(payloads.long);
  expect(render('{{customer_name}}', payloads.rtl)).toBe(payloads.rtl);
  expect(render('{{customer_name}}', payloads.emoji)).toBe('Studio 📸 Anna &amp; Ben 💍');
});
