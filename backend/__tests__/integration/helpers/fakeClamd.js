/**
 * A fake clamd for tests (#1444 slice 8). Speaks the INSTREAM framing —
 * "zINSTREAM\0", then 4-byte big-endian lengths and data, a zero length to
 * end — reassembles the bytes and answers the way clamd does: FOUND when the
 * bytes contain the EICAR test string, OK otherwise. Also answers zPING.
 *
 * mode: 'answer' (default), 'silent' (never answers), 'error' (an ERROR
 * line), 'close' (drops the connection).
 */
const net = require('net');

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/** mode: 'answer' (OK / FOUND by content), 'silent', 'error', 'close' */
function fakeClamd(mode = 'answer') {
  const received = [];
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    let command = null;
    const body = [];
    socket.on('data', (data) => {
      buf = Buffer.concat([buf, data]);
      if (command === null) {
        const nul = buf.indexOf(0);
        if (nul === -1) return;
        command = buf.subarray(0, nul).toString();
        buf = buf.subarray(nul + 1);
        if (command === 'zPING') { socket.end('PONG\0'); return; }
      }
      if (mode === 'close') { socket.destroy(); return; }
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (len === 0) {
          const file = Buffer.concat(body);
          received.push(file);
          if (mode === 'silent') return;
          if (mode === 'error') { socket.end('INSTREAM size limit exceeded. ERROR\0'); return; }
          socket.end(file.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE')
            ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
          return;
        }
        if (buf.length < 4 + len) return;
        body.push(buf.subarray(4, 4 + len));
        buf = buf.subarray(4 + len);
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port, received, close: () => new Promise((r) => server.close(r)),
  })));
}

module.exports = { fakeClamd, EICAR };
