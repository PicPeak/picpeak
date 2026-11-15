/**
 * The rsync backup destination and its connection test spawn `rsync` and
 * `ssh`. Both runtime images must install them: an operator who adds them
 * through an own image loses them again with the next update.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');

function runtimePackages(file) {
  const lines = fs.readFileSync(path.join(root, file), 'utf8').split('\n');
  // The runtime stage installs dumb-init; the builder stages do not.
  let i = lines.findIndex((line) => line.startsWith('RUN apk add --no-cache dumb-init'));
  expect(i).toBeGreaterThanOrEqual(0);
  const words = [];
  for (; i < lines.length; i += 1) {
    words.push(...lines[i].replace(/\\$/, '').split(/\s+/));
    if (!lines[i].trimEnd().endsWith('\\')) break;
  }
  return words;
}

describe('runtime images carry the rsync destination tools', () => {
  it.each(['Dockerfile', '../Dockerfile.aio'])('%s installs rsync and openssh-client', (file) => {
    const packages = runtimePackages(file);
    expect(packages).toContain('rsync');
    expect(packages).toContain('openssh-client');
  });
});
