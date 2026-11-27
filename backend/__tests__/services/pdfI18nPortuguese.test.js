'use strict';

jest.mock('../../src/database/db', () => ({ db: jest.fn() }));
const { LABELS, t } = require('../../src/services/pdf-i18n');
const { signatureCaptionLabels } = require('../../src/services/contract/signatureAssets');

const placeholders = (s) => (String(s).match(/\{\w+\}/g) || []).sort();

// Portuguese quotes, invoices, contracts and tax reports read in Brazilian
// Portuguese throughout instead of switching to English mid-page (issue 2617).
describe('pdf-i18n pt labels', () => {
  test('has every English label, with the same placeholders', () => {
    const missing = Object.keys(LABELS.en).filter((key) => !LABELS.pt[key]);
    expect(missing).toEqual([]);
    const mismatched = Object.keys(LABELS.en).filter((key) => placeholders(LABELS.en[key]).join() !== placeholders(LABELS.pt[key]).join());
    expect(mismatched).toEqual([]);
  });

  test('labels the signing certificate in Portuguese', () => {
    expect(t('pt', 'cert_title')).toBe('Certificado de assinatura');
    expect(t('pt', 'integrity_mismatch')).toBe('NÃO CONFERE');
  });

  test('captions a stamped signature in the contract language', () => {
    expect(signatureCaptionLabels('pt')).toEqual({ nameLabel: 'Nome', dateLabel: 'Data' });
    expect(signatureCaptionLabels('de')).toEqual({ nameLabel: 'Name', dateLabel: 'Datum' });
    expect(signatureCaptionLabels(undefined)).toEqual({ nameLabel: 'Name', dateLabel: 'Date' });
  });
});
