const fs = require('fs');
const path = require('path');

// Two projects, so the suites that need no database can run on their own
// (`npx jest --selectProjects unit`) and only the DB suites pay for the
// migration template (jest.globalSetup.db.js). A plain `npx jest` runs both
// on the same worker pool.
//
// A suite belongs to `db` when its source touches a real database: the
// bootCrmDb helper, its own migration run, a knex instance, or the Postgres
// test URL. Classified from the file contents at load, so a new suite lands
// in the right project without anyone listing it.
const DB_SUITE = /bootCrmDb|helpers\/crmDb|migrations|TEST_DATABASE_PATH|PICPEAK_PG_TEST_URL|require\(['"]knex['"]\)/;

const unitSuites = [];
const dbSuites = [];
for (const root of ['__tests__', 'src']) {
  for (const entry of fs.readdirSync(path.join(__dirname, root), { recursive: true })) {
    const rel = path.join(root, entry).split(path.sep).join('/');
    if (!rel.endsWith('.test.js') || !rel.includes('__tests__/')) continue;
    const isDb = DB_SUITE.test(fs.readFileSync(path.join(__dirname, rel), 'utf8'));
    (isDb ? dbSuites : unitSuites).push(`**/${rel}`);
  }
}

const shared = {
  testEnvironment: 'node',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  // sanitize-html's htmlparser2 12 is ESM-only; see jest.sanitizeHtml.js.
  moduleNameMapper: {
    '^sanitize-html$': '<rootDir>/jest.sanitizeHtml.js'
  }
};

module.exports = {
  // Some suites still run the whole core migration chain themselves (the
  // migration tests, and bootCrmDb when no template applies); that chain
  // pushed several past jest's default on CI runners — the 3.94 release PR
  // failed on exactly this. 120s matches what the newer suites pin.
  // Global option: jest ignores testTimeout inside a project entry.
  testTimeout: 120000,
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/**/*.test.js'
  ],
  projects: [
    { ...shared, displayName: 'unit', testMatch: unitSuites },
    {
      ...shared,
      displayName: 'db',
      testMatch: dbSuites,
      globalSetup: '<rootDir>/jest.globalSetup.db.js',
      globalTeardown: '<rootDir>/jest.globalTeardown.db.js'
    }
  ]
};
