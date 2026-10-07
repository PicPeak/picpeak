const net = require('net');
const { PassThrough } = require('stream');
const { isPublicAddress } = require('./rsyncConnection');

/** Try only approved literal TCP destinations, and only before connection. */
function connectApprovedAddresses(addresses, { signal, timeoutMs = 10000 } = {}) {
  if (!Array.isArray(addresses) || !addresses.length || !addresses.every(isPublicAddress)) {
    return Promise.reject(new Error('The SSH relay requires only public IP literals'));
  }
  return new Promise((resolve, reject) => {
    let index = 0; let current; let timer; let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      current?.destroy(); reject(error);
    };
    const abort = () => finish(new Error('SSH relay cancelled'));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    const next = () => {
      if (settled) return;
      if (index === addresses.length) { finish(new Error('No vetted SSH destination could be reached')); return; }
      const address = addresses[index++];
      let attemptDone = false;
      try {
        current = net.createConnection({ host: address, port: 22, family: net.isIP(address),
          lookup: (_host, _options, callback) => callback(new Error('DNS is forbidden in the SSH relay')) });
      } catch { next(); return; }
      const socket = current;
      const failed = () => {
        if (attemptDone || settled) return;
        attemptDone = true; clearTimeout(timer); socket.destroy(); next();
      };
      socket.once('error', failed);
      socket.once('connect', () => {
        if (attemptDone || settled) return;
        attemptDone = true; settled = true; clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        resolve(socket);
      });
      timer = setTimeout(failed, timeoutMs);
    };
    next();
  });
}

async function runProxy(addresses) {
  const controller = new AbortController();
  // Buffer SSH's initial banner with backpressure until the socket connects;
  // also consume EOF so a cancelled parent cannot leave a pending relay alive.
  const input = new PassThrough({ highWaterMark: 64 * 1024 });
  let socket;
  const cancel = () => { controller.abort(); socket?.destroy(); input.destroy(); process.stdin.destroy(); };
  const failure = error => {
    process.stderr.write(`SSH relay failed: ${error.message}\n`);
    process.exitCode = 1; cancel();
  };
  process.once('SIGTERM', cancel); process.once('SIGINT', cancel);
  process.stdin.once('error', failure); process.stdout.once('error', failure);
  process.stdin.once('end', () => { if (!socket) controller.abort(); });
  process.stdin.pipe(input);
  try {
    socket = await connectApprovedAddresses(addresses, { signal: controller.signal });
    socket.once('error', failure);
    socket.once('close', () => { input.destroy(); process.stdin.destroy(); });
    input.pipe(socket); socket.pipe(process.stdout);
  } catch (error) { failure(error); }
}

if (require.main === module) runProxy(process.argv.slice(2));
module.exports = { connectApprovedAddresses };
