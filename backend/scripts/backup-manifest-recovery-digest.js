#!/usr/bin/env node
'use strict';

// Read-only offline approval helper. Does NOT verify authenticity, restore
// data, read application configuration or create a signing key.
const fs = require('fs');
const yaml = require('js-yaml');
const { recoveryDigest } = require('../src/utils/manifestCanonical');
const file = process.argv[2];
if (!file || process.argv.length !== 3) {
  process.stderr.write('Usage: node scripts/backup-manifest-recovery-digest.js /trusted/staged/manifest.json\n');
  process.exitCode = 1;
} else {
  try {
    if (fs.statSync(file).size > 16 * 1024 * 1024) throw new Error('Manifest exceeds 16 MiB');
    const content = fs.readFileSync(file, 'utf8');
    const manifest = content.trimStart().startsWith('{') ? JSON.parse(content) : yaml.load(content);
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Invalid manifest object');
    process.stderr.write('UNAUTHENTICATED artifact digest only. Inspect and isolate the backup before approving recovery.\n');
    process.stdout.write(recoveryDigest(manifest) + '\n');
  } catch (error) {
    process.stderr.write('Cannot compute recovery approval digest: ' + error.message + '\n');
    process.exitCode = 1;
  }
}
