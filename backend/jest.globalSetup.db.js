'use strict';

// globalSetup of the `db` jest project: a per-run directory for the
// migrated SQLite templates (see __tests__/integration/helpers/
// migrationTemplate.js), with the default template built up front so the
// workers don't all race to build it at once. Workers inherit the env var.

const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = async () => {
  if (process.env.DATABASE_CLIENT === 'pg') return;
  const { templateFor, TEMPLATE_DIR_ENV } = require('./__tests__/integration/helpers/migrationTemplate');
  process.env[TEMPLATE_DIR_ENV] = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-test-templates-'));
  await templateFor(process.env);
};
