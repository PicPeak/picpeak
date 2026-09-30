/**
 * The email subject is interpolated into the HTML <title> of every wrapped
 * message. The body went through escapeHtml; the title did not, and two
 * subject inputs are outsider-controlled: a public contract signer's name
 * reaches "Contract {{contract_number}} declined by {{signer_name}}", and
 * newsletter subjects carry portal-editable customer fields. An unescaped
 * `</title><a href=…>` in there is HTML injection into the admin's inbox
 * (security review 2026-09-29).
 */
const { bootCrmDb } = require('../integration/helpers/crmDb');

describe('wrapEmailHtml — the subject is escaped inside <title>', () => {
  let cleanup; let wrapEmailHtml;

  beforeAll(async () => {
    ({ cleanup } = await bootCrmDb());
    ({ wrapEmailHtml } = require('../../src/services/emailProcessor'));
  }, 120000);
  afterAll(async () => { if (cleanup) await cleanup(); });

  it('neutralises a subject that tries to close the title and inject markup', async () => {
    const subject = 'Contract C-1 declined by </title><a href="https://evil.example">Re-enter your password</a>';
    const html = await wrapEmailHtml('<p>body</p>', subject, 'en');
    expect(html).not.toContain('</title><a href');
    expect(html).toContain('&lt;/title&gt;&lt;a href=&quot;https://evil.example&quot;&gt;');
    // Exactly one title element, and it closes where the template closes it.
    expect(html.match(/<\/title>/g)).toHaveLength(1);
  });

  it('leaves an ordinary subject readable', async () => {
    const html = await wrapEmailHtml('<p>body</p>', 'Your photos are ready', 'en');
    expect(html).toContain('<title>Your photos are ready</title>');
  });
});
