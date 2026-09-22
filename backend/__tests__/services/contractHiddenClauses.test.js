/**
 * A clause hidden by "Show only if" (#1445) disappears with its heading —
 * in the PDF and on the signing page alike — and a section whose clauses are
 * all hidden loses its section heading too.
 */
const PDFDocument = require('pdfkit');
const pdfService = require('../../src/services/pdfService');
const { resolveDisplayContent } = require('../../src/services/contract/renderContext');
const { publicContractView } = require('../../src/services/contract/publicView');

const snapshot = (placeholders, format = 3) => JSON.stringify({
  format, title: 'Vertrag', introText: '', outroText: '', placeholders,
  clauses: [
    { kind: 'text', blockId: null, section: 'scope', position: 1, slug: null, name: 'Leistung', body: { de: 'Fotos.' } },
    { kind: 'text', blockId: null, section: 'scope', position: 2, slug: null, name: 'Anlass', body: { de: '{{#if event_name}}Für {{event_name}}.{{/if}}' } },
    { kind: 'text', blockId: null, section: 'nda', position: 3, slug: null, name: 'Geheim', body: { de: '{{#unless source_quote_number}}Nur ohne Offerte.{{/unless}}' } },
  ],
});

async function display(placeholders) {
  return resolveDisplayContent({ rendered_content: snapshot(placeholders) }, [], [], 'de');
}

async function drawnTexts(d) {
  const drawn = [];
  const text = PDFDocument.prototype.text;
  jest.spyOn(PDFDocument.prototype, 'text').mockImplementation(function (str, ...rest) {
    drawn.push(String(str));
    return text.call(this, str, ...rest);
  });
  await pdfService.renderContractToBuffer({
    locale: 'de', issuer: { companyName: 'S' }, recipient: {}, doc: { contractNumber: 'C-1' }, sections: d.sections,
  });
  jest.restoreAllMocks();
  return drawn;
}

test('hidden clauses and emptied sections are gone from the display content', async () => {
  const shown = await display({ event_name: 'Hochzeit', source_quote_number: '' });
  expect(shown.sections.map((s) => [s.section, s.blocks.map((b) => b.name)]))
    .toEqual([['scope', ['Leistung', 'Anlass']], ['nda', ['Geheim']]]);
  const hidden = await display({ event_name: '', source_quote_number: 'Q-1' });
  expect(hidden.sections.map((s) => [s.section, s.blocks.map((b) => b.name)])).toEqual([['scope', ['Leistung']]]);
});

test('the PDF draws no heading for a hidden clause or an emptied section', async () => {
  const { t } = pdfService._internal;
  const texts = await drawnTexts(await display({ event_name: '', source_quote_number: 'Q-1' }));
  expect(texts).toContain('Leistung');
  expect(texts).not.toContain('Anlass');
  expect(texts).not.toContain('Geheim');
  expect(texts).not.toContain(t('de', 'section_nda'));
});

test('the signing page shows no heading for a hidden clause or an emptied section', async () => {
  const view = publicContractView({ status: 'sent' }, await display({ event_name: '', source_quote_number: 'Q-1' }), null, null, null, null);
  expect(view.sections.map((s) => s.section)).toEqual(['scope']);
  expect(view.sections[0].blocks.map((b) => b.name)).toEqual(['Leistung']);
});

test('values are escaped for the markup from format 3; an earlier snapshot keeps reading them as before', async () => {
  const body = (d) => d.sections[0].blocks.find((b) => b.name === 'Anlass').body;
  const current = await display({ event_name: '**Gala**', source_quote_number: '' });
  expect(body(current)).toBe('Für \\*\\*Gala\\*\\*.');
  // Sent before values were escaped: its stored PDF printed the value's markup.
  const earlier = await resolveDisplayContent({ rendered_content: snapshot({ event_name: '**Gala**', source_quote_number: '' }, 2) }, [], [], 'de');
  expect(body(earlier)).toBe('Für **Gala**.');
  // …and a backslash stays a backslash, on the signing page and in the PDF.
  const withBackslash = await resolveDisplayContent({ rendered_content: snapshot({ event_name: 'ACME\\_EU', source_quote_number: '' }, 2) }, [], [], 'de');
  const view = publicContractView({ status: 'sent' }, withBackslash, null, null, null, null);
  expect(view.sections[0].blocks.find((b) => b.name === 'Anlass').body).toBe('Für ACME\\_EU.');
  const { parseInlineMarkdown } = require('../../src/utils/placeholders');
  expect(parseInlineMarkdown(body(withBackslash)).map((r) => r.text).join('')).toBe('Für ACME\\_EU.');
});

test('a contract sent before format 3 keeps a clause emptied by a condition, as its PDF printed it', async () => {
  const earlier = await resolveDisplayContent({ rendered_content: snapshot({ event_name: '', source_quote_number: 'Q-1' }, 2) }, [], [], 'de');
  expect(earlier.sections.map((s) => [s.section, s.blocks.map((b) => b.name)]))
    .toEqual([['scope', ['Leistung', 'Anlass']], ['nda', ['Geheim']]]);
});
