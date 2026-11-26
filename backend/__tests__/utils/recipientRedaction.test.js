/**
 * redactAddresses blanks address-shaped text for admins without
 * customers.view. A quoted local part ("anna meier"@kunde.example) is a valid
 * address the app accepts, so it must not survive either.
 */
const { redactAddresses } = require('../../src/utils/recipientRedaction');

describe('redactAddresses', () => {
  it('blanks plain and quoted addresses inside free text', () => {
    expect(redactAddresses('550 5.1.1 <anna@kunde.example>: mailbox unavailable'))
      .toBe('550 5.1.1 <…>: mailbox unavailable');
    expect(redactAddresses('550 <"anna meier"@kunde.example> unknown')).toBe('550 <…> unknown');
    expect(redactAddresses('"anna"@kunde.example')).toBe('…');
  });

  it('walks objects and arrays and leaves other values alone', () => {
    expect(redactAddresses({ to: ['"a b"@x.example', 'c@y.example'], n: 3, ok: true, none: null }))
      .toEqual({ to: ['…', '…'], n: 3, ok: true, none: null });
    expect(redactAddresses('no address here')).toBe('no address here');
  });
});
