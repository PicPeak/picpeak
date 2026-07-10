#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import process from 'node:process';
import { promises as fs } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import https from 'node:https';

const TARGET_NODE_VERSION = '20.19.1';
const env = { ...process.env, ROLLUP_USE_NODE_JS: 'true' };
const viteBin = resolve(process.cwd(), 'node_modules', 'vite', 'bin', 'vite.js');

async function ensureNodeBinary(version) {
  const platformMap = {
    linux: 'linux',
    darwin: 'darwin',
    win32: 'win'
  };
  const archMap = {
    x64: 'x64',
    arm64: 'arm64'
  };

  const platform = platformMap[process.platform];
  const arch = archMap[process.arch];

  if (!platform || !arch) {
    throw new Error(`Unsupported platform/architecture combination: ${process.platform} ${process.arch}`);
  }

  if (platform === 'win') {
    throw new Error('Automatic Node.js download is not supported on Windows runners. Please upgrade Node.js to >=20.19 manually.');
  }

  const cacheDir = join(process.cwd(), 'node_modules', '.cache', `node-v${version}-${platform}-${arch}`);
  const nodeBinary = join(cacheDir, `node-v${version}-${platform}-${arch}`, 'bin', 'node');

  try {
    await fs.access(nodeBinary);
    return nodeBinary;
  } catch {
    // continue with download
  }

  await fs.mkdir(cacheDir, { recursive: true });
  const archiveExt = platform === 'win' ? 'zip' : 'tar.xz';
  const archiveName = `node-v${version}-${platform}-${arch}.${archiveExt}`;
  const archivePath = join(cacheDir, archiveName);
  const downloadUrl = `https://nodejs.org/dist/v${version}/${archiveName}`;

  await downloadFile(downloadUrl, archivePath);

  if (archiveExt === 'tar.xz') {
    execSync(`tar -xf "${archivePath}" -C "${cacheDir}"`, { stdio: 'inherit' });
  } else {
    throw new Error('ZIP extraction not implemented. Please upgrade Node.js manually.');
  }

  await fs.rm(archivePath, { force: true });
  return nodeBinary;
}

async function downloadFile(url, destination) {
  await new Promise((resolvePromise, rejectPromise) => {
    const fileStream = createWriteStream(destination);
    https.get(url, (response) => {
      if (response.statusCode && response.statusCode >= 400) {
        rejectPromise(new Error(`Failed to download ${url}: HTTP ${response.statusCode}`));
        return;
      }
      pipeline(response, fileStream).then(resolvePromise).catch(rejectPromise);
    }).on('error', rejectPromise);
  });
}

async function main() {
  console.log(`Node.js ${process.version} detected; forcing Rollup's JavaScript fallback for compatibility.`);

  if (!process.env.USE_DOWNLOADED_NODE) {
    const [major] = process.versions.node.split('.').map(Number);
    if (major < 20) {
      const nodeBinary = await ensureNodeBinary(TARGET_NODE_VERSION);
      const childEnv = { ...env, USE_DOWNLOADED_NODE: '1' };
      execSync(`"${nodeBinary}" "${viteBin}" build`, { stdio: 'inherit', env: childEnv });
      return;
    }
  }

  execSync(`node "${viteBin}" build`, { stdio: 'inherit', env });
}

await main();
