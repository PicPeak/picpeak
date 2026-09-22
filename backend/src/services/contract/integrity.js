'use strict';

/**
 * The integrity report (#1446): every artefact of a contract re-read and
 * re-hashed, each against the value recorded when it was made, in one list.
 *
 * Each check is `{ check, subject, ok, expected, actual, note }`:
 *   unsigned_pdf      the sent PDF              ↔ contracts.pdf_sha256
 *   signed_pdf        the signed PDF            ↔ contracts.signed_pdf_sha256
 *   certificate       the signing certificate   ↔ its generated_documents.sha256
 *   signature_image   each drawn signature      ↔ contract_signers.signature_sha256
 *   content           rendered_content, hashed  ↔ rendered_content_sha256
 *   attachment        each manifest attachment  ↔ the sha256 in the manifest
 *   manifest          the manifest, hashed      ↔ attachment_manifest_sha256
 *   event_chain       the signing log           ↔ contracts.audit_chain_head
 *   completed_artifact the `completed` event's artifactSha256 ↔ the signed PDF on disk
 *
 * `ok` is true, false, or null for "can't be checked" (content redacted on
 * erasure). Which artefacts must exist is derived from what the contract
 * recorded, never from what is found: a recorded hash, a status that
 * implies a file, or a chain head each make their artefact required, and a
 * required artefact that is gone — row or file — is a failing check with
 * `note: 'missing'`. The overall result fails when any check is false.
 *
 * There is deliberately no public variant: "does this hash belong to
 * contract N" would be an enumeration oracle. The certificate prints the
 * hashes; anyone holding the PDF checks it with `sha256sum`.
 */

const crypto = require('crypto');
const fs = require('fs');
const { db, logActivity } = require('../../database/db');
const { AppError } = require('../../utils/errors');
const { canonicalSha256 } = require('../../utils/canonicalJson');
const signingEvents = require('./signingEvents');
const attachments = require('./attachments');
const { adminActor } = require('./helpers');

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

function fileSha(file) {
  try {
    return file && fs.existsSync(file) ? sha256(fs.readFileSync(file)) : null;
  } catch (_) {
    return null;
  }
}

function parseJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

const compare = (check, expected, actual, extra = {}) => ({
  check,
  subject: null,
  ok: !!(expected && actual && expected === actual),
  expected: expected || null,
  actual: actual || null,
  note: actual ? null : 'missing',
  ...extra,
});

async function integrityReport(contractId, { adminId = null } = {}) {
  const contract = await db('contracts').where({ id: contractId }).first();
  if (!contract) throw new AppError('Contract not found', 404);
  const checks = [];

  const complete = contract.status === 'fully_signed';
  if (contract.pdf_sha256 || contract.pdf_path) {
    checks.push(compare('unsigned_pdf', contract.pdf_sha256, fileSha(contract.pdf_path)));
  }
  if (contract.signed_pdf_sha256 || contract.signed_pdf_path || complete) {
    checks.push(compare('signed_pdf', contract.signed_pdf_sha256, fileSha(contract.signed_pdf_path)));
  }

  const certificate = await db('generated_documents')
    .where({ doc_type: 'contract', doc_id: contractId, kind: 'audit' })
    .orderBy('id', 'desc')
    .first();
  if (certificate || complete) {
    checks.push(compare('certificate', certificate && certificate.sha256, certificate ? fileSha(certificate.path) : null));
  }

  const rows = await db('contract_signers').where({ contract_id: contractId }).orderBy('position', 'asc');
  for (const row of rows) {
    if (!row.signature_sha256 && !row.signature_path) continue;
    checks.push(compare('signature_image', row.signature_sha256, fileSha(row.signature_path), { subject: row.slot_key }));
  }

  if (contract.rendered_content_sha256) {
    const snapshot = parseJson(contract.rendered_content);
    if (contract.rendered_content_redacted_at) {
      // Erasure cleared the customer's details out of the text and kept the
      // hash it was signed against: not checkable, and not a tampering.
      checks.push({
        check: 'content', subject: null, ok: null, expected: contract.rendered_content_sha256,
        actual: snapshot ? canonicalSha256(snapshot) : null, note: 'redacted_on_erasure',
      });
    } else {
      checks.push(compare('content', contract.rendered_content_sha256, snapshot ? canonicalSha256(snapshot) : null));
    }
  }

  const unsigned = await db('generated_documents')
    .where({ doc_type: 'contract', doc_id: contractId, kind: 'unsigned' })
    .orderBy('id', 'desc')
    .first();
  const manifest = unsigned ? parseJson(unsigned.manifest) : null;
  for (const entry of (manifest && manifest.attachments) || []) {
    const library = await db('document_attachments').where({ id: entry.attachmentId }).first('storage_key');
    let actual = null;
    try {
      actual = library ? sha256(attachments.readStoredFile(library).buffer) : null;
    } catch (_) { /* missing or outside the store: reported as missing */ }
    checks.push(compare('attachment', entry.sha256, actual, { subject: entry.name }));
  }
  if (contract.attachment_manifest_sha256) {
    checks.push(compare('manifest', contract.attachment_manifest_sha256, manifest ? attachments.manifestSha256(manifest) : null));
  }

  const events = await signingEvents.listEvents(contractId);
  if (events.length || contract.audit_chain_head) {
    const chain = await signingEvents.verifyChain(contractId);
    checks.push({
      check: 'event_chain',
      subject: null,
      // A recorded head with no events left is a log that went missing.
      ok: chain.ok && events.length > 0,
      expected: contract.audit_chain_head || null,
      actual: chain.head,
      note: !events.length ? 'missing' : (chain.ok ? null : `${chain.reason} at #${chain.brokenAt}`),
      brokenAt: chain.brokenAt,
    });
  }
  // A completed v2 contract has its completion in the log: the `completed`
  // event, or — completed on paper — the `wet_upload` one.
  const completion = [...events].reverse().find((e) => e.type === 'completed' || e.type === 'wet_upload');
  if (completion || (complete && Number(contract.signing_version) === 2)) {
    checks.push(compare('completed_artifact', completion && completion.artifactSha256, fileSha(contract.signed_pdf_path),
      completion ? {} : { actual: null, note: 'missing' }));
  }

  const failed = checks.filter((c) => c.ok === false).map((c) => c.check);
  const report = {
    contractId: Number(contract.id),
    contractNumber: contract.contract_number,
    generatedAt: new Date().toISOString(),
    ok: failed.length === 0,
    checks,
    // The two PDF legs as the older card read them.
    unsigned: leg(contract.pdf_path, contract.pdf_sha256),
    signed: leg(contract.signed_pdf_path, contract.signed_pdf_sha256),
  };
  try {
    await logActivity('contract_integrity_verified', {
      contractId: report.contractId, ok: report.ok, failed,
    }, null, await adminActor(adminId));
  } catch (_) { /* logging is best-effort */ }
  return report;
}

function leg(filePath, expected) {
  const present = !!filePath && fs.existsSync(filePath);
  const actual = present ? fileSha(filePath) : null;
  return { path: filePath || null, present, expected: expected || null, actual, match: !!(expected && actual && expected === actual) };
}

module.exports = { integrityReport };
