/**
 * The older signing path builds its stamps in signatureAssets; the date under
 * each signature follows the document date format it is given (issue 2445),
 * and without one keeps day.month.year as before.
 */

const { buildSignatureStamps } = require('../../src/services/contract/signatureAssets');

const contract = {
  language: 'en',
  signed_customer_signature_path: null, signed_admin_signature_path: null,
};

test('every stamp carries the date format it is given', () => {
  const signed = {
    ...contract,
    signed_customer_signature_path: 'signatures/c.png', signed_customer_name: 'Sam', signed_by_customer_at: '2026-11-09',
    signed_admin_signature_path: 'signatures/a.png', signed_admin_name: 'Alex', signed_by_admin_at: '2026-11-10',
  };
  const stamps = buildSignatureStamps(signed, { dateFormat: { format: 'DD/MM/YYYY' } });
  expect(stamps.map((s) => s.caption.dateFormat)).toEqual([{ format: 'DD/MM/YYYY' }, { format: 'DD/MM/YYYY' }]);
});

test('without one the caption has none, and the stamp keeps day.month.year', () => {
  const signed = { ...contract, signed_customer_signature_path: 'signatures/c.png', signed_by_customer_at: '2026-11-09' };
  expect(buildSignatureStamps(signed)[0].caption.dateFormat).toBeNull();
});
