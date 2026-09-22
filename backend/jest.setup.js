// Supertest 6 binds an IPv6 wildcard listener but hardcodes an IPv4 URL.
// macOS can allocate that IPv6 port while a different IPv4 service owns it.
// Address the listener's actual family so a test cannot reach that service.
jest.mock('supertest/lib/test', () => {
  const Test = jest.requireActual('supertest/lib/test');
  const serverAddress = Test.prototype.serverAddress;
  Test.prototype.serverAddress = function(app, path) {
    const url = serverAddress.call(this, app, path);
    return app.address()?.family === 'IPv6'
      ? url.replace('://127.0.0.1:', '://[::1]:')
      : url;
  };
  return Test;
});

// PDFs render in this process under test, so spies on the renderers (and on
// PDFKit) see the calls; the render worker has its own suite
// (__tests__/services/pdfRenderIsolation.test.js).
if (!process.env.PDF_RENDER_ISOLATION) process.env.PDF_RENDER_ISOLATION = 'off';

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

// Dispose resources loaded by this suite using the application's draining
// shutdown. Individual fixtures still own temporary files and other DB pools.
afterAll(async () => {
  await require('./src/services/serviceShutdown').stopServices();
  const loadedDb = require.cache[require.resolve('./src/database/db')];
  if (typeof loadedDb?.exports.db?.destroy === 'function') await loadedDb.exports.db.destroy();
});
