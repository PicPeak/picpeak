const { isValidUkVatNumber } = require('../../src/utils/ukVatNumber');
const { isBusinessCustomer } = require('../../src/utils/customerKind');

describe('isValidUkVatNumber', () => {
  it('accepts a number whose check digits fit the old series (mod 97)', () => {
    expect(isValidUkVatNumber('GB999999973')).toBe(true);
    expect(isValidUkVatNumber('123456782')).toBe(true);
  });

  it('accepts the series issued since 2010 (mod 97 after adding 55)', () => {
    expect(isValidUkVatNumber('GB123456727')).toBe(true);
  });

  it('accepts the usual ways of writing it', () => {
    expect(isValidUkVatNumber('GB 999 9999 73')).toBe(true);
    expect(isValidUkVatNumber('gb999999973')).toBe(true);
    expect(isValidUkVatNumber('GB999999973001')).toBe(true); // branch trader
    expect(isValidUkVatNumber('XI999999973')).toBe(true); // Northern Ireland
  });

  it('accepts government departments and health authorities', () => {
    expect(isValidUkVatNumber('GBGD001')).toBe(true);
    expect(isValidUkVatNumber('GBHA599')).toBe(true);
    expect(isValidUkVatNumber('GBGD599')).toBe(false);
  });

  it('rejects a typo, a wrong length and a foreign number', () => {
    expect(isValidUkVatNumber('GB999999974')).toBe(false);
    expect(isValidUkVatNumber('GB99999997')).toBe(false);
    expect(isValidUkVatNumber('DE123456789')).toBe(false);
    expect(isValidUkVatNumber('')).toBe(false);
  });

  it('rejects all zeros, which passes the check sum but is no number', () => {
    expect(isValidUkVatNumber('GB000000000')).toBe(false);
    expect(isValidUkVatNumber('GB000000000001')).toBe(false);
  });
});

describe('isBusinessCustomer', () => {
  it('follows the kind the admin set', () => {
    expect(isBusinessCustomer({ customer_kind: 'business' })).toBe(true);
    expect(isBusinessCustomer({ customer_kind: 'consumer', company_name: 'Band Ltd' })).toBe(false);
  });

  it('decides from company name or VAT ID when left on automatic', () => {
    expect(isBusinessCustomer({ customer_kind: null, company_name: 'Band Ltd' })).toBe(true);
    expect(isBusinessCustomer({ customer_kind: null, vat_id: 'GB999999973' })).toBe(true);
    expect(isBusinessCustomer({ customer_kind: null, company_name: '  ', vat_id: null })).toBe(false);
    expect(isBusinessCustomer(null)).toBe(false);
  });
});
