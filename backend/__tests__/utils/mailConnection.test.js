const dns = require('dns').promises;
const net = require('net');
const { EventEmitter } = require('events');
const { mailSocketOptions, smtpConnectionOptions, mailHostRejection } = require('../../src/utils/mailConnection');
const logger = require('../../src/utils/logger');
const isMailHostAllowed = async (...args) => !(await mailHostRejection(...args));
const ENV_KEYS = ['MAIL_PRIVATE_ENDPOINTS', 'SMTP_HOST', 'SMTP_PORT'];
let lookup; let connect; let sockets;
const record = address => ({ address, family: net.isIP(address) });
const invoke = (policy, options = { all: true }, name = policy.host) => new Promise((resolve, reject) => {
  policy.lookup(name, options, (error, ...values) => error ? reject(error) : resolve(values));
});
const open = options => new Promise((resolve, reject) => options.getSocket(options, (error, result) => error ? reject(error) : resolve(result.connection)));
function socket() {
  const result = new EventEmitter();
  result.destroy = jest.fn(() => { result.destroyed = true; return result; });
  sockets.push(result); return result;
}
beforeEach(() => {
  ENV_KEYS.forEach(key => { delete process.env[key]; }); sockets = [];
  lookup = jest.spyOn(dns, 'lookup').mockResolvedValue([record('8.8.8.8')]);
  connect = jest.spyOn(net, 'createConnection').mockImplementation(options => {
    const result = socket();
    process.nextTick(() => {
      if (net.isIP(options.host)) result.emit('connect');
      else options.lookup(options.host, { all: true }, (error, records) => {
        if (result.destroyed) return;
        if (error) result.emit('error', error);
        else { result.approved = records; result.emit('connect'); }
      });
    });
    return result;
  });
});
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); ENV_KEYS.forEach(key => { delete process.env[key]; }); });

