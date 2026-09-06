module.exports = {
  testEnvironment: 'node',
  // bootCrmDb() runs EVERY core migration in beforeAll and the chain keeps
  // growing (134 migrations and counting via backports). 120s matches the
  // beta-branch convention from #860.
  testTimeout: 120000,
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/**/*.test.js'
  ],
  testMatch: [
    '**/__tests__/**/*.test.js'
  ],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  // sanitize-html's htmlparser2 12 is ESM-only; see jest.sanitizeHtml.js.
  moduleNameMapper: {
    '^sanitize-html$': '<rootDir>/jest.sanitizeHtml.js'
  }
};
