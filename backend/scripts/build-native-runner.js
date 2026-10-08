const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

if (process.platform !== 'linux') {
  process.stdout.write('Native media processing requires Linux. Use the Linux development container.\n');
} else {
  const root = path.join(__dirname, '..');
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  execFileSync(process.env.CC || 'cc', [
    '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-D_FORTIFY_SOURCE=2',
    '-fstack-protector-strong', '-Wl,-z,relro,-z,now',
    path.join(root, 'native/media-process-guard.c'), '-o', path.join(root, 'bin/media-process-guard'),
  ], { stdio: 'inherit' });
  const headers = process.env.NODE_INCLUDE_PATH || [path.resolve(path.dirname(process.execPath), '../include/node'), '/usr/include/node', '/usr/local/include/node']
    .find(directory => fs.existsSync(path.join(directory, 'node_api.h')));
  if (!headers) throw new Error('Node headers are required for Linux media leases; install matching Node development headers or set NODE_INCLUDE_PATH');
  execFileSync(process.env.CC || 'cc', [
    '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-fPIC', '-shared', '-D_FORTIFY_SOURCE=2',
    '-fstack-protector-strong', '-Wl,-z,relro,-z,now', '-I', headers,
    path.join(root, 'native/local-process-lease.c'), '-o', path.join(root, 'bin/local-process-lease.node'),
  ], { stdio: 'inherit' });
}
