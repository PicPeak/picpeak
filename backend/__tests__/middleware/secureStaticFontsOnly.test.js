/**
 * STORAGE_PATH/fonts is admin-writable and a restored backup can populate it,
 * and /fonts is served unauthenticated from the app origin. Without a type
 * allowlist an HTML page planted there could load a planted same-origin
 * script under the frontend's `script-src 'self'`. The mount serves font
 * formats only, with nosniff. Scanner finding 8265db38.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');

jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const secureStatic = require('../../src/middleware/secureStatic');
const { isPublicFontFile } = secureStatic;

describe('/fonts serves font formats only', () => {
  let dir;
  let app;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-fonts-'));
    fs.mkdirSync(path.join(dir, 'Inter'));
    fs.writeFileSync(path.join(dir, 'Inter', '400.woff2'), Buffer.from('wOF2'));
    fs.writeFileSync(path.join(dir, 'Inter', 'Regular.TTF'), Buffer.from([0, 1, 0, 0]));
    fs.writeFileSync(path.join(dir, 'payload.html'), '<script src="/fonts/payload.js"></script>');
    fs.writeFileSync(path.join(dir, 'payload.js'), 'document.cookie');
    fs.writeFileSync(path.join(dir, 'meta.json'), '{"generic":"sans-serif"}');
    fs.writeFileSync(path.join(dir, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');

    // Same options server.js hands the two /fonts mounts.
    const fontStaticOpts = {
      maxAge: '7d',
      onlyServe: isPublicFontFile,
      setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
    };
    app = express();
    app.use('/fonts', secureStatic(dir, fontStaticOpts));
  });

  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it.each(['Inter/400.woff2', 'Inter/Regular.TTF'])('serves %s with nosniff', async (file) => {
    const res = await request(app).get(`/fonts/${file}`);
    expect(res.status).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toMatch(/max-age=604800/);
  });

  it.each(['payload.html', 'payload.js', 'meta.json', 'logo.svg'])('refuses %s even though it is on disk', async (file) => {
    const res = await request(app).get(`/fonts/${file}`);
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('document.cookie');
  });

  it('isPublicFontFile accepts exactly the font extensions, case-insensitively', () => {
    for (const ok of ['a.woff', 'a.woff2', 'a.ttf', 'a.otf', 'a.eot', 'Inter/400.WOFF2']) expect(isPublicFontFile(ok)).toBe(true);
    for (const bad of ['a.html', 'a.js', 'a.svg', 'a.json', 'a.css', 'a', '', undefined]) expect(isPublicFontFile(bad)).toBe(false);
  });

  it('server.js wires both /fonts mounts through the font allowlist', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../server.js'), 'utf8');
    expect(src).toMatch(/onlyServe:\s*isPublicFontFile/);
    expect(src).toMatch(/X-Content-Type-Options',\s*'nosniff'/);
    const mounts = src.match(/app\.use\(\s*'\/fonts',\s*setCorsHeaders,\s*secureStatic\([^)]*\),\s*fontStaticOpts\)/g) || [];
    expect(mounts).toHaveLength(2);
  });
});
