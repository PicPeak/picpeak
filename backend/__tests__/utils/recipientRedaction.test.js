/**
 * redactAddresses blanks address-shaped text for admins without
 * customers.view. A quoted local part ("anna meier"@kunde.example) is a valid
 * address the app accepts, so it must not survive either.
 */
const { redactAddresses, redactKnownAddresses } = require('../../src/utils/recipientRedaction');

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

describe('redactKnownAddresses', () => {
  it('replaces the carried addresses in any case and HTML-escaped, and nothing else', () => {
    const html = '<p>ANNA@Kunde.Example and &quot;a b&quot;@x.example</p><a href="mailto:hello@studio.example">hello@studio.example</a>';
    expect(redactKnownAddresses(html, ['Anna <anna@kunde.example>', { cc: ['"a b"@x.example'], n: 1 }]))
      .toBe('<p>… and …</p><a href="mailto:hello@studio.example">hello@studio.example</a>');
  });

  it('replaces a longer address before one it contains', () => {
    expect(redactKnownAddresses('mail jo@x.example and anna.jo@x.example', ['jo@x.example', 'anna.jo@x.example']))
      .toBe('mail … and …');
  });

  it('keeps the addresses it is told to keep, in any case', () => {
    expect(redactKnownAddresses('<p>help@Studio.example, anna@kunde.example</p>',
      ['anna@kunde.example', 'HELP@studio.example'], new Set(['help@studio.example'])))
      .toBe('<p>help@Studio.example, …</p>');
  });

  it('leaves the body alone when the mail carries no address', () => {
    expect(redactKnownAddresses('<p>hello@studio.example</p>', [null, { name: 'Anna' }])).toBe('<p>hello@studio.example</p>');
    expect(redactKnownAddresses(null, ['anna@kunde.example'])).toBeNull();
  });
});
