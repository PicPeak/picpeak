/**
 * The legacy bootstrap (ADMIN_PASSWORD set, no admin yet) printed the admin
 * password to the console, where container logs keep it, and wrote
 * data/ADMIN_CREDENTIALS.txt with the default mode, readable by every local
 * user under a normal umask.
 */

jest.mock('../../src/database/db', () => ({ initializeDatabase: jest.fn().mockResolvedValue() }));

const fs = require('fs');

const PASSWORD = 'Bootstrap-Only-Pa55word!';

function fakeKnex() {
  const inserted = {};
  const knex = (table) => ({
    // No admin yet; templates and mail config already exist, so only the
    // admin branch runs.
    first: async () => (table === 'admin_users' ? undefined : { id: 1 }),
    insert: async (row) => { inserted[table] = row; return [1]; },
  });
  return { knex, inserted };
}

describe('001_init bootstrap admin credentials', () => {
  let logs;

  beforeEach(() => {
    process.env.ADMIN_PASSWORD = PASSWORD;
    process.env.ADMIN_EMAIL = 'owner@example.com';
    logs = [];
    jest.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')); });
    jest.spyOn(fs.promises, 'mkdir').mockResolvedValue();
    jest.spyOn(fs.promises, 'writeFile').mockResolvedValue();
    jest.spyOn(fs.promises, 'chmod').mockResolvedValue();
  });

  afterEach(() => {
    delete process.env.ADMIN_PASSWORD;
    delete process.env.ADMIN_EMAIL;
    jest.restoreAllMocks();
  });

  it('never prints the admin password', async () => {
    const { knex, inserted } = fakeKnex();

    await require('../../migrations/core/001_init').up(knex);

    expect(inserted.admin_users).toEqual(expect.objectContaining({ email: 'owner@example.com', must_change_password: true }));
    expect(logs.join('\n')).not.toContain(PASSWORD);
  });

  it('writes the credentials file readable by its owner only', async () => {
    const { knex } = fakeKnex();

    await require('../../migrations/core/001_init').up(knex);

    const [file, , options] = fs.promises.writeFile.mock.calls[0];
    expect(file).toMatch(/ADMIN_CREDENTIALS\.txt$/);
    expect(options).toEqual(expect.objectContaining({ mode: 0o600 }));
    // writeFile's mode only applies to a new file; an existing one is tightened too.
    expect(fs.promises.chmod).toHaveBeenCalledWith(file, 0o600);
  });
});
