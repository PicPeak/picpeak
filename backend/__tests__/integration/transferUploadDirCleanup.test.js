'use strict';

/**
 * removeUploadedFiles must not delete a sibling transfer's received files (#1544).
 *
 * Migration 257 splits a combined transfer into a send and a request without
 * moving bytes, so the request's `stored_path` values keep pointing inside the
 * SEND's `uploads/transfers/<sendId>/` directory. An unconditional recursive
 * delete on the send — which is what this did before the split existed — would
 * take the request's files with it.
 *
 * The opposite failure matters too: only ever dropping an empty directory
 * leaks, because a `putFromFile` that succeeded before its DB insert failed
 * leaves bytes with no row, which the per-file loop never sees.
 *
 * So the rule is: sweep the prefix when no OTHER transfer references a path
 * under it, and leave it entirely alone when one does. Nothing covered this.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';

const fs = require('fs');
const path = require('path');

const { bootCrmDb } = require('./helpers/crmDb');

let db;
let cleanup;
let transferService;
let storageDir;

const iso = () => new Date().toISOString();
let seq = 0;

async function makeTransfer(kind) {
  seq += 1;
  const [ins] = await db('transfers').insert({
    token: `${seq}`.padStart(64, 'f'),
    kind,
    title: `t${seq}`,
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    is_active: true,
    grace_days: 7,
    allow_uploads: kind === 'request',
    created_at: iso(),
    updated_at: iso(),
  }).returning('id');
  return typeof ins === 'object' && ins !== null ? ins.id : ins;
}

/** Write a real file under `uploads/transfers/<dirOwner>/` and row it to `rowOwner`. */
async function putUpload(dirOwner, rowOwner, name) {
  const key = path.posix.join('uploads/transfers', String(dirOwner), name);
  const abs = path.join(storageDir, key);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'bytes');
  await db('transfer_uploads').insert({
    transfer_id: rowOwner,
    original_filename: name.replace('.bin', '.png'),
    stored_path: key,
    size_bytes: 5,
    mime_type: 'image/png',
    uploaded_at: iso(),
  });
  return abs;
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  storageDir = process.env.STORAGE_PATH;
  transferService = require('../../src/services/transferService');
}, 120000);

afterAll(async () => { if (cleanup) await cleanup(); });

describe('removeUploadedFiles', () => {
  it('leaves the directory alone when another transfer still has files in it', async () => {
    // Exactly the post-split shape: the request's bytes live under the send's
    // directory, because 257 moves the rows and not the files.
    const sendId = await makeTransfer('send');
    const requestId = await makeTransfer('request');
    const sendFile = await putUpload(sendId, sendId, 'aaaa.bin');
    const requestFile = await putUpload(sendId, requestId, 'bbbb.bin');

    await transferService.removeUploadedFiles(sendId);

    // The send's own file is gone; the sibling's survives, directory and all.
    expect(fs.existsSync(sendFile)).toBe(false);
    expect(fs.existsSync(requestFile)).toBe(true);
    expect(fs.existsSync(path.dirname(requestFile))).toBe(true);
  });

  it('sweeps orphan bytes that have no row once nothing else references the prefix', async () => {
    const id = await makeTransfer('request');
    const rowed = await putUpload(id, id, 'cccc.bin');

    // A file written by a putFromFile whose DB insert then failed: bytes on
    // disk, no transfer_uploads row, so the per-file loop cannot see it.
    const orphan = path.join(storageDir, 'uploads/transfers', String(id), 'orphan.bin');
    fs.writeFileSync(orphan, 'bytes');

    await transferService.removeUploadedFiles(id);

    expect(fs.existsSync(rowed)).toBe(false);
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(path.dirname(orphan))).toBe(false);
  });

  it('does not touch a different transfer\'s directory', async () => {
    const a = await makeTransfer('request');
    const b = await makeTransfer('request');
    const fileA = await putUpload(a, a, 'dddd.bin');
    const fileB = await putUpload(b, b, 'eeee.bin');

    await transferService.removeUploadedFiles(a);

    expect(fs.existsSync(fileA)).toBe(false);
    expect(fs.existsSync(fileB)).toBe(true);
  });

  it('is safe on a transfer that never received anything', async () => {
    const id = await makeTransfer('request');
    await expect(transferService.removeUploadedFiles(id)).resolves.not.toThrow();
  });
});
