#!/usr/bin/env node
/**
 * Speaks the media-process-guard protocol (handshake and terminal record on
 * fd 3, start permission on fd 4) without supervising anything, so the
 * runner's reading of that protocol can be tested on any platform.
 * FAKE_GUARD_MODE: run | no-ptrace | supervisor-failed | no-limits
 */
const fs = require('fs');
const { spawnSync } = require('child_process');
const mode = process.env.FAKE_GUARD_MODE || 'run';
const [command, ...args] = process.argv.slice(9);
// What the real guard does when ptrace is denied before anything started.
if (mode === 'no-ptrace') process.exit(125);
const say = value => fs.writeSync(3, `${JSON.stringify(value)}\n`);
say({ version: 1, pid: process.pid, group: process.pid, leaseDevice: '0', leaseInode: '0', leaseFilesystem: '0' });
const permission = Buffer.alloc(1);
for (;;) {
  try { if (fs.readSync(4, permission, 0, 1) === 1) break; process.exit(130); }
  catch (error) { if (error.code !== 'EAGAIN') process.exit(130); }
}
const terminal = { terminal: true, timedOut: false, cancelled: false, threadLimit: false, supervisorFailed: false, executed: false, exitCode: -1, childSignal: 0 };
if (mode === 'supervisor-failed') { say({ ...terminal, supervisorFailed: true }); process.exit(125); }
if (mode === 'no-limits') { say({ ...terminal, exitCode: 125 }); process.exit(125); }
const result = spawnSync(command, args, { stdio: ['ignore', 'inherit', 'inherit'] });
say({ ...terminal, executed: true, exitCode: result.status ?? -1 });
process.exit(result.status ?? 1);
