/**
 * Unit tests for utils/placeholders (#1451): allowlisted {{key}} placeholders
 * in quote texts.
 */
const {
  QUOTE_PLACEHOLDERS, findPlaceholders, unknownPlaceholders, renderPlaceholders,
} = require('../../src/utils/placeholders');

describe('findPlaceholders / unknownPlaceholders', () => {
  it('lists each key once, in order', () => {
    expect(findPlaceholders('Hi {{customer_name}}, {{ event_name }} on {{event_date}} — {{customer_name}}'))
      .toEqual(['customer_name', 'event_name', 'event_date']);
  });

  it('reports keys outside the allowlist', () => {
    expect(unknownPlaceholders('{{customer_name}} {{custmer_name}} {{constructor}}'))
      .toEqual(['custmer_name', 'constructor']);
  });

  it('does not treat property paths or expressions as placeholders', () => {
    expect(findPlaceholders('{{customer.name}} {{ a + b }} {{#if x}}')).toEqual([]);
  });

  it('allows every declared quote key', () => {
    expect(unknownPlaceholders(QUOTE_PLACEHOLDERS.map((k) => `{{${k}}}`).join(' '))).toEqual([]);
  });
});

describe('renderPlaceholders', () => {
  it('fills known keys and empties known keys without a value', () => {
    expect(renderPlaceholders('{{customer_name}} · {{event_date}}.', { customer_name: 'Anna' }))
      .toBe('Anna · .');
  });

  it('leaves unknown keys visible', () => {
    expect(renderPlaceholders('{{customer_name}} {{nope}}', { customer_name: 'Anna', nope: 'x' }))
      .toBe('Anna {{nope}}');
  });

  it('escapes values for HTML output only', () => {
    const values = { customer_name: '<b>Anna</b>' };
    expect(renderPlaceholders('{{customer_name}}', values)).toBe('<b>Anna</b>');
    expect(renderPlaceholders('{{customer_name}}', values, { output: 'html' })).toBe('&lt;b&gt;Anna&lt;/b&gt;');
  });

  it('never looks values up on the prototype', () => {
    expect(renderPlaceholders('{{constructor}}', {}, { allowlist: ['constructor'] })).toBe('');
  });

  it('passes non-strings through', () => {
    expect(renderPlaceholders(null, {})).toBeNull();
  });
});
