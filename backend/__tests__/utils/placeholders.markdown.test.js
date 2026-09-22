/**
 * Placeholder escaping, markdown context (#1445): a contract body reads
 * `**bold**`; a placeholder value must not. Values are backslash-escaped on
 * substitution and the inline parser resolves the escapes, so the value
 * reads back exactly as typed while the template's own markup still works.
 */
const {
  escapeMarkdown, parseInlineMarkdown, markdownToPlain,
} = require('../../src/utils/placeholders');
const { renderTemplatedBody } = require('../../src/services/contract/renderContext');
const payloads = require('../helpers/placeholderPayloads');

const values = (value) => ({ customer_name: value, event_name: 'Hochzeit' });

test.each(Object.entries(payloads))('%s reads back as typed', (_, value) => {
  const body = renderTemplatedBody('Name: {{customer_name}}.', values(value));
  expect(markdownToPlain(body)).toBe(`Name: ${value}.`);
  expect(parseInlineMarkdown(body).every((run) => !run.bold)).toBe(true);
});

test('a value inside the template\'s bold stays one bold run, markers and all', () => {
  const body = renderTemplatedBody('**Kunde: {{customer_name}}** unterschreibt.', values(payloads.bold));
  expect(parseInlineMarkdown(body)).toEqual([
    { text: 'Kunde: **bold**', bold: true },
    { text: ' unterschreibt.', bold: false },
  ]);
});

test('a value cannot start a list or a quote on its own line', () => {
  expect(escapeMarkdown('- item\n> quote')).toBe('\\- item\n\\> quote');
  expect(markdownToPlain(escapeMarkdown('- item\n> quote'))).toBe('- item\n> quote');
});

test('the escaped characters', () => {
  expect(escapeMarkdown('a*b_c#d[e]f\\g')).toBe('a\\*b\\_c\\#d\\[e\\]f\\\\g');
});

test('the template\'s own markup keeps working as before', () => {
  expect(parseInlineMarkdown('a **b** c')).toEqual([
    { text: 'a ', bold: false }, { text: 'b', bold: true }, { text: ' c', bold: false },
  ]);
  // An unpaired marker stays as typed.
  expect(markdownToPlain('only **x')).toBe('only **x');
  expect(markdownToPlain('****')).toBe('****');
});

test('a value is substituted once: no placeholder or conditional inside it is expanded', () => {
  expect(markdownToPlain(renderTemplatedBody('{{customer_name}}', values(payloads.placeholder)))).toBe('{{customer_name}}');
  expect(markdownToPlain(renderTemplatedBody('{{customer_name}}', values(payloads.conditional))))
    .toBe('{{#if event_name}}shown{{/if}}');
});
