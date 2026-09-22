/**
 * A clause hidden by "Show only if" (#1445) disappears with its heading —
 * in the PDF and on the signing page alike — and a section whose clauses are
 * all hidden loses its section heading too.
 */
const PDFDocument = require('pdfkit');
const pdfService = require('../../src/services/pdfService');
const { resolveDisplayContent } = require('../../src/services/contract/renderContext');
const { publicContractView } = require('../../src/services/contract/publicView');

const snapshot = (placeholders) => JSON.stringify({
  format: 2, title: 'Vertrag', introText: '', outroText: '', placeholders,
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
