'use strict';

// The rsync destination's SSH host key used to be ignored
// (StrictHostKeyChecking=no), so a host answering with another key, on the
// path to an allowed public destination, received the backup. The policy is
// now trust on first use with a known_hosts file the operator controls, and
// that file must be writable, or the first contact records nothing.
const fs = require('fs');
const os = require('os');
const path = require('path');

let service;
let tmp;
beforeAll(() => {
  jest.doMock('../../src/database/db', () => ({ db: jest.fn() }));
  service = require('../../src/services/backupService');
});
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-ssh-')); });
afterEach(() => { delete process.env.BACKUP_SSH_KNOWN_HOSTS; fs.rmSync(tmp, { recursive: true, force: true }); });

test('records the key on first contact in a file next to the configured private key, creating it', () => {
  const key = path.join(tmp, 'ssh', 'backup_ed25519');
  fs.mkdirSync(path.dirname(key));
  expect(service.sshHostKeyOptions(key)).toEqual([
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${path.join(tmp, 'ssh', 'known_hosts')}`,
  ]);
  expect(fs.existsSync(path.join(tmp, 'ssh', 'known_hosts'))).toBe(true);
});

test('an explicit BACKUP_SSH_KNOWN_HOSTS wins over the key directory and its directory is created', () => {
  process.env.BACKUP_SSH_KNOWN_HOSTS = path.join(tmp, 'state', 'known_hosts');
  expect(service.sshHostKeyOptions(path.join(tmp, 'key'))).toEqual([
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${path.join(tmp, 'state', 'known_hosts')}`,
  ]);
  expect(fs.existsSync(path.join(tmp, 'state', 'known_hosts'))).toBe(true);
});

test('a known_hosts path that could break the rsync -e string is refused', () => {
  process.env.BACKUP_SSH_KNOWN_HOSTS = path.join(tmp, 'known hosts');
  expect(() => service.sshHostKeyOptions(path.join(tmp, 'key'))).toThrow(/BACKUP_SSH_KNOWN_HOSTS/);
});

test('a known_hosts file that cannot be written fails plainly instead of silently recording nothing', () => {
  const ro = path.join(tmp, 'secret');
  fs.mkdirSync(ro);
  fs.chmodSync(ro, 0o500);
  try {
    expect(() => service.sshHostKeyOptions(path.join(ro, 'backup_ed25519'))).toThrow(/cannot be written .*BACKUP_SSH_KNOWN_HOSTS/);
  } finally {
    fs.chmodSync(ro, 0o700);
  }
});

test('without a configured key ssh keeps its own known_hosts, still trust-on-first-use', () => {
  expect(service.sshHostKeyOptions(null)).toEqual(['-o', 'StrictHostKeyChecking=accept-new']);
});

test('the rsync ssh command carries the policy with and without a private key', () => {
  const key = path.join(tmp, 'backup_ed25519');
  expect(service.rsyncSshCommand(key)).toEqual(['ssh', '-i', key, '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${path.join(tmp, 'known_hosts')}`]);
  expect(service.rsyncSshCommand(null)).toEqual(['ssh', '-o', 'StrictHostKeyChecking=accept-new']);
  process.env.BACKUP_SSH_KNOWN_HOSTS = path.join(tmp, 'kh');
  // The same file the connection test consults, key or not.
  expect(service.rsyncSshCommand(null)).toContain(`UserKnownHostsFile=${path.join(tmp, 'kh')}`);
});

test('never disables host-key checking', () => {
  for (const key of [path.join(tmp, 'key'), null]) {
    expect(service.sshHostKeyOptions(key).join(' ')).not.toMatch(/StrictHostKeyChecking=no\b/);
  }
});
