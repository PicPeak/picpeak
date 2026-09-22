/**
 * Placeholder escaping, email context (#1445): the contract emails fill
 * their templates with emailProcessor.safeTemplateReplace — escaped in the
 * HTML part, as typed in the plain-text part, once in both. Guard for
 * existing behaviour, with the values a contract email carries.
 */
const { safeTemplateReplace } = require('../../src/services/emailProcessor');
const payloads = require('../helpers/placeholderPayloads');

const vars = (value) => ({ customer_name: value, contract_number: 'C-2026-0001', event_name: 'Hochzeit' });

test('the HTML part escapes a value', () => {
  expect(safeTemplateReplace('<p>Hallo {{customer_name}}</p>', vars(payloads.html), { escapeHtml: true }))
    .toBe('<p>Hallo &lt;img src=x onerror=1&gt;</p>');
});

test.each(Object.entries(payloads))('the plain-text part prints %s as typed', (_, value) => {
  expect(safeTemplateReplace('Hallo {{customer_name}}, Vertrag {{contract_number}}', vars(value)))
    .toBe(`Hallo ${value}, Vertrag C-2026-0001`);
});

test('a value is substituted once in both parts', () => {
  for (const options of [{}, { escapeHtml: true }]) {
    expect(safeTemplateReplace('{{customer_name}}', vars(payloads.placeholder), options)).toBe('{{customer_name}}');
    expect(safeTemplateReplace('{{customer_name}}', vars(payloads.conditional), options))
      .toBe('{{#if event_name}}shown{{/if}}');
  }
});
