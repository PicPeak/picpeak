/**
 * "Show only if…" (#1445): the builder writes a clause's body wrapped in
 * `{{#if key}}` / `{{#unless key}}` in every language and reads it back.
 */
import { applyCondition, readCondition, unwrapCondition } from '../clauseCondition';

const body = { de: 'Die Offerte {{source_quote_number}} gilt.', en: 'Quote {{source_quote_number}} applies.' };

it('wraps every language and reads the rule back', () => {
  const wrapped = applyCondition(body, { kind: 'if', key: 'source_quote_number' });
  expect(wrapped.de).toBe('{{#if source_quote_number}}Die Offerte {{source_quote_number}} gilt.{{/if}}');
  expect(readCondition(wrapped)).toEqual({ kind: 'if', key: 'source_quote_number' });
});

it('round-trips: removing the rule gives back the text as it was', () => {
  const wrapped = applyCondition(body, { kind: 'unless', key: 'event_date' });
  expect(wrapped.en).toBe('{{#unless event_date}}Quote {{source_quote_number}} applies.{{/unless}}');
  expect(applyCondition(wrapped, null)).toEqual(body);
  expect(unwrapCondition(wrapped)).toEqual(body);
});

it('changing the rule replaces it instead of nesting a second one', () => {
  const once = applyCondition(body, { kind: 'if', key: 'event_name' });
  const twice = applyCondition(once, { kind: 'unless', key: 'event_date' });
  expect(twice.de).toBe('{{#unless event_date}}Die Offerte {{source_quote_number}} gilt.{{/unless}}');
});

it('plain text has no rule; languages that disagree, or an inner block, read as mixed', () => {
  expect(readCondition(body)).toBeNull();
  expect(readCondition({})).toBeNull();
  expect(readCondition({ de: '{{#if event_name}}a{{/if}}', en: 'b' })).toBe('mixed');
  expect(readCondition({ de: 'a {{#if event_name}}b{{/if}}' })).toBe('mixed');
});

it('leaves an empty language empty', () => {
  expect(applyCondition({ de: 'x', en: '' }, { kind: 'if', key: 'event_name' })).toEqual({ de: '{{#if event_name}}x{{/if}}', en: '' });
});
