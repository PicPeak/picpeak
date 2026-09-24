'use strict';

// The rsync destination's SSH host key used to be ignored
// (StrictHostKeyChecking=no), so a host answering with another key, on the
// path to an allowed public destination, received the backup. The policy is
// now trust on first use with a known_hosts file the operator controls.
const path = require('path');

let service;
beforeAll(() => {
  jest.doMock('../../src/database/db', () => ({ db: jest.fn() }));
  service = require('../../src/services/backupService');
});
afterEach(() => { delete process.env.BACKUP_SSH_KNOWN_HOSTS; });

test('records the key on first contact and keeps it next to the configured private key', () => {
  expect(service.sshHostKeyOptions('/app/data/ssh/backup_ed25519')).toEqual([
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${path.join('/app/data/ssh', 'known_hosts')}`,
  ]);
});

test('an explicit BACKUP_SSH_KNOWN_HOSTS wins over the key directory', () => {
  process.env.BACKUP_SSH_KNOWN_HOSTS = '/var/lib/picpeak/known_hosts';
  expect(service.sshHostKeyOptions('/app/data/ssh/backup_ed25519')).toEqual([
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'UserKnownHostsFile=/var/lib/picpeak/known_hosts',
  ]);
});

test('a known_hosts path that could break the rsync -e string is refused', () => {
  process.env.BACKUP_SSH_KNOWN_HOSTS = '/tmp/known hosts';
  expect(() => service.sshHostKeyOptions('/app/data/ssh/key')).toThrow(/BACKUP_SSH_KNOWN_HOSTS/);
});

test('without a configured key ssh keeps its own known_hosts, still trust-on-first-use', () => {
  expect(service.sshHostKeyOptions(null)).toEqual(['-o', 'StrictHostKeyChecking=accept-new']);
});

test('never disables host-key checking', () => {
  for (const key of ['/app/data/ssh/key', null]) {
    expect(service.sshHostKeyOptions(key).join(' ')).not.toMatch(/StrictHostKeyChecking=no\b/);
  }
});
