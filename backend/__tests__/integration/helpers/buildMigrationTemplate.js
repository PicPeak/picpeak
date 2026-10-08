'use strict';

// Child process for migrationTemplate.js: runs the core migrations into the
// SQLite file named on the command line. A separate process because a few
// migrations require src/database/db themselves, which opens whatever
// TEST_DATABASE_PATH says when it is first loaded.

const fs = require('fs');
const os = require('os');
const path = require('path');

const target = process.argv[2];
process.env.NODE_ENV = 'test';
process.env.DATABASE_CLIENT = 'sqlite3';
process.env.TEST_DATABASE_PATH = target;
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-template-storage-'));

const { db } = require('../../../src/database/db');
const { runCoreMigrations } = require('./crmDb');

runCoreMigrations(db)
  .then(() => db.destroy())
  .then(() => {
    fs.rmSync(process.env.STORAGE_PATH, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
