beforeAll(() => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'test-secret';
  if (!process.env.SKIP_S3_TESTS) {
    process.env.SKIP_S3_TESTS = 'true';
  }
  if (!process.env.STORAGE_PATH) {
    process.env.STORAGE_PATH = '/storage';
  }
});
