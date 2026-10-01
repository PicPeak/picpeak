'use strict';

/**
 * Migration 257 — splitting send from request (#1544).
 *
 * The risky half of this migration is what it does to rows that already did
 * both: a live instance may have a transfer holding a client's files AND a
 * download link that client is about to use. Dropping either half would break a
 * link someone is holding, so the migration splits the row in two.
 *
 * The backfill loop is unconditional, so re-running `up()` against a booted
 * (already-migrated) database exercises exactly the code path a real upgrade
 * takes — and doubles as the idempotency check.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';

const { bootCrmDb } = require('./helpers/crmDb');
const migration = require('../../migrations/core/257_transfer_send_request_split');

let db;
let cleanup;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
}, 120000);

afterAll(async () => { if (cleanup) await cleanup(); });

const HOUR = 60 * 60 * 1000;
let seq = 0;

// Timestamps are written as ISO strings rather than Date objects on purpose.
// Under Jest the test file and knex live in different vm realms, so knex's
// `value instanceof Date` check fails and a Date binding is stored as the
// string "[object Object]". That is a harness artifact — plain node stores
// epoch millis correctly — but it would make the assertions below meaningless.
const DOWNLOAD_DEADLINE = new Date(Date.now() + 48 * HOUR).toISOString();
const UPLOAD_DEADLINE = new Date(Date.now() + 12 * HOUR).toISOString();
const NOTIFIED_AT = new Date(Date.now() - 6 * HOUR).toISOString();

// Which insert produced a given row, so a token assertion can name the value
// that row started with.
const seqById = new Map();
const seqOf = (id) => seqById.get(id);

/** Insert a row in the shape a pre-257 release would have written. */
async function insertLegacyRow({ uploadToken, allowUploads = true, withOutbound = false }) {
  seq += 1;
  const [inserted] = await db('transfers').insert({
    token: `tok${seq}`.padEnd(64, '0'),
    kind: 'send', // the column default every legacy row lands on
    title: `legacy ${seq}`,
    expires_at: DOWNLOAD_DEADLINE,
    upload_expires_at: UPLOAD_DEADLINE,
    max_downloads: 5,
    download_count: 0,
    is_active: true,
    // Set so the split's handling of it is observable — see the
    // admin_notified_at assertion below.
    admin_notified_at: NOTIFIED_AT,
    grace_days: 7,
    allow_uploads: allowUploads,
    upload_token: uploadToken,
    delivery_method: 'link',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).returning('id');
  const id = typeof inserted === 'object' && inserted !== null ? inserted.id : inserted;
  seqById.set(id, seq);

  if (withOutbound) {
    // Outbound content via transfer_extra_files — same branch as picked photos,
    // without needing an event/photo fixture for the FK.
    await db('transfer_extra_files').insert({
      transfer_id: id,
      original_filename: 'album.pdf',
      stored_path: `transfers/${id}/files/album.pdf`,
      size_bytes: 10,
      sort_order: 1,
      created_at: new Date().toISOString(),
    });
  }

  await db('transfer_uploads').insert({
    transfer_id: id,
    original_filename: 'client-logo.png',
    stored_path: `uploads/transfers/${id}/client-logo.png`,
    size_bytes: 20,
    mime_type: 'image/png',
    uploaded_at: new Date().toISOString(),
  });

  return id;
}

describe('257: a row that only collected files becomes a request in place', () => {
  let id;

  beforeAll(async () => {
    id = await insertLegacyRow({ uploadToken: 'CODEONLY1', withOutbound: false });
    await migration.up(db);
  });

  it('is reclassified without being duplicated', async () => {
    const rows = await db('transfers').where({ id });
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('request');
  });

  it('mints a FRESH token — the old one was handed out as a download link', async () => {
    const row = await db('transfers').where({ id }).first();
    expect(row.token).toMatch(/^[a-f0-9]{64}$/);
    // Post-257 `token` is the UPLOAD link. Reusing the value that was once a
    // download link would let anyone who was ever sent it upload here.
    expect(row.token).not.toBe(`tok${seqOf(id)}`.padEnd(64, '0'));
    expect(row.token.startsWith('tok')).toBe(false);
    // The short code is the client's actual handle and keeps working.
    expect(row.upload_token).toBe('CODEONLY1');
  });

  it('collapses the two deadlines into expires_at, keeping the UPLOAD one', async () => {
    const row = await db('transfers').where({ id }).first();
    expect(row.upload_expires_at).toBeNull();
    // The deadline that survives is the one that governed uploads, not the
    // download window it used to carry alongside.
    expect(new Date(row.expires_at).toISOString()).toBe(UPLOAD_DEADLINE);
    expect(new Date(row.expires_at).toISOString()).not.toBe(DOWNLOAD_DEADLINE);
  });

  it('drops the meaningless download cap', async () => {
    const row = await db('transfers').where({ id }).first();
    expect(row.max_downloads).toBeNull();
  });

  it('keeps the files it already received', async () => {
    const uploads = await db('transfer_uploads').where({ transfer_id: id });
    expect(uploads).toHaveLength(1);
  });
});

describe('257: a row that did both is split so neither link breaks', () => {
  let sendId;
  let send;
  let request;

  beforeAll(async () => {
    sendId = await insertLegacyRow({ uploadToken: 'BOTHCODE1', withOutbound: true });
    await migration.up(db);
    send = await db('transfers').where({ id: sendId }).first();
    request = await db('transfers')
      .where({ kind: 'request', upload_token: 'BOTHCODE1' })
      .first();
  });

  it('produces a second row rather than dropping half the transfer', () => {
    expect(request).toBeDefined();
    expect(request.id).not.toBe(sendId);
  });

  it('leaves the send downloadable with its original token and files', async () => {
    expect(send.kind).toBe('send');
    expect(send.token).toMatch(/^tok\d+0+$/);
    const extras = await db('transfer_extra_files').where({ transfer_id: sendId });
    expect(extras).toHaveLength(1);
  });

  it('closes the send to uploads and hands the short code to the request', () => {
    // Both halves holding the code would violate the UNIQUE index; the send
    // has to release it before the request row is inserted.
    expect(send.allow_uploads === true || send.allow_uploads === 1).toBe(false);
    expect(send.upload_token).toBeNull();
    expect(request.upload_token).toBe('BOTHCODE1');
  });

  it('gives the request a high-entropy token of its own', () => {
    expect(request.token).toMatch(/^[a-f0-9]{64}$/);
    expect(request.token).not.toBe(send.token);
  });

  it('carries the upload deadline onto the request, not the download one', () => {
    expect(new Date(request.expires_at).toISOString()).toBe(UPLOAD_DEADLINE);
    expect(request.upload_expires_at).toBeNull();
    // The send keeps the window it always had.
    expect(new Date(send.expires_at).toISOString()).toBe(DOWNLOAD_DEADLINE);
  });

  it('carries admin_notified_at, so the split does not re-notify an expiry', async () => {
    // transferCleanupService notifies on
    // (inactive AND disabled_at AND admin_notified_at IS NULL). A null here
    // would send a second "link expired" mail for the same transfer, worded
    // for a send and reporting zero files.
    expect(request.admin_notified_at).toEqual(send.admin_notified_at);
  });

  it('moves the received files to the request', async () => {
    expect(await db('transfer_uploads').where({ transfer_id: sendId })).toHaveLength(0);
    expect(await db('transfer_uploads').where({ transfer_id: request.id })).toHaveLength(1);
  });

  it('is idempotent — re-running does not split the split', async () => {
    const before = await db('transfers').count('* as c').first();
    await migration.up(db);
    const after = await db('transfers').count('* as c').first();
    expect(Number(after.c)).toBe(Number(before.c));
  });
});

describe('257: a row whose upload channel was CLOSED but still holds files', () => {
  // Pre-257 `disableUploads` cleared allow_uploads and the short code but left
  // transfer_uploads in place. Backfilling on allow_uploads alone left those
  // rows as sends — and the detail panel shows received files only on a
  // request, so the client's files had no UI at all and the retention sweep
  // would hard-delete them unseen.
  let closedOnlyId;
  let closedWithOutboundId;

  beforeAll(async () => {
    closedOnlyId = await insertLegacyRow({ uploadToken: null, allowUploads: false, withOutbound: false });
    closedWithOutboundId = await insertLegacyRow({ uploadToken: null, allowUploads: false, withOutbound: true });
    await migration.up(db);
  });

  it('converts a receive-only row even though allow_uploads is false', async () => {
    const row = await db('transfers').where({ id: closedOnlyId }).first();
    expect(row.kind).toBe('request');
    // Converted for visibility, not reopened — the channel stays shut.
    expect(row.allow_uploads === true || row.allow_uploads === 1).toBe(false);
    expect(await db('transfer_uploads').where({ transfer_id: closedOnlyId })).toHaveLength(1);
  });

  it('splits a closed row that also has outbound content, so both halves are reachable', async () => {
    const send = await db('transfers').where({ id: closedWithOutboundId }).first();
    expect(send.kind).toBe('send');
    expect(await db('transfer_extra_files').where({ transfer_id: closedWithOutboundId })).toHaveLength(1);
    expect(await db('transfer_uploads').where({ transfer_id: closedWithOutboundId })).toHaveLength(0);

    const request = await db('transfers')
      .where({ kind: 'request' })
      .whereNot('id', closedWithOutboundId)
      .orderBy('id', 'desc')
      .first();
    expect(await db('transfer_uploads').where({ transfer_id: request.id })).toHaveLength(1);
  });
});

describe('257: down() does not destroy what it did not create', () => {
  it('leaves an admin-edited template alone on rollback', async () => {
    await db('email_templates')
      .where('template_key', 'transfer_request')
      .update({ body_html_en: '<p>Our own wording</p>' });

    await migration.down(db);

    const row = await db('email_templates').where('template_key', 'transfer_request').first();
    expect(row).toBeDefined();
    expect(row.body_html_en).toBe('<p>Our own wording</p>');

    // Put the seeded pair back for the suites that follow.
    await db('email_templates').where('template_key', 'transfer_request').del();
    await migration.up(db);
  });
});

describe('257: settings and templates', () => {
  it('carries the legacy MIME list over with usable extensions', async () => {
    const row = await db('app_settings').where('setting_key', 'transfer_upload_allowed_types').first();
    expect(row).toBeDefined();
    const types = JSON.parse(row.setting_value);
    const zip = types.find((t) => t.mime === 'application/zip');
    // The point of the migration: zip was seeded as allowed but had no
    // extension entry anywhere, so it was rejected on upload.
    expect(zip).toEqual({ mime: 'application/zip', extensions: ['.zip'] });
  });

  it('adds the Windows spelling of ZIP alongside the one 170 seeded', async () => {
    // 170 seeded `application/zip` only. Chrome and Firefox on Windows send
    // `application/x-zip-compressed`, so without this an upgrading instance —
    // which is every instance — still refuses a ZIP from a Windows client
    // whenever the extension cannot carry the match on its own.
    const row = await db('app_settings').where('setting_key', 'transfer_upload_allowed_types').first();
    const types = JSON.parse(row.setting_value);
    expect(types).toEqual(expect.arrayContaining([
      { mime: 'application/zip', extensions: ['.zip'] },
      { mime: 'application/x-zip-compressed', extensions: ['.zip'] },
    ]));
  });

  it('defaults accept-all to off', async () => {
    const row = await db('app_settings').where('setting_key', 'transfer_upload_accept_all').first();
    expect(JSON.parse(row.setting_value)).toBe(false);
  });

  it('leaves the legacy key in place for the fallback read', async () => {
    const row = await db('app_settings').where('setting_key', 'transfer_upload_allowed_mime').first();
    expect(row).toBeDefined();
  });

  it('seeds both new templates in EN and DE', async () => {
    for (const key of ['transfer_request', 'transfer_files_received']) {
      const tpl = await db('email_templates').where('template_key', key).first();
      expect(tpl).toBeDefined();
      expect(tpl.subject_en).toBeTruthy();
      expect(tpl.subject_de).toBeTruthy();
      expect(tpl.body_html_de).toBeTruthy();
    }
  });
});
