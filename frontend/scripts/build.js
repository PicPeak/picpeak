#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';

// Vite 7 / Rollup 4 need Node 20+. Earlier versions of this wrapper downloaded a
// Node 20 tarball from nodejs.org and executed it unverified when the host Node
// was older; every supported build path (frontend/Dockerfile, CI, the backend's
// engines field) runs Node 22, so the bootstrap is gone and an old runtime is a
// hard error instead.
const MIN_NODE_MAJOR = 20;
const env = { ...process.env, ROLLUP_USE_NODE_JS: 'true' };
const viteBin = resolve(process.cwd(), 'node_modules', 'vite', 'bin', 'vite.js');

function main() {
  console.log(`Node.js ${process.version} detected; forcing Rollup's JavaScript fallback for compatibility.`);

  const [major] = process.versions.node.split('.').map(Number);
  if (major < MIN_NODE_MAJOR) {
    console.error(
      `Node.js >= ${MIN_NODE_MAJOR} is required to build the frontend (found ${process.version}). ` +
      'Install a supported Node.js (the project uses 22) and run the build again.'
    );
    process.exit(1);
  }

  execSync(`node "${viteBin}" build`, { stdio: 'inherit', env });
}

main();
