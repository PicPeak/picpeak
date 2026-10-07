const fs = require('fs');
const os = require('os');
const path = require('path');
const dns = require('dns').promises;
const { execFileSync } = require('child_process');
const { resolveRsyncConnection } = require('../../src/utils/rsyncConnection');

let tmp;
let lookup;
const options = { host: 'backup.example.com', user: 'backup' };
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-ssh-'));
  lookup = jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
});
afterEach(() => {
  lookup.mockRestore();
  delete process.env.BACKUP_SSH_KNOWN_HOSTS;
  fs.rmSync(tmp, { recursive: true, force: true });
});
function trust() {
  const file = path.join(tmp, 'known_hosts');
  fs.writeFileSync(file, 'backup.example.com ssh-ed25519 fixture-only\n');
  return file;
}

test('pins one approved result and the configured host identity; every connection resolves anew', async () => {
  lookup.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
    .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
  const first = await resolveRsyncConnection(options);
  expect(first.sshArgs).toEqual(expect.arrayContaining(['Hostname=8.8.8.8',
    'HostKeyAlias=backup.example.com', 'StrictHostKeyChecking=yes', '/dev/null', 'ProxyCommand=none',
    'ProxyJump=none', 'CanonicalizeHostname=no', 'ControlPath=none', 'VerifyHostKeyDNS=no']));
  await expect(resolveRsyncConnection(options)).rejects.toMatchObject({ code: 'RSYNC_HOST_FORBIDDEN' });
  expect(lookup).toHaveBeenCalledTimes(2);
});

test.each(['127.0.0.1', '169.254.169.254', '10.0.0.1', '100.100.100.200', '192.0.2.1',
  '::1', '::ffff:127.0.0.1', '64:ff9b::a9fe:a9fe', 'fd00:ec2::254', 'ff02::1', '2001:db8::1'])
('rejects private/reserved/multicast record %s, including a mixed answer set', async address => {
  const family = require('net').isIP(address);
  lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address, family }]);
  await expect(resolveRsyncConnection(options)).rejects.toMatchObject({ code: 'RSYNC_HOST_FORBIDDEN' });
});

test.each(['127.1', '2130706433', '0x7f000001'])('rejects noncanonical numeric host %s resolving to loopback', async host => {
  lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
  await expect(resolveRsyncConnection({ host })).rejects.toMatchObject({ code: 'RSYNC_HOST_FORBIDDEN' });
});

test.each(['8.8.8.8;', ' backup.example.com', 'x\n.example.com', '[8.8.8.8]', '-oProxyCommand=x',
  '2606:4700:4700::1111.', '2606:4700:4700::1111%eth0', 'x'.repeat(64) + '.example.com'])
('rejects malformed host %s before DNS', async host => {
  await expect(resolveRsyncConnection({ host })).rejects.toMatchObject({ code: 'RSYNC_CONFIG_INVALID' });
  expect(lookup).not.toHaveBeenCalled();
});

test.each(['backup;', '-o', 'name\n', 123])('rejects malformed user %s', async user => {
  await expect(resolveRsyncConnection({ ...options, user })).rejects.toMatchObject({ code: 'RSYNC_CONFIG_INVALID' });
  expect(lookup).not.toHaveBeenCalled();
});

test('rejects DNS errors/empty answers and never falls back to the unvalidated name', async () => {
  lookup.mockRejectedValueOnce(new Error('DNS failed')).mockResolvedValueOnce([]);
  for (let i = 0; i < 2; i++) {
    await expect(resolveRsyncConnection(options)).rejects.toMatchObject({ code: 'RSYNC_HOST_UNRESOLVED' });
  }
});

test('supports public IPv6-only DNS and bracketed IPv6 literals without rsync ambiguity', async () => {
  const address = '2606:4700:4700::1111';
  lookup.mockResolvedValue([{ address, family: 6 }]);
  const name = await resolveRsyncConnection(options);
  expect(name.sshArgs).toContain(`Hostname=${address}`);
  expect(name.rsyncTarget).toBe('backup@backup.example.com');
  lookup.mockClear();
  const literal = await resolveRsyncConnection({ ...options, host: `[${address}]` });
  expect(literal.rsyncTarget).toBe(`backup@[${address}]`);
  expect(literal.sshArgs).toContain(`HostKeyAlias=${address}`);
  expect(lookup).not.toHaveBeenCalled();
});

