#!/usr/bin/env node
/**
 * Generate the OpenAPI spec from JSDoc annotations in src/routes/v1/* and
 * write it as YAML + JSON to ../docs/. Used by scripts/sync-api-docs.sh
 * to keep the picpeak-docs site in lockstep with the running API.
 */

const fs = require('fs');
const path = require('path');

// Need yaml — runtime require so the script fails clearly with an
// install hint instead of an opaque MODULE_NOT_FOUND.
let yaml;
try {
  yaml = require('js-yaml');
} catch {
  console.error('generate-openapi: missing dependency `js-yaml`. Run `npm install --save-dev js-yaml` in /backend.');
  process.exit(2);
}

const { getOpenApiSpec } = require('../src/openapi/spec');

const outDir = path.resolve(__dirname, '../../docs');
fs.mkdirSync(outDir, { recursive: true });

const spec = getOpenApiSpec();
fs.writeFileSync(path.join(outDir, 'openapi.json'), JSON.stringify(spec, null, 2));
fs.writeFileSync(path.join(outDir, 'openapi.yaml'), yaml.dump(spec, { lineWidth: 100 }));

console.log(`Wrote openapi.json + openapi.yaml to ${outDir}`);