test('every connection on one cached SMTP transport resolves afresh and consumes only the vetted answer', async () => {
  lookup.mockResolvedValueOnce([record('8.8.8.8')]).mockResolvedValueOnce([record('127.0.0.1')]);
  const auth = { user: 'mailer', pass: require('crypto').randomBytes(16).toString('hex') };
  const options = smtpConnectionOptions({ host: 'SMTP.example.com.', port: 587, secure: false, auth });
  expect((await open(options)).approved).toEqual([record('8.8.8.8')]);
  await expect(open(options)).rejects.toMatchObject({ code: 'MAIL_HOST_FORBIDDEN' });
  expect(lookup).toHaveBeenCalledTimes(2); expect(sockets[1].destroy).toHaveBeenCalledTimes(1);
  expect(options.tls).toMatchObject({ host: 'smtp.example.com', servername: 'smtp.example.com' });
  expect(options.auth).toEqual(auth);
});
test('keeps all vetted families for native pre-connect fallback and serves both lookup callback shapes', async () => {
  lookup.mockResolvedValue([record('8.8.4.4'), record('2606:4700:4700::1111'), record('8.8.8.8')]);
  const policy = mailSocketOptions('imap', 'imap.example.com', 993);
  expect((await invoke(policy))[0]).toEqual([record('8.8.4.4'), record('2606:4700:4700::1111'), record('8.8.8.8')]);
  expect(await invoke(policy, 6)).toEqual(['2606:4700:4700::1111', 6]);
  const smtp = smtpConnectionOptions({ host: policy.host, port: 465, secure: true, tls: { ca: 'owned CA', rejectUnauthorized: true } });
  await open(smtp); expect(connect.mock.calls[0][0]).toMatchObject({ autoSelectFamily: true });
  expect(smtp.tls).toMatchObject({ ca: 'owned CA', rejectUnauthorized: true, servername: policy.host });
});
test.each(['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.100.100.200', '192.0.2.1', '224.0.0.1',
  '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '64:ff9b::a9fe:a9fe', 'ff02::1', '2001:db8::1'])
('rejects mixed answers containing %s before filtering to the requested family', async address => {
  lookup.mockResolvedValue([record('8.8.8.8'), record(address)]);
  await expect(invoke(mailSocketOptions('imap', 'imap.example.com', 993), { family: 4, all: true })).rejects.toMatchObject({ code: 'MAIL_HOST_FORBIDDEN' });
});
test.each(['127.0.0.1', '[::1]', '::ffff:169.254.169.254', '64:ff9b::a9fe:a9fe'])('refuses private/reserved literal %s without lookup', address => {
  expect(() => mailSocketOptions('imap', address, 993)).toThrow(); expect(lookup).not.toHaveBeenCalled();
});
test.each(['127.1', '2130706433', '0x7f000001', '0177.0.0.1'])('numeric alias %s cannot bypass connection-time DNS classification', async host => {
  lookup.mockResolvedValue([record('127.0.0.1')]);
  await expect(open(smtpConnectionOptions({ host, port: 587 }))).rejects.toMatchObject({ code: 'MAIL_HOST_FORBIDDEN' });
});
test.each(['smtp.example.com/path', 'smtp.example.com@other', 'smtp.example.com?x', 'smtp.example.com#x',
  ' smtp.example.com', 'smtp.example.com\n', 'smtp.example.com\0x', 'smtp.example.com:587', '[8.8.8.8]', 'fe80::1%eth0'])
('rejects unsafe hostname %j instead of URL-parsing/sanitizing it', host => {
  expect(() => smtpConnectionOptions({ host, port: 587 })).toThrow(); expect(lookup).not.toHaveBeenCalled();
});
test('supports public IPv4/IPv6 literals, bracketed IPv6 and IDN identities', async () => {
  for (const host of ['8.8.8.8', '2606:4700:4700::1111', '[2606:4700:4700::1111]']) await open(smtpConnectionOptions({ host, port: 465, secure: true }));
  expect(lookup).not.toHaveBeenCalled();
  expect(mailSocketOptions('imap', 'bücher.example', 993)).toMatchObject({ host: 'xn--bcher-kva.example', servername: 'xn--bcher-kva.example' });
});
test('fails closed on empty/error/invalid DNS, family mismatch and changed lookup name', async () => {
  const policy = mailSocketOptions('imap', 'imap.example.com', 993);
  for (const records of [[], [record('invalid')], [{ address: '8.8.8.8', family: 6 }]]) {
    lookup.mockResolvedValueOnce(records); await expect(invoke(policy)).rejects.toThrow();
  }
  lookup.mockRejectedValueOnce(Object.assign(new Error('DNS failed'), { code: 'ENOTFOUND' }));
  await expect(invoke(policy)).rejects.toMatchObject({ code: 'ENOTFOUND' });
  await expect(invoke(policy, {}, 'changed.example.com')).rejects.toMatchObject({ code: 'MAIL_HOST_FORBIDDEN' });
});
test('only an exact deployment protocol/host/port approval admits private service ranges', async () => {
  process.env.MAIL_PRIVATE_ENDPOINTS = 'smtp://mailhog:1025,imap://inbox.internal:993';
  lookup.mockResolvedValue([record('172.18.0.2')]);
  await expect(open(smtpConnectionOptions({ host: 'mailhog', port: 1025 }))).resolves.toBeDefined();
  expect(await isMailHostAllowed('smtp', 'mailhog', 1025)).toBe(true);
  expect(await isMailHostAllowed('smtp', 'mailhog', 25)).toBe(false);
  expect(await isMailHostAllowed('imap', 'mailhog', 1025)).toBe(false);
  expect(await isMailHostAllowed('smtp', 'other', 1025)).toBe(false);
  lookup.mockResolvedValue([record('169.254.169.254')]);
  expect(await isMailHostAllowed('smtp', 'mailhog', 1025)).toBe(false);
  delete process.env.MAIL_PRIVATE_ENDPOINTS;
  await expect(open(smtpConnectionOptions({ host: '127.0.0.1', port: 1025, private_endpoint_approval: 'smtp://127.0.0.1:1025' }))).rejects.toThrow();
});
// One bad entry used to throw MAIL_CONFIG_INVALID for every connection, public hosts included.
test.each(['http://mailhog:1025', 'smtp://user:pass@mailhog:1025', 'smtp://mailhog:1025/path', 'smtp://mailhog', 'smtp://mailhog:1025?x', 'not a url'])('malformed deployment approval %s approves nothing, is logged once and leaves other mail alone', async value => {
  const error = jest.spyOn(logger, 'error').mockImplementation(() => {});
  process.env.MAIL_PRIVATE_ENDPOINTS = `${value}, imap://inbox.internal:993`;
  for (let i = 0; i < 3; i += 1) expect(mailSocketOptions('imap', 'imap.example.com', 993).host).toBe('imap.example.com');
  await expect(open(smtpConnectionOptions({ host: 'smtp.example.com', port: 587 }))).resolves.toBeDefined();
  lookup.mockResolvedValue([record('172.18.0.2')]);
  expect(await isMailHostAllowed('smtp', 'mailhog', 1025)).toBe(false);
  expect(await isMailHostAllowed('imap', 'inbox.internal', 993)).toBe(true);
  expect(error).toHaveBeenCalledTimes(1);
  expect(error.mock.calls[0][0]).toContain('MAIL_PRIVATE_ENDPOINTS');
  expect(error.mock.calls[0][0]).toContain(value.replace('user:pass@', '***@'));
  expect(error.mock.calls[0][0]).not.toContain('user:pass');
});
test('the memoised approvals follow a changed environment value', async () => {
  lookup.mockResolvedValue([record('172.18.0.2')]);
  process.env.MAIL_PRIVATE_ENDPOINTS = 'smtp://memo-one:25';
  for (let i = 0; i < 3; i += 1) expect(await isMailHostAllowed('smtp', 'memo-one', 25)).toBe(true);
  process.env.MAIL_PRIVATE_ENDPOINTS = 'smtp://memo-two:25';
  expect(await isMailHostAllowed('smtp', 'memo-one', 25)).toBe(false);
  expect(await isMailHostAllowed('smtp', 'memo-two', 25)).toBe(true);
});
test('compose service names with underscores are valid mail hosts and approvals', async () => {
  process.env.MAIL_PRIVATE_ENDPOINTS = 'smtp://Mail_Relay:25';
  lookup.mockResolvedValue([record('172.18.0.3')]);
  expect(mailSocketOptions('smtp', 'mail_relay', 25).host).toBe('mail_relay');
  expect(await isMailHostAllowed('smtp', 'mail_relay', 25)).toBe(true);
  expect(await isMailHostAllowed('smtp', 'mail_relay', 587)).toBe(false);
});
// Upgrade safety: the relay the deployment itself names keeps sending.
test('SMTP_HOST/SMTP_PORT from the deployment environment approve exactly that SMTP endpoint', async () => {
  lookup.mockResolvedValue([record('172.18.0.2')]);
  expect(await isMailHostAllowed('smtp', 'postfix', 25)).toBe(false);
  process.env.SMTP_HOST = 'postfix'; process.env.SMTP_PORT = '25';
  expect(await isMailHostAllowed('smtp', 'postfix', 25)).toBe(true);
  await expect(open(smtpConnectionOptions({ host: 'postfix', port: 25 }))).resolves.toBeDefined();
  expect(await isMailHostAllowed('smtp', 'postfix', 587)).toBe(false);
  expect(await isMailHostAllowed('imap', 'postfix', 25)).toBe(false);
  expect(await isMailHostAllowed('smtp', 'other', 25)).toBe(false);
  lookup.mockResolvedValue([record('169.254.169.254')]);
  expect(await isMailHostAllowed('smtp', 'postfix', 25)).toBe(false);
  // The first migration seeds port 1025 when SMTP_PORT is unset; so does the approval.
  delete process.env.SMTP_PORT; process.env.SMTP_HOST = 'mailhog';
  lookup.mockResolvedValue([record('172.18.0.2')]);
  expect(await isMailHostAllowed('smtp', 'mailhog', 1025)).toBe(true);
  expect(await isMailHostAllowed('smtp', 'mailhog', 25)).toBe(false);
  process.env.SMTP_HOST = 'metadata.google.internal';
  expect(await isMailHostAllowed('smtp', 'metadata.google.internal', 1025)).toBe(false);
});
test.each(['100.64.0.10', '::ffff:100.64.0.10', 'fec0::1'])('an approved endpoint may resolve to %s, an unapproved one may not', async address => {
  lookup.mockResolvedValue([record(address)]);
  expect(await isMailHostAllowed('smtp', 'relay.tailnet.example', 25)).toBe(false);
  process.env.MAIL_PRIVATE_ENDPOINTS = 'smtp://relay.tailnet.example:25';
  expect(await isMailHostAllowed('smtp', 'relay.tailnet.example', 25)).toBe(true);
});
test.each(['100.64.0.10', 'fec0::1'])('private literal %s needs its approval', address => {
  expect(() => mailSocketOptions('smtp', address, 25)).toThrow(expect.objectContaining({ code: 'MAIL_HOST_FORBIDDEN' }));
  process.env.MAIL_PRIVATE_ENDPOINTS = `smtp://${address.includes(':') ? `[${address}]` : address}:25`;
  expect(mailSocketOptions('smtp', address, 25).host).toBe(address);
});
test.each(['0.0.0.0', '255.255.255.255', '224.0.0.1', '169.254.10.10', '100.100.100.200', '::', 'ff02::1', 'fe80::1'])('an approval never admits %s', async address => {
  process.env.MAIL_PRIVATE_ENDPOINTS = 'smtp://relay.internal:25';
  lookup.mockResolvedValue([record(address)]);
  expect(await isMailHostAllowed('smtp', 'relay.internal', 25)).toBe(false);
});
test('an unresolvable name is reported as such, a private or forbidden destination is not told apart', async () => {
  for (const code of ['ENOTFOUND', 'EAI_AGAIN']) {
    lookup.mockRejectedValueOnce(Object.assign(new Error(`getaddrinfo ${code}`), { code }));
    expect(await mailHostRejection('smtp', 'smtp.exmaple.com', 587))
      .toEqual({ code: 'MAIL_HOST_UNRESOLVED', error: 'SMTP host could not be resolved. Check the hostname.' });
  }
  lookup.mockResolvedValueOnce([]);
  expect(await mailHostRejection('imap', 'imap.exmaple.com', 993)).toMatchObject({ code: 'MAIL_HOST_UNRESOLVED', error: expect.stringMatching(/^IMAP host/) });
  const forbidden = { code: 'MAIL_HOST_FORBIDDEN', error: 'SMTP host cannot point to a private or internal network address without deployment approval' };
  for (const address of ['10.0.0.5', '169.254.169.254', '224.0.0.1']) {
    lookup.mockResolvedValueOnce([record(address)]);
    expect(await mailHostRejection('smtp', 'smtp.example.com', 587)).toEqual(forbidden);
  }
  expect(await mailHostRejection('smtp', '10.0.0.5', 587)).toEqual(forbidden);
  expect(await mailHostRejection('smtp', 'smtp.example.com/x', 587)).toEqual(forbidden);
  lookup.mockResolvedValueOnce([record('8.8.8.8')]);
  expect(await mailHostRejection('smtp', 'smtp.example.com', 587)).toBeNull();
});
test('matches exact private IPv6 approvals across equivalent literal spellings without admitting metadata', () => {
  process.env.MAIL_PRIVATE_ENDPOINTS = 'imap://[fd00::1]:993,imap://[fe80::1]:993';
  expect(mailSocketOptions('imap', '[fd00:0:0:0:0:0:0:1]', 993).host).toBe('fd00::1');
  expect(() => mailSocketOptions('imap', 'fe80:0:0:0:0:0:0:1', 993)).toThrow();
  expect(lookup).not.toHaveBeenCalled();
});
test('private approvals never admit IPv6 instance metadata, while other approved ULA mail remains valid', async () => {
  for (const [canonical, expanded] of [['fd00:ec2::254', 'FD00:EC2:0:0:0:0:0:254'], ['fd20:ce::254', 'FD20:CE:0:0:0:0:0:254']]) {
    process.env.MAIL_PRIVATE_ENDPOINTS = `smtp://[${canonical}]:80`;
    for (const host of [canonical, expanded, `[${canonical}]`]) {
      expect(() => mailSocketOptions('smtp', host, 80)).toThrow(/metadata/);
    }
  }
  expect(lookup).not.toHaveBeenCalled();
  process.env.MAIL_PRIVATE_ENDPOINTS = 'smtp://mail.internal:80,imap://mail.internal:993';
  for (const host of ['FD00:EC2:0:0:0:0:0:254', 'FD20:CE:0:0:0:0:0:254']) {
    lookup.mockResolvedValue([record('fd00::1'), record(host)]);
    await expect(open(smtpConnectionOptions({ host: 'mail.internal', port: 80 }))).rejects.toMatchObject({ code: 'MAIL_HOST_FORBIDDEN' });
    await expect(invoke(mailSocketOptions('imap', 'mail.internal', 993))).rejects.toThrow(/metadata/);
  }
  lookup.mockResolvedValue([record('fd00::1')]);
  expect((await open(smtpConnectionOptions({ host: 'mail.internal', port: 80 }))).approved).toEqual([record('fd00::1')]);
});
test('times out and destroys pending SMTP socket exactly once; late events cannot hand it to Nodemailer', async () => {
  jest.useFakeTimers(); connect.mockImplementation(() => socket()); const callback = jest.fn();
  const options = smtpConnectionOptions({ host: 'smtp.example.com', port: 587, connectionTimeout: 25 });
  options.getSocket(options, callback); jest.advanceTimersByTime(26);
  expect(callback).toHaveBeenCalledTimes(1); expect(callback.mock.calls[0][0]).toMatchObject({ code: 'ETIMEDOUT' });
  expect(sockets[0].destroy).toHaveBeenCalledTimes(1); sockets[0].emit('connect'); sockets[0].emit('close');
  expect(callback).toHaveBeenCalledTimes(1); expect(jest.getTimerCount()).toBe(0);
});
test('DNS timeout callbacks once even if resolver subsequently returns', async () => {
  jest.useFakeTimers(); let resolved; lookup.mockReturnValue(new Promise(resolve => { resolved = resolve; }));
  const policy = mailSocketOptions('imap', 'imap.example.com', 993); const callback = jest.fn();
  policy.lookup(policy.host, { all: true }, callback); jest.advanceTimersByTime(30001);
  expect(callback).toHaveBeenCalledTimes(1); resolved([record('8.8.8.8')]); await Promise.resolve(); await Promise.resolve();
  expect(callback).toHaveBeenCalledTimes(1); expect(jest.getTimerCount()).toBe(0);
});
