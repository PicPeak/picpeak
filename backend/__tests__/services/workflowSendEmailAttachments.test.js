/**
 * The workflow send_email action must not let node config or run vars choose
 * attachment file paths.
 *
 * The mailer reads each attachment's contentPath from disk and sends the file.
 * Node config is written by whoever holds workflows.manage, and run vars can be
 * injected through a test-run payload, so neither may carry attachments. The
 * rest of the author's emailData (template variables) still goes through.
 */
jest.mock('../../src/services/emailProcessor', () => ({
  queueEmail: jest.fn().mockResolvedValue(undefined),
}));

const emailProcessor = require('../../src/services/emailProcessor');
require('../../src/services/workflows/actions');
const registry = require('../../src/services/workflows/registry');

describe('workflow send_email attachments', () => {
  beforeEach(() => emailProcessor.queueEmail.mockClear());

  it('drops attachments from node config and run vars but keeps the other email data', async () => {
    const sendEmail = registry.getAction('send_email');
    await sendEmail({
      node: {
        config: {
          recipientClass: 'admin',
          to: 'someone@example.com',
          emailType: 'workflow_notification',
          emailData: {
            greeting: 'Hello',
            attachments: [{ filename: 'loot.txt', contentPath: '/etc/passwd' }],
          },
        },
      },
      vars: {
        emailData: { attachments: [{ filename: 'loot2.txt', path: '/app/data/db.sqlite' }] },
      },
      run: {},
    });

    expect(emailProcessor.queueEmail).toHaveBeenCalledTimes(1);
    const emailData = emailProcessor.queueEmail.mock.calls[0][3];
    expect(emailData.attachments).toBeUndefined();
    expect(emailData.greeting).toBe('Hello');
  });
});
