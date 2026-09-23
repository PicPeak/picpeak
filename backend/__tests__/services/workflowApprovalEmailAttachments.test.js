/**
 * The workflow approval-gate email must not let run vars choose attachment
 * file paths either.
 *
 * createApproval spreads ctx.vars.emailData into the notification email, and a
 * workflow test run fills vars from the request payload. The mailer reads each
 * attachment's contentPath from disk, so attachments are dropped here too.
 */
jest.mock('../../src/database/db', () => {
  const chain = { insert: jest.fn().mockResolvedValue([1]) };
  const db = jest.fn(() => chain);
  db.fn = { now: () => new Date() };
  return { db, logActivity: jest.fn() };
});
jest.mock('../../src/utils/frontendUrl', () => ({
  getFrontendBaseUrl: jest.fn().mockResolvedValue('https://studio.example'),
}));
jest.mock('../../src/services/emailProcessor', () => ({
  queueEmail: jest.fn().mockResolvedValue(undefined),
}));

const emailProcessor = require('../../src/services/emailProcessor');
const { createApproval } = require('../../src/services/workflows/approvals');

describe('workflow approval email attachments', () => {
  it('drops attachments from run vars but keeps the approval links and other data', async () => {
    await createApproval({
      run: { id: 7 },
      node: { node_key: 'gate', config: { prompt: 'Approve?' } },
      vars: {
        adminEmail: 'someone@example.com',
        emailData: {
          note: 'hello',
          attachments: [{ filename: 'loot.txt', contentPath: '/etc/passwd' }],
        },
      },
    });

    expect(emailProcessor.queueEmail).toHaveBeenCalledTimes(1);
    const emailData = emailProcessor.queueEmail.mock.calls[0][3];
    expect(emailData.attachments).toBeUndefined();
    expect(emailData.note).toBe('hello');
    expect(emailData.confirm_url).toMatch(/^https:\/\/studio\.example\/api\/public\/workflow-approvals\/[0-9a-f]{64}\/confirm$/);
  });
});
