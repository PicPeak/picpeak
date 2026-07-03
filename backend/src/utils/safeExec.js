const { spawn } = require('child_process');

/**
 * Safe command execution utilities using spawn (shell: false).
 * These prevent command injection by never invoking a shell interpreter.
 */

/**
 * Run a command with arguments, returning { stdout, stderr }.
 * Equivalent to execAsync(cmd) but safe from injection.
 */
function spawnAsync(cmd, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      shell: false,
      ...options,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const stdoutChunks = [];
    const stderrChunks = [];

    child.stdout.on('data', chunk => stdoutChunks.push(chunk));
    child.stderr.on('data', chunk => stderrChunks.push(chunk));

    child.on('error', reject);
    child.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString();
      const stderr = Buffer.concat(stderrChunks).toString();
      if (code !== 0) {
        const err = new Error(`${cmd} exited with code ${code}: ${stderr}`);
        err.code = code;
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Run a command and redirect stdout to a file (replaces shell `> file`).
 *
 * Historically this passed `fs.createWriteStream(outputPath)` directly as
 * `stdio[1]` to `child_process.spawn`. That relied on Node auto-extracting
 * the WriteStream's `.fd` — but the stream opens async, so on a fast call
 * `fd` is still `null` when `spawn()` reads it. Older Node releases would
 * tolerate this; Node 22 throws synchronously with
 * `The argument 'stdio' is invalid. Received WriteStream { fd: null, ... }`.
 *
 * Cure: use `stdio: ['ignore', 'pipe', 'pipe']` and wire the WriteStream
 * up via the streams API (`stdout.pipe(outStream)`). Works on every Node
 * version; also gives us a clean error bridge from both the WriteStream
 * AND the child process to the promise, instead of the previous code's
 * blind `outStream.destroy()` / `outStream.end()` calls that left stream
 * errors uncaught (Node 22 process-fatal — separate footgun this fixes
 * by the same change).
 *
 * Used by:
 *   - databaseBackup.createPostgreSQLBackup (inline-dump path, the
 *     thing that just bit Ralf's install)
 *   - restoreService pre-restore safety snapshot (would have hit the
 *     same on next restore attempt)
 */
function spawnToFile(cmd, args, outputPath, options = {}) {
  const fs = require('fs');
  return new Promise((resolve, reject) => {
    const outStream = fs.createWriteStream(outputPath);
    let settled = false;
    const settleReject = (err) => {
      if (settled) return;
      settled = true;
      try { outStream.destroy(); } catch (_) { /* best effort */ }
      reject(err);
    };
    const settleResolve = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    // Bridge WriteStream errors (EACCES, ENOSPC, etc.) to the promise.
    // Without this, an unhandled 'error' event on the stream is process-
    // fatal on Node 22 and bypasses the caller's try/catch entirely —
    // which is exactly the failure mode that crashed the picpeak
    // backend container on its first inline-dump attempt.
    outStream.on('error', settleReject);

    const child = spawn(cmd, args, {
      shell: false,
      ...options,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    // Pipe stdout → file. The pipe call attaches its own 'error'
    // handlers on both ends so a child-stdout failure also reaches us.
    child.stdout.pipe(outStream);

    const stderrChunks = [];
    child.stderr.on('data', chunk => stderrChunks.push(chunk));
    child.stderr.on('error', settleReject);

    child.on('error', settleReject);
    child.on('close', (code) => {
      // Wait for the file write to flush before resolving — otherwise
      // a fast 'close' could resolve while the WriteStream still has
      // buffered bytes, producing a truncated dump.
      outStream.end(() => {
        const stderr = Buffer.concat(stderrChunks).toString();
        if (code !== 0) {
          const err = new Error(`${cmd} exited with code ${code}: ${stderr}`);
          err.code = code;
          err.stderr = stderr;
          return settleReject(err);
        }
        settleResolve({ stderr });
      });
    });
  });
}

/**
 * Run a command and pipe a file into stdin (replaces shell `< file`).
 *
 * Same Node 22 stdio strictness applies as for `spawnToFile` above — the
 * ReadStream `fd` is null at spawn time. Use `stdio[0] = 'pipe'` and pipe
 * the file stream into `child.stdin` via the streams API instead.
 */
function spawnFromFile(cmd, args, inputPath, options = {}) {
  const fs = require('fs');
  return new Promise((resolve, reject) => {
    const inStream = fs.createReadStream(inputPath);
    let settled = false;
    const settleReject = (err) => {
      if (settled) return;
      settled = true;
      try { inStream.destroy(); } catch (_) { /* best effort */ }
      reject(err);
    };
    const settleResolve = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    inStream.on('error', settleReject);

    const child = spawn(cmd, args, {
      shell: false,
      ...options,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    inStream.pipe(child.stdin);

    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on('data', chunk => stdoutChunks.push(chunk));
    child.stdout.on('error', settleReject);
    child.stderr.on('data', chunk => stderrChunks.push(chunk));
    child.stderr.on('error', settleReject);
    child.stdin.on('error', settleReject);

    child.on('error', settleReject);
    child.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString();
      const stderr = Buffer.concat(stderrChunks).toString();
      if (code !== 0) {
        const err = new Error(`${cmd} exited with code ${code}: ${stderr}`);
        err.code = code;
        err.stdout = stdout;
        err.stderr = stderr;
        return settleReject(err);
      }
      settleResolve({ stdout, stderr });
    });
  });
}

module.exports = { spawnAsync, spawnToFile, spawnFromFile };