test('normalizes DNS identity case/trailing dot without changing the approved address', async () => {
  const result = await resolveRsyncConnection({ host: 'BACKUP.example.com.' });
  expect(result.host).toBe('backup.example.com');
  expect(lookup).toHaveBeenCalledWith('backup.example.com', { all: true });
});

test('retains all approved addresses for pre-connect fallback in a controlled, quoted relay', async () => {
  lookup.mockResolvedValue([{ address: '8.8.4.4', family: 4 }, { address: '8.8.8.8', family: 4 }]);
  const result = await resolveRsyncConnection(options);
  expect(result.addresses).toEqual(['8.8.4.4', '8.8.8.8']);
  const proxy = result.sshArgs.find(arg => arg.startsWith('ProxyCommand='));
  expect(proxy).toContain('rsyncProxy.js'); expect(proxy).toContain("'8.8.4.4' '8.8.8.8'");
  expect(result.rsyncShell).toContain("''8.8.4.4'' ''8.8.8.8''");
});

test('requires a provisioned store next to a configured key; never creates trust', async () => {
  const key = path.join(tmp, 'backup_ed25519');
  fs.writeFileSync(key, 'fixture private key');
  await expect(resolveRsyncConnection({ ...options, sshKey: key })).rejects.toMatchObject({ code: 'RSYNC_SSH_TRUST_REQUIRED' });
  expect(fs.existsSync(path.join(tmp, 'known_hosts'))).toBe(false);
  const file = trust(); fs.chmodSync(file, 0o400);
  const result = await resolveRsyncConnection({ ...options, sshKey: key });
  expect(result.sshArgs).toContain(`UserKnownHostsFile=${file}`);
  expect(result.sshArgs).toContain(key);
  expect(fs.readFileSync(file, 'utf8')).toBe('backup.example.com ssh-ed25519 fixture-only\n');
});

test('an explicit read-only store wins and disables other trust sources', async () => {
  process.env.BACKUP_SSH_KNOWN_HOSTS = trust();
  fs.chmodSync(process.env.BACKUP_SSH_KNOWN_HOSTS, 0o400);
  const result = await resolveRsyncConnection(options);
  expect(result.sshArgs).toContain(`UserKnownHostsFile=${process.env.BACKUP_SSH_KNOWN_HOSTS}`);
  expect(result.sshArgs).toContain('GlobalKnownHostsFile=/dev/null');
  expect(result.sshArgs).not.toContain('-i');
});

test.each(['relative/known_hosts', '/tmp/known hosts', '/tmp/%h', '/tmp/hosts\n-oX'])
('rejects unsafe known_hosts path %s', async value => {
  process.env.BACKUP_SSH_KNOWN_HOSTS = value;
  await expect(resolveRsyncConnection(options)).rejects.toMatchObject({ code: 'RSYNC_CONFIG_INVALID' });
});

test('no-key mode preserves default approved trust/identities without enabling TOFU', async () => {
  const result = await resolveRsyncConnection(options);
  expect(result.sshArgs).toContain('StrictHostKeyChecking=yes');
  expect(result.sshArgs).not.toContain('-i');
  expect(result.sshArgs.some(arg => arg.startsWith('UserKnownHostsFile='))).toBe(false);
});

test('native ssh configuration consumes the literal and original alias with redirects disabled (no socket)', async () => {
  lookup.mockResolvedValue([{ address: '2606:4700:4700::1111', family: 6 }]);
  const result = await resolveRsyncConnection(options);
  const config = execFileSync('ssh', ['-G', ...result.sshArgs, result.target], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  for (const line of ['hostname 2606:4700:4700::1111', 'hostkeyalias backup.example.com',
    'stricthostkeychecking true', 'canonicalizehostname false', 'controlmaster false', 'verifyhostkeydns false']) {
    expect(config).toContain(line + '\n');
  }
  expect(config).not.toMatch(/^proxy(command|jump) (?!none)/m);
});
