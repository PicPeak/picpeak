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

  it('takes an apostrophe inside the local part, not a quote around the address', () => {
    expect(redactAddresses('550 <o\'connor@kunde.example> unknown')).toBe('550 <…> unknown');
    expect(redactAddresses('write to \'anna@kunde.example\' today')).toBe('write to \'…\' today');
    expect(redactAddresses('<p title=\'anna@kunde.example\'>')).toBe('<p title=\'…\'>');
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

  it('replaces whole addresses only, never a part of a longer one', () => {
    const html = '<a href="mailto:joann@studio.example">joann@studio.example</a> studio.anna@kunde.example '
      + 'anna@kunde.example.au ann@studio.example, anna@kunde.example.';
    expect(redactKnownAddresses(html, ['ann@studio.example', 'anna@kunde.example', 'joann@studio.example'],
      new Set(['joann@studio.example'])))
      .toBe('<a href="mailto:joann@studio.example">joann@studio.example</a> studio.anna@kunde.example '
        + 'anna@kunde.example.au …, ….');
  });

  it('compares a local part with an apostrophe as a whole address', () => {
    // The customer's address ends in a kept studio address: it still goes.
    expect(redactKnownAddresses('<p>o\'connor@studio.example, connor@studio.example</p>',
      ['o\'connor@studio.example'], new Set(['connor@studio.example'])))
      .toBe('<p>…, connor@studio.example</p>');
    // HTML-escaped as the template engine writes it.
    expect(redactKnownAddresses('<p>o&#39;connor@kunde.example</p>', ['o\'connor@kunde.example'])).toBe('<p>…</p>');
    // A quote around the address is no part of it.
    expect(redactKnownAddresses('<p title=\'anna@kunde.example\'>\'anna@kunde.example\'</p>', ['anna@kunde.example']))
      .toBe('<p title=\'…\'>\'…\'</p>');
    // A kept studio address with an apostrophe stays.
    expect(redactKnownAddresses('<p>o\'brien@studio.example</p>', ['o\'brien@studio.example'],
      new Set(['o\'brien@studio.example']))).toBe('<p>o\'brien@studio.example</p>');
  });

  it('compares a carried value without the prose punctuation after it', () => {
    expect(redactKnownAddresses('<p>Write to help@studio.example.</p>', ['Contact help@studio.example.'],
      new Set(['help@studio.example']))).toBe('<p>Write to help@studio.example.</p>');
    expect(redactKnownAddresses('<p>anna@kunde.example</p>', ['Reply to anna@kunde.example!'])).toBe('<p>…</p>');
  });

  it('never cuts a kept address written with an HTML entity', () => {
    expect(redactKnownAddresses('<p>o&#39;connor@studio.example and connor@studio.example</p>',
      ['connor@studio.example'], new Set(['o\'connor@studio.example'])))
      .toBe('<p>o&#39;connor@studio.example and …</p>');
    expect(redactKnownAddresses('<p>tom&amp;jerry@studio.example</p>', ['jerry@studio.example'],
      new Set(['tom&jerry@studio.example']))).toBe('<p>tom&amp;jerry@studio.example</p>');
    // The other way round: the customer's escaped address ends in a kept one.
    expect(redactKnownAddresses('<p>o&#39;connor@studio.example, connor@studio.example</p>',
      ['o\'connor@studio.example'], new Set(['connor@studio.example'])))
      .toBe('<p>…, connor@studio.example</p>');
  });

  it('takes =, ? and / before an address as delimiters', () => {
    expect(redactKnownAddresses(
      '<a href="mailto:hello@studio.example?cc=anna@kunde.example">x</a><p title=anna@kunde.example>/anna@kunde.example</p>',
      ['anna@kunde.example'], new Set(['hello@studio.example']),
    )).toBe('<a href="mailto:hello@studio.example?cc=…">x</a><p title=…>/…</p>');
  });

  it('leaves the body alone when the mail carries no address', () => {
    expect(redactKnownAddresses('<p>hello@studio.example</p>', [null, { name: 'Anna' }])).toBe('<p>hello@studio.example</p>');
    expect(redactKnownAddresses(null, ['anna@kunde.example'])).toBeNull();
  });
});
