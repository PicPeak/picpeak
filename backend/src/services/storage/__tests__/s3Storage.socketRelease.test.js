/**
 * Abandoning a downloadStream() body must give its socket back.
 *
 * Runs the REAL @aws-sdk/client-s3 against a local fake S3 endpoint (no
 * network, no credentials). The fake sends the first chunk of an object
 * with an x-amz-checksum-crc32 header and then holds the rest, like a large
 * original that a cancelled zip build stopped reading halfway.
 *
 * With the SDK default (responseChecksumValidation WHEN_SUPPORTED) the Body
 * is a ChecksumStream that pipes the real response into itself and has no
 * _destroy: destroying it unpipes and pauses the response but never closes
 * it, so the connection stays checked out of the 50-socket pool forever.
 * socketTimeout does not catch it either: the handler clears that timer
 * once response headers arrive. Enough of these and every S3 call queues
 * behind a full pool, which is how long upload runs hung. Fixed upstream
 * in @smithy/core 3.27.0 (smithy-typescript #2099).
 */
const http = require('http');
const zlib = require('zlib');
const S3StorageAdapter = require('../s3Storage');

jest.unmock('@aws-sdk/client-s3');

const CHUNK = Buffer.alloc(64 * 1024, 7);
const FULL = Buffer.concat([CHUNK, Buffer.alloc(4 * 1024 * 1024, 9)]);

describe('S3StorageAdapter.downloadStream socket release', () => {
  let server;
  let port;
  const open = new Set();

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.method !== 'GET') { res.writeHead(400); res.end(); return; }
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(zlib.crc32(FULL) >>> 0);
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': FULL.length,
        ETag: '"fake"',
        'x-amz-checksum-crc32': crc.toString('base64'),
      });
      res.write(CHUNK); // ...and never the rest
    });
    server.on('connection', (socket) => {
      open.add(socket);
      socket.on('close', () => open.delete(socket));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  afterAll(async () => {
    for (const socket of open) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });

  it('closes the connection when a half-read body is destroyed', async () => {
    const adapter = new S3StorageAdapter({
      bucket: 'photos',
      endpoint: `http://127.0.0.1:${port}`,
      region: 'us-east-1',
      accessKeyId: 'test',
      secretAccessKey: 'test',
    });

    const body = await adapter.downloadStream('events/active/a/original.jpg');
    await new Promise((resolve) => body.once('data', resolve));
    expect(open.size).toBe(1);

    body.destroy();
    const deadline = Date.now() + 3000;
    while (open.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(open.size).toBe(0);
    adapter.s3Client.destroy();
  });
});
