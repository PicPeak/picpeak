/**
 * Placeholder escaping, signing-page context (#1445): the page prints the
 * contract as plain text. It used to strip `**…**` after substitution, so a
 * customer called `**ACME**` read "ACME" there and bold "ACME" in the PDF.
 * Now both read the markup with one parser: the value is printed as typed,
 * the template's markup is dropped.
 */
const { publicContractView } = require('../../src/services/contract/publicView');
const { renderTemplatedBody } = require('../../src/services/contract/renderContext');
const payloads = require('../helpers/placeholderPayloads');

const values = (value) => ({ customer_name: value, event_name: 'Hochzeit' });

function view(template, value) {
  const body = renderTemplatedBody(template, values(value));
  const display = {
    title: 'Vertrag',
    introText: body,
    outroText: null,
    sections: [{ section: 'scope', blocks: [{ blockId: 1, position: 1, name: 'Leistung', body }] }],
  };
  return publicContractView({ status: 'sent' }, display, null, null, null, null);
}

test.each(Object.entries(payloads))('%s is shown as typed', (_, value) => {
  const v = view('**Kunde:** {{customer_name}}', value);
  expect(v.sections[0].blocks[0].body).toBe(`Kunde: ${value}`);
  expect(v.introText).toBe(`Kunde: ${value}`);
});
