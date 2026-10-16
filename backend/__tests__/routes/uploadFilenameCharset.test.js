/**
 * Multipart filenames arrive as raw UTF-8 bytes. multer's default
 * defParamCharset is latin1, which turns `ümläut.jpg` into `Ã¼mlÃ¤ut.jpg`
 * (issue 2072). Every photo/transfer upload instance must opt into utf8.
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const request = require('supertest');

const ROUTE_FILES = [
  'src/routes/adminPhotos.js',
  'src/routes/gallery/uploads.js',
  'src/routes/v1/events.js',
  'src/routes/publicTransferUpload.js',
  'src/routes/adminTransfers.js',
];

describe('upload filename charset (issue 2072)', () => {
  it.each(ROUTE_FILES)('%s builds its multer instance with defParamCharset utf8', (file) => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
    const at = src.search(/=> multer\(\{|return multer\(\{|= multer\(\{/);
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 400)).toMatch(/defParamCharset:\s*'utf8'/);
  });

  it('multer with utf8 keeps the umlauts, the latin1 default does not', async () => {
    const run = async (opts) => {
      const app = express();
      const up = multer({ storage: multer.memoryStorage(), ...opts });
      app.post('/', up.single('photos'), (req, res) => res.json({ name: req.file.originalname }));
      const body = Buffer.concat([
        Buffer.from('--B\r\nContent-Disposition: form-data; name="photos"; filename="'),
        Buffer.from('ümläut.jpg', 'utf8'),
        Buffer.from('"\r\nContent-Type: image/jpeg\r\n\r\nx\r\n--B--\r\n'),
      ]);
      const res = await request(app).post('/')
        .set('Content-Type', 'multipart/form-data; boundary=B').send(body);
      return res.body.name;
    };
    expect(await run({ defParamCharset: 'utf8' })).toBe('ümläut.jpg');
    expect(await run({})).toBe('Ã¼mlÃ¤ut.jpg');
  });
});
