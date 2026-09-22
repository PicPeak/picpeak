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

  it('reports the key of a conditional, so a typo in one is caught at publish', () => {
    // The renderer drops a conditional whose key it doesn't know, so an
    // unreported typo meant a clause that never appeared on any document.
    expect(findPlaceholders('{{#if event_date}}on {{event_date}}{{/if}}')).toEqual(['event_date']);
    expect(unknownPlaceholders('{{#if evnt_date}}x{{/if}}')).toEqual(['evnt_date']);
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

  it('substitutes a placeholder written with spaces, like the check accepts', () => {
    // The contract renderer used to substitute only the tight form, so
    // `{{ customer_name }}` passed the publish check and then printed
    // literally on every contract.
    expect(renderPlaceholders('Hallo {{ customer_name }}', { customer_name: 'Anna' })).toBe('Hallo Anna');
  });
});

describe('renderConditionals', () => {
  const { renderConditionals } = require('../../src/utils/placeholders');

  it('keeps the block for a value and drops it for none, spaces and all', () => {
    expect(renderConditionals('A{{#if k}}B{{/if}}C', { k: 'x' })).toBe('ABC');
    expect(renderConditionals('A{{ #if k }}B{{ /if }}C', { k: 'x' })).toBe('ABC');
    expect(renderConditionals('A{{#if k}}B{{/if}}C', { k: '' })).toBe('AC');
    expect(renderConditionals('A{{#if missing}}B{{/if}}C', {})).toBe('AC');
  });
});

describe('the contract placeholder registry (#1445)', () => {
  const { CONTRACT_PLACEHOLDER_REGISTRY, CONTRACT_PLACEHOLDERS } = require('../../src/utils/placeholders');

  it('is the allowlist: one entry per key, nothing more, nothing less', () => {
    const keys = CONTRACT_PLACEHOLDER_REGISTRY.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...CONTRACT_PLACEHOLDERS]).toEqual(keys);
  });

  it('gives every key a category, labels and samples in English and German', () => {
    for (const entry of CONTRACT_PLACEHOLDER_REGISTRY) {
      expect(['customer', 'event', 'contract', 'pricing', 'issuer']).toContain(entry.category);
      expect(typeof entry.conditional).toBe('boolean');
      for (const locale of ['en', 'de']) {
        expect(entry.label[locale]).toEqual(expect.any(String));
        expect(entry.sample[locale]).toEqual(expect.any(String));
      }
    }
  });

  it('labels the cancellation percentage as fixed rather than presenting it as data', () => {
    const entry = CONTRACT_PLACEHOLDER_REGISTRY.find((e) => e.key === 'cancellation_30d_percent');
    expect(entry.label.en).toMatch(/fixed/);
    expect(entry.label.de).toMatch(/fest/);
  });
});

describe('{{#unless}} (#1445)', () => {
  const { renderConditionals, findPlaceholders, unknownPlaceholders, conditionalProblems, CONTRACT_PLACEHOLDERS } = require('../../src/utils/placeholders');

  it('keeps its block exactly when the key has no value', () => {
    const text = '{{#unless source_quote_number}}Ohne Offerte.{{/unless}}';
    expect(renderConditionals(text, { source_quote_number: '' })).toBe('Ohne Offerte.');
    expect(renderConditionals(text, {})).toBe('Ohne Offerte.');
    expect(renderConditionals(text, { source_quote_number: 'Q-1' })).toBe('');
  });

  it('sits next to #if blocks and does not pair with their closing tag', () => {
    const text = '{{#if event_name}}A{{/if}}{{#unless event_name}}B{{/unless}}';
    expect(renderConditionals(text, { event_name: 'x' })).toBe('A');
    expect(renderConditionals(text, {})).toBe('B');
    expect(renderConditionals('{{#unless a}}x{{/if}}', {})).toBe('{{#unless a}}x{{/if}}');
    expect(conditionalProblems('{{#unless a}}x{{/if}}')).toEqual(['CONDITIONAL_UNCLOSED']);
  });

  it('reports its key, so a typo is caught at publish', () => {
    expect(findPlaceholders('{{#unless evnt_date}}x{{/unless}}')).toEqual(['evnt_date']);
    expect(unknownPlaceholders('{{#unless evnt_date}}x{{/unless}}', CONTRACT_PLACEHOLDERS)).toEqual(['evnt_date']);
  });

  it('nested inside an #if is refused by the check', () => {
    expect(conditionalProblems('{{#if a}}{{#unless b}}x{{/unless}}{{/if}}')).toEqual(['CONDITIONAL_NESTED']);
  });
});
