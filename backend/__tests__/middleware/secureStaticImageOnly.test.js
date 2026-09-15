/**
 * /uploads/logos and /uploads/favicons only ever hold uploaded images, but
 * older upload routes kept the client's file extension, so a `.html` or `.js`
 * file can still be on disk from before. Served from the app origin it would
 * run as a page or script. The two mounts refuse anything that is not an
 * image; other secureStatic trees (fonts) are unaffected.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');

jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const secureStatic = require('../../src/middleware/secureStatic');
const { isPublicUploadImage } = require('../../src/utils/safePath');

describe('secureStatic onlyServe for the public upload trees', () => {
  let dir;
  let app;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-logos-'));
    fs.writeFileSync(path.join(dir, 'pdf-logo-1700000000000.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47]));
    fs.writeFileSync(path.join(dir, 'pdf-logo-1700000000001.html'), '<script>alert(1)</script>');
    fs.writeFileSync(path.join(dir, 'pdf-logo-1700000000002.js'), 'alert(1)');
    fs.writeFileSync(path.join(dir, 'logo-1.JPG'), Buffer.from([0xFF, 0xD8, 0xFF]));
    fs.writeFileSync(path.join(dir, 'favicon-1.ico'), Buffer.from([0, 0, 1, 0]));
    fs.writeFileSync(path.join(dir, 'logo-2.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');

    app = express();
    app.use('/uploads/logos', secureStatic(dir, { onlyServe: isPublicUploadImage }));
    app.use('/unrestricted', secureStatic(dir));
  });

  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it.each([
    'pdf-logo-1700000000000.png',
    'logo-1.JPG',
    'favicon-1.ico',
    'logo-2.svg',
  ])('serves the image %s', async (name) => {
    const res = await request(app).get(`/uploads/logos/${name}`);
    expect(res.status).toBe(200);
  });

  it('keeps the SVG script lock on served SVGs', async () => {
    const res = await request(app).get('/uploads/logos/logo-2.svg');
    expect(res.headers['content-security-policy']).toMatch(/default-src 'none'/);
  });

  it.each([
    'pdf-logo-1700000000001.html',
    'pdf-logo-1700000000002.js',
  ])('does not serve the non-image %s left on disk', async (name) => {
    const res = await request(app).get(`/uploads/logos/${name}`);
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('alert(1)');
  });

  it('leaves trees without onlyServe as they were', async () => {
    const res = await request(app).get('/unrestricted/pdf-logo-1700000000002.js');
    expect(res.status).toBe(200);
  });
});
