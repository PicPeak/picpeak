/**
 * Signature slots (#1445): the contract renderer places one slot per signer
 * and reports where; the stamp service fills a slot from that record (image,
 * typed name, captions) and draws the identifier band.
 */

const PDFKit = require('pdfkit');
const { PDFDocument } = require('pdf-lib');
const pdfService = require('../../src/services/pdfService');
const pdfStampService = require('../../src/services/pdfStampService');

const L = pdfService.CONTRACT_SIGNATURE_LAYOUT;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const contractContext = (extra = {}) => ({
  locale: 'de',
  issuer: { companyName: 'Studio Test', addressLine1: 'Weg 1', postalCode: '9490', city: 'Vaduz', countryCode: 'LI' },
  recipient: { companyName: 'Kunde AG' },
  doc: { contractNumber: 'C-2026-0001', issueDate: '2026-09-14' },
  sections: [{ section: 'scope', blocks: [{ name: 'Leistung', body: 'Text' }] }],
  ...extra,
});

afterEach(() => jest.restoreAllMocks());

test('without signers the two slots sit exactly where they always were', async () => {
  const { buffer, slots } = await pdfService.renderContractWithSlots(contractContext());
  const pages = (await PDFDocument.load(buffer)).getPageCount();
  expect(slots).toEqual([
    expect.objectContaining({ key: 'customer', role: 'customer', x: L.customerX, y: L.boxY, pageIndex: pages - 1 }),
    expect.objectContaining({ key: 'admin', role: 'issuer', x: L.adminX, y: L.boxY, pageIndex: pages - 1 }),
  ]);
  expect(slots[0]).toEqual(expect.objectContaining({ width: L.boxWidth, height: L.boxHeight, captionY: L.boxY + L.boxHeight + 6 }));
  // The wrapper still returns just the bytes.
  expect(Buffer.isBuffer(await pdfService.renderContractToBuffer(contractContext()))).toBe(true);
});

test('each signer gets a slot, two to a row, the issuer last', async () => {
  const signatureSlots = [
    { key: 'customer-1', role: 'customer', label: 'Auftraggeber', name: 'Anna Muster' },
    { key: 'customer-2', role: 'customer', label: 'Auftraggeber', name: 'Ben Muster' },
    { key: 'customer-3', role: 'customer', label: 'Auftraggeber', name: 'Clara Muster' },
    { key: 'issuer', role: 'issuer', label: 'Auftragnehmer', name: 'Studio Test' },
  ];
  const texts = jest.spyOn(PDFKit.prototype, 'text');
  const { slots } = await pdfService.renderContractWithSlots(contractContext({ signatureSlots }));
  expect(slots.map((s) => [s.key, s.x, s.y])).toEqual([
    ['customer-1', L.customerX, L.boxY],
    ['customer-2', L.adminX, L.boxY],
    ['customer-3', L.customerX, L.boxY + pdfService.SIGNATURE_ROW_HEIGHT],
    ['issuer', L.adminX, L.boxY + pdfService.SIGNATURE_ROW_HEIGHT],
  ]);
  // Invited signers' names are printed under their box.
  expect(texts.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(['Name: Anna Muster', 'Name: Studio Test']));
});

test('no more than six slots fit on the page', async () => {
  const signatureSlots = Array.from({ length: 8 }, (_, i) => ({ key: `s${i}`, role: 'customer', label: `S${i}` }));
  const { slots } = await pdfService.renderContractWithSlots(contractContext({ signatureSlots }));
  expect(slots).toHaveLength(pdfService.MAX_SIGNATURE_SLOTS);
});

test('a slot is stamped from the record: image, captions and a typed name', async () => {
  const { buffer, slots } = await pdfService.renderContractWithSlots(contractContext());
  const slot = { ...slots[0], page: slots[0].pageIndex + 1 };
  const texts = jest.spyOn(PDFKit.prototype, 'text');

  const drawn = await pdfStampService.stampSlot({
    pdfBuffer: buffer, slot, imageBytes: PNG, captions: ['Name: Anna Muster', 'Datum: 14.09.2026, 10:00 (GMT+2)'],
  });
  const stamped = await PDFDocument.load(drawn);
  expect(stamped.getPageCount()).toBe((await PDFDocument.load(buffer)).getPageCount());
  expect(drawn.equals(buffer)).toBe(false);
  expect(texts.mock.calls.map((c) => [c[0], c[1], c[2]])).toEqual(expect.arrayContaining([
    ['Name: Anna Muster', slot.x, slot.captionY],
    ['Datum: 14.09.2026, 10:00 (GMT+2)', slot.x, slot.captionY + 12],
  ]));

  texts.mockClear();
  await pdfStampService.stampSlot({ pdfBuffer: buffer, slot, typedName: 'Anna Muster', captions: ['Name: Anna Muster'] });
  expect(texts.mock.calls.map((c) => c[0])).toContain('Anna Muster');
});

test('a slot that is not in the document is refused, not skipped', async () => {
  const { buffer, slots } = await pdfService.renderContractWithSlots(contractContext());
  await expect(pdfStampService.stampSlot({ pdfBuffer: buffer, slot: { ...slots[0], page: 99 }, captions: ['x'] }))
    .rejects.toThrow(/page 99/);
  await expect(pdfStampService.stampSlot({ pdfBuffer: buffer, slot: { page: 1 }, captions: ['x'] }))
    .rejects.toThrow(/slot\.x/);
});

test('the identifier band is drawn on the signature page', async () => {
  const { buffer, slots } = await pdfService.renderContractWithSlots(contractContext());
  const texts = jest.spyOn(PDFKit.prototype, 'text');
  const out = await pdfStampService.stampBand({ pdfBuffer: buffer, page: slots[0].pageIndex + 1, text: 'Dokument C-2026-0001', y: 700 });
  expect(Buffer.isBuffer(out)).toBe(true);
  expect(texts.mock.calls.map((c) => c[0])).toContain('Dokument C-2026-0001');
});
