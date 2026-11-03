/**
 * The recipient block every quote, invoice and contract shares
 * (_renderContext.buildRecipientBlock). A US business addresses its
 * customers the US way: the customer's state reaches the document, the
 * attention line reads "Attn:", and the window's return-address line ends in
 * "City, ST ZIP". A business elsewhere is addressed exactly as before.
 */

const { buildRecipientBlock } = require('../../src/services/_renderContext');

const usProfile = {
  company_name: 'Example Photo Co.', address_line1: '123 Main St',
  postal_code: '80202', city: 'Denver', state: 'CO', country_code: 'US',
};
const liProfile = {
  company_name: 'Studio Test', address_line1: 'Weg 1', postal_code: '9490', city: 'Vaduz', country_code: 'LI',
};
const customer = {
  company_name: 'Rivera Events LLC', salutation: 'Ms.', first_name: 'Jordan', last_name: 'Rivera',
  address_line1: '1200 Lincoln St', postal_code: '80203', city: 'Denver', state: 'CO', country_code: 'US',
};

test('the customer\'s state reaches the document', () => {
  expect(buildRecipientBlock(usProfile, customer).state).toBe('CO');
});

test('a US business writes the attention line as Attn:', () => {
  expect(buildRecipientBlock(usProfile, customer).attentionLine).toBe('Attn: Ms. Jordan Rivera');
});

test('a business elsewhere keeps z. Hd.', () => {
  expect(buildRecipientBlock(liProfile, customer).attentionLine).toBe('z. Hd. Ms. Jordan Rivera');
});

test('a US business\'s return-address line ends in city, state and ZIP', () => {
  expect(buildRecipientBlock(usProfile, customer).issuerLine)
    .toBe('Example Photo Co. * 123 Main St * Denver, CO 80202');
});

test('a business elsewhere keeps its return-address line', () => {
  expect(buildRecipientBlock(liProfile, customer).issuerLine).toBe('Studio Test * Weg 1 * 9490 Vaduz');
});
