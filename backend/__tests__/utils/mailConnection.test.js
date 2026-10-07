const dns = require('dns').promises;
const net = require('net');
const { EventEmitter } = require('events');
const { mailSocketOptions, smtpConnectionOptions, isMailHostAllowed } = require('../../src/utils/mailConnection');
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
  delete process.env.MAIL_PRIVATE_ENDPOINTS; sockets = [];
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
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); delete process.env.MAIL_PRIVATE_ENDPOINTS; });

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
test.each(['http://mailhog:1025', 'smtp://user:pass@mailhog:1025', 'smtp://mailhog:1025/path', 'smtp://mailhog', 'smtp://mailhog:1025?x'])
('rejects malformed deployment approval %s', value => {
  process.env.MAIL_PRIVATE_ENDPOINTS = value;
  expect(() => mailSocketOptions('imap', 'imap.example.com', 993)).toThrow();
});
test('matches exact private IPv6 approvals across equivalent literal spellings without admitting metadata', () => {
  process.env.MAIL_PRIVATE_ENDPOINTS = 'imap://[fd00::1]:993,imap://[fe80::1]:993';
  expect(mailSocketOptions('imap', '[fd00:0:0:0:0:0:0:1]', 993).host).toBe('fd00::1');
  expect(() => mailSocketOptions('imap', 'fe80:0:0:0:0:0:0:1', 993)).toThrow();
  expect(lookup).not.toHaveBeenCalled();
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
