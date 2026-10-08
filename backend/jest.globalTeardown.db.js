'use strict';

const fs = require('fs');
const { TEMPLATE_DIR_ENV } = require('./__tests__/integration/helpers/migrationTemplate');

module.exports = async () => {
  const dir = process.env[TEMPLATE_DIR_ENV];
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
};
