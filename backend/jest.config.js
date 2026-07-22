module.exports = {
  testEnvironment: 'node',
  // bootCrmDb() runs EVERY core migration in beforeAll; the chain keeps
  // growing (163-165 pushed several suites past jest's default on CI
  // runners — the 3.94 release PR failed on exactly this). 120s matches
  // the convention the newer suites already pin explicitly.
  testTimeout: 120000,
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/**/*.test.js'
  ],
  testMatch: [
    '**/__tests__/**/*.test.js'
  ],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js']
};
