'use strict';

/**
 * Signatures v2 (#1446).
 *
 * - Every customer signer signs with their own link, after confirming their
 *   email with a code (or from a customer-portal login with that email).
 * - Signers sign in parallel, or one after the other when the contract is
 *   sequential; the issuer counter-signs only once every customer has.
 * - Each signature is stamped into the signer's slot from the document's
 *   record, inside a transaction that locks the contract, so two signers
 *   signing at once can't overwrite each other's stamp.
 * - Every step goes into the chained event log (signingEvents). Completion
 *   draws the identifier band and issues the signing certificate.
 * - IP address and user agent are stored encrypted (when the "store IP"
 *   setting is on), never returned by the API except to the evidence view.
 *
 * Contracts sent before this (signing_version NULL) keep the single-link
 * flow in signatures.js.
 */

const fs = require('fs');
const crypto = require('crypto');
const { db, logActivity } = require('../../database/db');
const logger = require('../../utils/logger');
const { AppError } = require('../../utils/errors');
const { getAppSetting } = require('../../utils/appSettings');
const { getFrontendBaseUrl } = require('../../utils/frontendUrl');
const { formatShortDate } = require('../../utils/dateFormatter');
const { assertContractPdfPath } = require('../../utils/safePath');
const fieldEncryption = require('../../utils/fieldEncryption');
const emailProcessor = require('../emailProcessor');
const pdfStampService = require('../pdfStampService');
const documentArtifactService = require('../documentArtifactService');
const { ensureContractEmailTemplatesSeeded } = require('../contractEmailTemplates');
const signers = require('./signers');
const signingEvents = require('./signingEvents');
const { hasColumnCached } = require('../../utils/schemaCache');
const { auditedUpdate } = require('../accountingHistory');
const {
  adminActor, customerPublicActor, emitContractEvent, maybeStoreIp, releaseQuoteOnDeadContract,
} = require('./helpers');
const { persistContractPdf, persistSignatureImage } = require('./signatureAssets');

const VERSION = 2;
const CONSENT_VERSION = 'v1';

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const isV2 = (contract) => Number(contract && contract.signing_version) === VERSION;
const signerName = (row) => fieldEncryption.tryDecrypt(row.name_enc) || '';
const signerEmail = (row) => fieldEncryption.tryDecrypt(row.email_enc) || '';

function pdfInternals() {
  return require('../pdfService')._internal;
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/** The renderer's slot list: one per signer, customers first, the issuer last. */
function slotsFor(rows, locale) {
  const { t } = pdfInternals();
  return rows.map((row) => ({
    key: row.slot_key,
    role: row.role,
    label: t(locale, row.role === 'issuer' ? 'signature_signer_issuer' : 'signature_signer_customer'),
    name: signerName(row),
  }));
}

function invitationExpiry(contract) {
  return contract.valid_until
    ? new Date(new Date(contract.valid_until).getTime() + 14 * 24 * 60 * 60 * 1000)
    : new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
}

async function readDateFormat() {
  try {
    const raw = await getAppSetting('general_date_format');
    if (raw && typeof raw === 'object' && raw.format) return raw;
    if (typeof raw === 'string' && raw.trim()) return { format: raw.trim() };
  } catch (_) { /* default below */ }
  return { format: 'DD.MM.YYYY' };
}

/** Theme and font settings for the stamp overlay — read before any transaction opens. */
async function stampFontOptions() {
  const profile = (await db('business_profile').where({ id: 1 }).first()) || {};
  return {
    issuer: { pdfFontTtfPath: profile.pdf_font_ttf_path || null, pdfFontFamily: profile.pdf_font_family || null },
    theme: await require('../pdfThemeService').resolveTheme('contract'),
  };
}

/** "14.09.2026, 14:32 (GMT+2)" */
function formatSignedAt(date, dateFormat) {
  const { formatDate } = pdfInternals();
  const parts = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'shortOffset',
  }).formatToParts(date);
  const part = (type) => (parts.find((p) => p.type === type) || {}).value || '';
  return `${formatDate(date, dateFormat)}, ${part('hour')}:${part('minute')} (${part('timeZoneName')})`;
}

function captionLines({ locale, name, signedAt, mode, via, dateFormat }) {
  const { t } = pdfInternals();
  return [
    `${t(locale, 'signed_label_name')}: ${name}`,
    `${t(locale, 'signed_label_date')}: ${formatSignedAt(signedAt, dateFormat)}`,
    `${t(locale, `signature_method_${mode}`)} · ${t(locale, `signature_verified_${via}`)}`,
  ];
}

async function unsignedManifest(contractId, conn) {
  const doc = await conn('generated_documents')
    .where({ doc_type: 'contract', doc_id: contractId, kind: 'unsigned' })
    .orderBy('id', 'desc')
    .first();
  try {
    return doc && doc.manifest ? JSON.parse(doc.manifest) : null;
  } catch (_) {
    return null;
  }
}

function slotFrom(manifest, key) {
  const slot = manifest && Array.isArray(manifest.slots) ? manifest.slots.find((s) => s.key === key) : null;
  if (!slot) throw new AppError('This signer has no signature slot in the document record', 500, 'SIGNATURE_SLOT_MISSING');
  return slot;
}

/** The PDF as it stands (the latest signed copy, or the sent one). */
function currentPdf(contract) {
  const file = contract.signed_pdf_path || contract.pdf_path;
  if (!file || !fs.existsSync(file)) throw new AppError('The contract PDF is missing', 500, 'PDF_MISSING');
  return fs.readFileSync(assertContractPdfPath(file));
}

function readSignature(input, requireDrawn) {
  const name = String((input && input.name) || '').trim().slice(0, 255);
  if ((input && input.accepted) !== true) {
    throw new AppError('Confirm that you have read and agree to the contract.', 400, 'TOS_REQUIRED');
  }
  if (!name) throw new AppError('Your name is required.', 400, 'NAME_REQUIRED');
  const mode = input.mode === 'typed' ? 'typed' : 'drawn';
  if (mode === 'typed' && requireDrawn) {
    throw new AppError('A drawn signature is required for this contract.', 400, 'SIGNATURE_REQUIRED');
  }
  if (mode === 'drawn' && !input.signatureDataUrl) {
    throw new AppError('Draw your signature, or type your name instead.', 400, 'SIGNATURE_REQUIRED');
  }
  return { name, mode };
}

function removeQuietly(file) {
  if (!file) return;
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch (err) {
    logger.warn('Could not remove a file after a failed signature', { file, message: err.message });
  }
}

async function adminDashboardUrl(contractId) {
  const frontendUrl = (await getFrontendBaseUrl()) || 'http://localhost:3000';
  return `${frontendUrl}/admin/clients/contracts/${contractId}`;
}

/** Mail to the business address (Settings → business profile). */
async function notifyAdmin(templateKey, data) {
  const profile = await db('business_profile').where({ id: 1 }).first();
  const to = profile && profile.email;
  if (!to) {
    logger.warn('No business email to notify about a contract', { templateKey });
    return;
  }
  try {
    await emailProcessor.queueEmail(null, to, templateKey, data);
  } catch (err) {
    logger.warn('Failed to queue a contract notification', { templateKey, message: err.message });
  }
}

/**
 * A step after the committed signature failed — the next signer's
 * invitation, the certificate, the completion emails. The signature itself
 * stands, so this can't throw; it records what failed on the contract, where
 * the signing overview shows it and the admin can run the step again
 * ("Re-send the signed contract" re-issues a missing certificate).
 */
async function recordFollowUpFailure(contractId, step, err) {
  logger.error('A step after the signature failed', { contractId, step, message: err && err.message });
  try {
    if (!(await hasColumnCached('contracts', 'follow_up_failed_at'))) return;
    await auditedUpdate(db, 'contracts', { id: contractId }, {
      follow_up_failed_at: new Date().toISOString(),
      follow_up_error: `${step}: ${String((err && err.message) || 'unknown').slice(0, 500)}`,
    }, { source: `contract.follow_up.${step}` });
  } catch (markErr) {
    logger.warn('Could not record the failed follow-up step', { contractId, message: markErr.message });
  }
}

/** Every follow-up step went through: clear the marker. */
async function clearFollowUpFailure(contractId) {
  try {
    if (!(await hasColumnCached('contracts', 'follow_up_failed_at'))) return;
    await auditedUpdate(db, 'contracts', (q) => q.where({ id: contractId }).whereNotNull('follow_up_failed_at'),
      { follow_up_failed_at: null, follow_up_error: null }, { source: 'contract.follow_up.cleared' });
  } catch (err) {
    logger.warn('Could not clear the failed follow-up marker', { contractId, message: err.message });
  }
}

async function bestEffortLog(type, meta, actor) {
  try {
    await logActivity(type, meta, null, actor);
  } catch (_) { /* logging is best-effort */ }
}

// ---------------------------------------------------------------------
// Sending and invitations
// ---------------------------------------------------------------------

/** What goes with an invitation: the sent PDF (unless switched off) and separate attachments. */
async function invitationAttachments(contract) {
  const list = [];
  if ((await getAppSetting('crm_contracts_pdf_attachment_enabled')) !== false && contract.pdf_path) {
    list.push({ filename: `${contract.contract_number}.pdf`, contentPath: contract.pdf_path, contentType: 'application/pdf' });
  }
  const attachments = require('./attachments');
  for (const row of await attachments.loadContractAttachments(contract.id)) {
    if (row.delivery !== 'separate') continue;
    const { absolute } = attachments.readStoredFile(row);
    list.push({ filename: attachments.downloadName(row.name), contentPath: absolute, contentType: 'application/pdf' });
  }
  return list.length ? list : undefined;
}

async function sendInvitation(contract, row, token) {
  const frontendUrl = (await getFrontendBaseUrl()) || 'http://localhost:3000';
  await emailProcessor.queueEmail(null, signerEmail(row), 'contract_sent', {
    contract_number: contract.contract_number,
    customer_name: signerName(row),
    response_url: `${frontendUrl}/contract/${token}`,
    title: contract.title || '',
    event_name: contract.event_name || '',
    valid_until: formatShortDate(contract.valid_until),
    attachments: await invitationAttachments(contract),
  });
}

/**
 * Invite the customer signers who may sign now and haven't been invited:
 * all of them, or the next one of a sequential contract.
 */
async function inviteDue(contractId, actor = { type: 'system' }) {
  const contract = await db('contracts').where({ id: contractId }).first();
  const due = signers.signersDue(contract, await signers.listSigners(contractId)).filter((row) => row.status === 'pending');
  const expiresAt = invitationExpiry(contract);
  for (const row of due) {
    const token = await db.transaction(async (trx) => {
      const created = await signers.createInvitation(trx, row.id, expiresAt);
      await signingEvents.appendEvent(trx, contractId, {
        type: 'invited', actorType: actor.type === 'admin' ? 'admin' : 'system', actorLabel: actor.name || null, signerId: row.id,
      });
      return created;
    });
    // The invitation is committed before the mail goes out; undo it when the
    // send fails, or the signer sits at `invited` with a link nobody received
    // and every later inviteDue skips them.
    try {
      await sendInvitation(contract, row, token);
    } catch (err) {
      await signers.undoInvitation(row.id);
      throw err;
    }
  }
  return due.length;
}

/** Before the send renders: the signers (the customer by default) and their slots. */
async function prepareSend(contract) {
  const rows = await db.transaction((trx) => signers.ensureSigners(trx, contract));
  return { rows, slots: slotsFor(rows, contract.language || 'de') };
}

/** After the send stored the PDF: mark it sent, log it, invite the signers. */
async function completeSend(contractId, { pdfPath, pdfSha256, adminId, freeze = null, lockVersion = null }) {
  const actor = await adminActor(adminId);
  await db.transaction(async (trx) => {
    const now = new Date();
    // One claim for the whole send: the contract must still be the draft that
    // was rendered — same status, same lock_version — or this send is not the
    // one going out. Two overlapping sends, or an edit saved between the
    // render and here, lose it, and nothing they carry is written.
    const history = { actor: adminId, source: 'contract.send' };
    // The claim: still the draft that was rendered, same lock_version.
    const claim = (query) => {
      query.where({ id: contractId, status: 'draft' });
      if (lockVersion != null) query.where('lock_version', lockVersion);
    };
    const draft = await trx('contracts').modify(claim).first();
    if (!draft) {
      throw new AppError(
        'This contract changed while it was being sent. Reload it and send again.',
        409, 'CONTRACT_CHANGED',
      );
    }
    // The text the rendered PDF shows, frozen with it (see sending.js).
    if (freeze) {
      for (const inc of freeze.inclusions) {
        await auditedUpdate(trx, 'contract_block_inclusions', { id: inc.id },
          { ...inc.columns, updated_at: now }, history);
      }
    }
    const sent = await auditedUpdate(trx, 'contracts', claim, {
      status: 'sent',
      sent_at: now.toISOString(),
      pdf_path: pdfPath,
      pdf_sha256: pdfSha256,
      signing_version: VERSION,
      lock_version: (Number(draft.lock_version) || 1) + 1,
      ...(freeze ? {
        rendered_content: freeze.renderedContent,
        rendered_content_sha256: freeze.contentSha256,
      } : {}),
      updated_at: now,
    }, history);
    if (!sent) {
      throw new AppError(
        'This contract changed while it was being sent. Reload it and send again.',
        409, 'CONTRACT_CHANGED',
      );
    }
    const contract = await trx('contracts').where({ id: contractId }).first();
    await signingEvents.appendEvent(trx, contractId, {
      type: 'sent',
      actorType: 'admin',
      actorLabel: actor.name || null,
      artifactSha256: pdfSha256,
      payload: { contentSha256: contract.rendered_content_sha256 || null, order: contract.signing_order || 'parallel' },
    });
  });
  return inviteDue(contractId, actor);
}

/** A new link for one signer (the old one stops working). */
async function resendInvitation(contractId, signerId, adminId) {
  const contract = await db('contracts').where({ id: contractId }).first();
  if (!contract) throw new AppError('Contract not found', 404);
  if (!isV2(contract) || contract.status !== 'sent') {
    throw new AppError('Links can only be sent again while the contract is out for signature', 409, 'CONTRACT_NOT_SIGNABLE');
  }
  const rows = await signers.listSigners(contractId);
  const row = rows.find((r) => r.id === Number(signerId));
  if (!row || row.role !== 'customer') throw new AppError('Signer not found', 404, 'SIGNER_NOT_FOUND');
  if (!signers.signersDue(contract, rows).some((r) => r.id === row.id)) {
    throw new AppError('This signer can\'t sign yet, or has already signed', 409, 'SIGNER_NOT_DUE');
  }
  const actor = await adminActor(adminId);
  const token = await db.transaction(async (trx) => {
    const created = await signers.createInvitation(trx, row.id, invitationExpiry(contract));
    await signingEvents.appendEvent(trx, contractId, {
      type: 'invitation_resent', actorType: 'admin', actorLabel: actor.name || null, signerId: row.id,
    });
    return created;
  });
  try {
    await sendInvitation(contract, row, token);
  } catch (err) {
    await signers.undoInvitation(row.id);
    throw err;
  }
  return { resent: true };
}

/** Cancelling a v2 contract withdraws every link and session. */
async function revokeOnCancel(contractId, adminId) {
  const actor = await adminActor(adminId);
  await db.transaction(async (trx) => {
    await signers.revokeAccess(trx, contractId);
    await signingEvents.appendEvent(trx, contractId, { type: 'revoked', actorType: 'admin', actorLabel: actor.name || null });
  });
}

// ---------------------------------------------------------------------
// The signer's side
// ---------------------------------------------------------------------

function assertReachable(contract, signer) {
  if (!isV2(contract) || signer.role !== 'customer') {
    throw new AppError('Signing link not found', 404, 'SIGNING_LINK_INVALID');
  }
  if (['cancelled', 'draft'].includes(contract.status)) {
    throw new AppError('This contract has been withdrawn', 410, 'CONTRACT_WITHDRAWN');
  }
}

/**
 * The invitation path — the emailed link, its code and the session it mints —
 * only works while the contract is still out for signature. A completed or
 * declined contract has an audit certificate naming the chain head it was
 * issued at, and a code request or a verification appends events past it.
 */
function assertInvitable(contract, signer) {
  assertReachable(contract, signer);
  if (contract.status !== 'sent') {
    throw new AppError('This contract is no longer waiting for signatures', 410, 'CONTRACT_NOT_SIGNABLE');
  }
}

/** What an unverified link shows: enough to recognise it, nothing about the customer. */
async function invitationSummary(token) {
  const { signer, contract } = await signers.findInvitation(token);
  assertInvitable(contract, signer);
  const publicView = require('./publicView');
  const profile = await db('business_profile').where({ id: 1 }).first();
  return {
    contractNumber: contract.contract_number,
    status: contract.status,
    language: contract.language,
    issuer: await publicView.issuerSummary(profile),
    signer: { status: signer.status, maskedEmail: signers.maskEmail(signerEmail(signer)) },
  };
}

async function requestCode(token) {
  const { signer, contract } = await signers.findInvitation(token);
  assertInvitable(contract, signer);
  await ensureContractEmailTemplatesSeeded(db, logger);
  const { code, otpId, ttlMinutes, resendAfterSeconds } = await signers.issueOtp(signer.id);
  const email = signerEmail(signer);
  // Sent now, not queued — the way the quote and contract verification code
  // goes out (#1465). A queued code was "sent" as far as the page could
  // tell even when no mail server would ever deliver it, and the signer
  // waited for an email that didn't come. A code that fails to send is
  // removed again and the page says so.
  try {
    await emailProcessor.sendTemplateEmail(email, 'contract_signing_code', {
      contract_number: contract.contract_number,
      customer_name: signerName(signer),
      code,
      ttl_minutes: ttlMinutes,
    });
  } catch (err) {
    await signers.discardOtp(otpId);
    // No address and no code in the log line.
    logger.warn('Contract signing code email failed', { contractId: contract.id, signerId: signer.id, err: err.message });
    throw new AppError('The code could not be sent right now. Please try again later.', 503, 'EMAIL_UNAVAILABLE');
  }
  await signers.retireEarlierOtps(signer.id, otpId);
  await signingEvents.appendEvent(db, contract.id, { type: 'code_sent', actorType: 'system', signerId: signer.id });
  return { maskedEmail: signers.maskEmail(email), ttlMinutes, resendAfterSeconds };
}

async function verifyCode(token, code) {
  const { signer, contract } = await signers.findInvitation(token);
  assertInvitable(contract, signer);
  await signers.verifyOtp(signer.id, code);
  const session = await openSession(contract.id, signer, 'otp');
  return { sessionToken: session.token, expiresAt: session.expiresAt };
}

/**
 * Mint a session and record the verification, under the contract's lock and
 * only while it is still out for signature. The status was checked before the
 * code was sent; a countersignature committing in between would otherwise
 * leave a `verified` event past the chain head the certificate printed —
 * which is the thing sealing exists to prevent.
 */
async function openSession(contractId, signer, via) {
  return db.transaction(async (trx) => {
    const current = await trx('contracts').where({ id: contractId }).forUpdate().first();
    if (!current || current.status !== 'sent') {
      throw new AppError('This contract is no longer waiting for signatures', 410, 'CONTRACT_NOT_SIGNABLE');
    }
    const session = await signers.createSession(signer.id, via, trx);
    await signingEvents.appendEvent(trx, contractId, {
      type: 'verified', actorType: 'signer', actorLabel: signerName(signer), signerId: signer.id, payload: { via },
    });
    return session;
  });
}

async function sessionContext(sessionToken) {
  const context = await signers.findSession(sessionToken);
  assertReachable(context.contract, context.signer);
  return context;
}

function progress(rows) {
  return rows.map((row) => ({
    position: Number(row.position),
    role: row.role,
    name: signerName(row),
    status: row.status === 'signed' || row.status === 'declined' ? row.status : 'pending',
  }));
}

/**
 * Is this signer the customer account the contract belongs to?
 *
 * `contract_signers` carries no `customer_account_id`, so the email hash is
 * the link — the same one `portalSigningAccess` matches on when it opens a
 * session for a signed-in customer.
 */
async function isAccountHolder(contract, signer) {
  if (!signer.email_hash || !contract.customer_account_id) return false;
  const customer = await db('customer_accounts').where({ id: contract.customer_account_id }).first('email');
  if (!customer || !customer.email) return false;
  return fieldEncryption.hashEmail(customer.email) === signer.email_hash;
}

/** The full contract for a verified signer, with where the signing stands. */
async function sessionView(sessionToken) {
  const { signer, contract, session } = await sessionContext(sessionToken);
  const view = await require('./publicView').buildPublicView(contract.id);
  delete view.signedCustomerIp;
  // `recipient` is the account holder's block: display name, company and the
  // address their signing codes are sent to. A second signer is not that
  // person, and the address a co-signer authenticates with is exactly the
  // one signer's authentication data that must not reach another. The
  // display name stays — it is printed in the contract they are reading.
  if (view.recipient && !(await isAccountHolder(contract, signer))) {
    view.recipient = { displayName: view.recipient.displayName, companyName: null, email: null };
  }
  const rows = await signers.listSigners(contract.id);
  const due = signers.signersDue(contract, rows).some((r) => r.id === signer.id);
  const canSign = contract.status === 'sent' && signer.status === 'invited' && due;
  view.canSign = canSign;
  // Several signers can't be represented by one uploaded paper copy, so the
  // panel isn't offered where wetUploadContext would refuse it.
  view.allowPdfUpload = view.allowPdfUpload && rows.filter((r) => r.role === 'customer').length === 1;
  view.signing = {
    name: signerName(signer),
    email: signerEmail(signer),
    status: signer.status,
    verifiedVia: session.verified_via,
    order: contract.signing_order || 'parallel',
    canSign,
    waitingForOthers: contract.status === 'sent' && signer.status === 'invited' && !due,
    canDecline: contract.status === 'sent' && signer.status === 'invited',
    signers: progress(rows),
  };
  return view;
}

/**
 * A wet-signed PDF replaces the whole document and completes the contract, so
 * it is accepted only from the signer whose turn it is, only while the
 * contract is still out for signature, and only when they are the single
 * customer signer. With several signers the server cannot tell whether the
 * paper carries the others' signatures, and accepting it would complete the
 * contract for all of them (or skip the countersignature) — those upload in
 * the browser, or the admin uploads the countersigned paper themselves.
 */
async function wetUploadContext(sessionToken) {
  const context = await sessionContext(sessionToken);
  const { contract, signer } = context;
  if (contract.status !== 'sent') {
    throw new AppError('This contract is not waiting for a signature', 409, 'CONTRACT_NOT_SIGNABLE');
  }
  const rows = await signers.listSigners(contract.id);
  if (signer.status !== 'invited' || !signers.signersDue(contract, rows).some((r) => r.id === signer.id)) {
    throw new AppError('It is not your turn to sign this contract.', 409, 'NOT_YOUR_TURN');
  }
  if (rows.filter((r) => r.role === 'customer').length > 1) {
    throw new AppError(
      'This contract has several signers, so an uploaded PDF cannot stand in for all of them. Please sign in your browser instead.',
      409, 'MULTIPLE_SIGNERS',
    );
  }
  return context;
}

async function sessionPdf(sessionToken) {
  const { contract } = await sessionContext(sessionToken);
  return { contract, buffer: currentPdf(contract) };
}

async function sessionAttachment(sessionToken, attachmentId) {
  const { contract } = await sessionContext(sessionToken);
  return require('./attachments').openContractAttachment(contract.id, attachmentId);
}

/** A customer signer signs. Idempotent per `idempotencyKey`. */
async function sign(sessionToken, input, { ip = null, userAgent = null } = {}) {
  const { signer, contract, session } = await sessionContext(sessionToken);
  const requireDrawn = (await getAppSetting('crm_contracts_require_drawn_signature')) === true;
  const { name, mode } = readSignature(input, requireDrawn);
  const idempotencyKey = input.idempotencyKey ? String(input.idempotencyKey).slice(0, 64) : null;
  if (signer.status === 'signed') {
    if (idempotencyKey && signer.idempotency_key === idempotencyKey) {
      // A replay answers with the signature that was recorded — but only when
      // it IS the same signature. The key is generated once per link and
      // resent after a lost response, so a key arriving with a different name
      // or a different mode is not the request that succeeded, and answering
      // "done" would report a signature nobody made that way.
      if (signerName(signer) !== name || (signer.signature_mode || null) !== mode) {
        throw new AppError(
          'This signature was already recorded with different details. Reload the page to see where the contract stands.',
          409, 'IDEMPOTENCY_KEY_REUSED',
        );
      }
      return { status: contract.status, signedAt: signer.signed_at, replayed: true };
    }
    throw new AppError('You have already signed this contract.', 409, 'ALREADY_SIGNED');
  }

  // Everything that reads the global connection happens before the transaction.
  await ensureContractEmailTemplatesSeeded(db, logger);
  const storedIp = await maybeStoreIp(ip);
  const keepEvidence = storedIp !== null;
  const fontOptions = await stampFontOptions();
  const dateFormat = await readDateFormat();
  const locale = contract.language || 'de';
  const signaturePath = mode === 'drawn'
    ? await persistSignatureImage(contract, `signer-${signer.id}`, input.signatureDataUrl)
    : null;
  const imageBytes = signaturePath ? fs.readFileSync(signaturePath) : null;
  const signedAt = new Date();
  const via = session.verified_via;
  let written = null;

  let outcome;
  try {
    outcome = await db.transaction(async (trx) => {
      const current = await trx('contracts').where({ id: contract.id }).forUpdate().first();
      const row = await trx('contract_signers').where({ id: signer.id }).first();
      if (current.status !== 'sent') {
        throw new AppError(`This contract can't be signed now (status: ${current.status})`, 409, 'CONTRACT_NOT_SIGNABLE');
      }
      if (row.status === 'signed') throw new AppError('You have already signed this contract.', 409, 'ALREADY_SIGNED');
      const all = await signers.listSigners(contract.id, trx);
      if (!signers.signersDue(current, all).some((r) => r.id === row.id)) {
        throw new AppError('Another signer has to sign first.', 409, 'NOT_YOUR_TURN');
      }
      if (row.status !== 'invited') throw new AppError('This signing link is no longer valid.', 409, 'CONTRACT_NOT_SIGNABLE');

      const base = currentPdf(current);
      const slot = slotFrom(await unsignedManifest(contract.id, trx), row.slot_key);
      const stamped = await pdfStampService.stampSlot({
        pdfBuffer: base,
        slot,
        imageBytes,
        typedName: mode === 'typed' ? name : null,
        captions: captionLines({ locale, name, signedAt, mode, via, dateFormat }),
        fontOptions,
      });
      const stored = await persistContractPdf(current, stamped, `signed-${row.slot_key}`, {
        kind: 'signed', conn: trx, templateVersionId: current.template_version_id,
      });
      written = stored.filePath;

      const updated = await trx('contract_signers').where({ id: row.id, status: 'invited' }).update({
        status: 'signed',
        signed_at: signedAt,
        name_enc: fieldEncryption.encrypt(name),
        signature_mode: mode,
        signature_path: signaturePath,
        signature_sha256: imageBytes ? sha256(imageBytes) : null,
        consent_version: CONSENT_VERSION,
        content_sha256: current.rendered_content_sha256 || null,
        document_sha256: sha256(base),
        ip_enc: keepEvidence ? fieldEncryption.encrypt(ip) : null,
        user_agent_enc: keepEvidence && userAgent ? fieldEncryption.encrypt(String(userAgent).slice(0, 512)) : null,
        idempotency_key: idempotencyKey,
        updated_at: signedAt,
      });
      if (!updated) throw new AppError('You have already signed this contract.', 409, 'ALREADY_SIGNED');

      const customers = all.filter((r) => r.role === 'customer');
      const customersDone = customers.every((r) => r.id === row.id || r.status === 'signed');
      const contractUpdate = { signed_pdf_path: stored.filePath, signed_pdf_sha256: stored.sha256, updated_at: signedAt };
      if (customersDone) {
        contractUpdate.status = 'signed_by_customer';
        contractUpdate.signed_by_customer_at = signedAt;
        contractUpdate.signed_customer_name = customers.map((r) => (r.id === row.id ? name : signerName(r))).join(', ').slice(0, 255);
      }
      await auditedUpdate(trx, 'contracts', { id: contract.id }, contractUpdate,
        { actor: { type: 'customer', name }, source: 'contract.sign.customer' });
      await signingEvents.appendEvent(trx, contract.id, {
        type: 'signed',
        actorType: 'signer',
        actorLabel: name,
        signerId: row.id,
        artifactSha256: stored.sha256,
        payload: {
          mode, via, slot: row.slot_key, documentSha256: sha256(base),
          contentSha256: current.rendered_content_sha256 || null, consentVersion: CONSENT_VERSION,
        },
      });
      return { customersDone };
    });
  } catch (err) {
    // Nothing committed, so the files this attempt wrote are orphans.
    removeQuietly(signaturePath);
    removeQuietly(written);
    throw err;
  }

  // Committed: contract_signers.signature_path and contracts.signed_pdf_path
  // point at those files now, so nothing below may delete them — a failed
  // notice would otherwise take the signature and the signed PDF with it.
  try {
    if (outcome.customersDone) {
      await notifyAdmin('contract_signed_admin_notification', {
        contract_number: contract.contract_number,
        customer_email: signerEmail(signer),
        signed_customer_name: name,
        admin_dashboard_url: await adminDashboardUrl(contract.id),
      });
    } else {
      await inviteDue(contract.id);
    }
    await clearFollowUpFailure(contract.id);
  } catch (err) {
    await recordFollowUpFailure(contract.id, outcome.customersDone ? 'admin_notice' : 'next_invitation', err);
  }
  await bestEffortLog('contract_signed_by_customer', { contractId: contract.id, signerId: signer.id }, customerPublicActor());
  return { status: outcome.customersDone ? 'signed_by_customer' : 'sent', signedAt };
}

async function decline(sessionToken, { reason } = {}) {
  const { signer, contract } = await sessionContext(sessionToken);
  if (signer.status === 'signed') throw new AppError('You have already signed this contract.', 409, 'ALREADY_SIGNED');
  await ensureContractEmailTemplatesSeeded(db, logger);
  const text = reason ? String(reason).trim().slice(0, 1000) : '';
  const now = new Date();
  await db.transaction(async (trx) => {
    const current = await trx('contracts').where({ id: contract.id }).forUpdate().first();
    if (current.status !== 'sent') {
      throw new AppError(`This contract can't be declined now (status: ${current.status})`, 409, 'CONTRACT_NOT_SIGNABLE');
    }
    await trx('contract_signers').where({ id: signer.id }).update({
      status: 'declined', declined_at: now, decline_reason_enc: fieldEncryption.encrypt(text), updated_at: now,
    });
    await auditedUpdate(trx, 'contracts', { id: contract.id }, { status: 'declined', declined_at: now, updated_at: now },
      { actor: { type: 'customer', name: signerName(signer) }, source: 'contract.decline' });
    // Release the source quote's converted_contract_id so a replacement
    // contract can be created from it (issue 1588).
    await releaseQuoteOnDeadContract(trx, contract.id, current.source_quote_id);
    await signers.revokeAccess(trx, contract.id);
    await signingEvents.appendEvent(trx, contract.id, {
      type: 'declined', actorType: 'signer', actorLabel: signerName(signer), signerId: signer.id, payload: { withReason: !!text },
    });
  });
  await notifyAdmin('contract_declined_admin_notification', {
    contract_number: contract.contract_number,
    signer_name: signerName(signer),
    reason: text,
    admin_dashboard_url: await adminDashboardUrl(contract.id),
  });
  await bestEffortLog('contract_declined', { contractId: contract.id, signerId: signer.id }, customerPublicActor());
  return { status: 'declined' };
}

/**
 * The customer signers a paper copy still has to account for: everyone who
 * has neither signed in the browser nor declined.
 */
async function awaitingCustomerSigners(contractId, conn = db) {
  const rows = await signers.listSigners(contractId, conn);
  return rows.filter((r) => r.role === 'customer' && !['signed', 'declined'].includes(r.status));
}

/** Has any customer signer already signed this contract in the browser? */
async function electronicSignaturePresent(contractId, conn = db) {
  const rows = await signers.listSigners(contractId, conn);
  return rows.some((r) => r.role === 'customer' && r.status === 'signed');
}

/**
 * An admin uploading a wet-signed PDF completes the contract for everyone,
 * and the server cannot read whose signatures the paper actually bears. The
 * customer's own upload is simply refused when there is more than one signer
 * (wetUploadContext); the admin keeps the capability — it is how an offline
 * signature reaches the record at all — but has to state which signers the
 * copy covers, and the answer goes into the event log as the evidence that
 * they did.
 *
 * @returns {Promise<number[]>} the covered signer ids, in position order
 */
async function assertPaperCoversSigners(contractId, coversSignerIds) {
  // The upload replaces the signed PDF and completes the contract, so a
  // signature already given in the browser would be discarded while the log
  // records only the slots the paper covers. Once anyone has signed
  // electronically, the admin finishes in the browser instead.
  if (await electronicSignaturePresent(contractId)) {
    throw new AppError(
      'A signer has already signed this contract in the browser, so a paper copy can\'t replace it. Counter-sign in the browser instead.',
      409, 'ELECTRONIC_SIGNATURE_PRESENT',
    );
  }
  const awaiting = await awaitingCustomerSigners(contractId);
  if (!awaiting.length) return [];
  const ticked = new Set((Array.isArray(coversSignerIds) ? coversSignerIds : []).map(Number).filter(Number.isFinite));
  const known = new Set(awaiting.map((r) => Number(r.id)));
  const unknown = [...ticked].filter((id) => !known.has(id));
  if (unknown.length) {
    throw new AppError('Those signers don\'t belong to this contract.', 400, 'SIGNER_NOT_FOUND');
  }
  const missing = awaiting.filter((r) => !ticked.has(Number(r.id))).map((r) => Number(r.id));
  if (missing.length) {
    const err = new AppError(
      'Confirm which signers the uploaded copy carries. Every signer who hasn\'t signed yet has to be covered by it.',
      400, 'SIGNERS_NOT_COVERED',
    );
    err.details = { missingSignerIds: missing };
    throw err;
  }
  return awaiting.map((r) => Number(r.id));
}

/** A wet-signed upload on a v2 contract: logged, and every link withdrawn. */
async function recordWetUpload(contractId, { by, sha256: fileSha, coversSignerIds = null, uploadedByAdminId = null }) {
  await db.transaction(async (trx) => {
    await signers.revokeAccess(trx, contractId);
    await auditedUpdate(trx, 'contracts', { id: contractId }, { sealed_at: new Date().toISOString() },
      { actor: by === 'admin' ? { type: 'admin' } : { type: 'customer' }, source: 'contract.upload.signed_pdf' });
    await signingEvents.appendEvent(trx, contractId, {
      type: 'wet_upload',
      actorType: by === 'admin' ? 'admin' : 'signer',
      artifactSha256: fileSha || null,
      // Ids only: the log is evidence of which slots the paper stands in
      // for, and it never carries names or addresses.
      payload: {
        by,
        ...(coversSignerIds ? { coversSignerIds } : {}),
        ...(uploadedByAdminId ? { uploadedByAdminId: Number(uploadedByAdminId) } : {}),
      },
    });
  });
}

// ---------------------------------------------------------------------
// Counter-signature and completion
// ---------------------------------------------------------------------

async function countersign(contractId, input, { ip = null, userAgent = null, adminId = null } = {}) {
  const contract = await db('contracts').where({ id: contractId }).first();
  if (!contract) throw new AppError('Contract not found', 404);
  if (contract.status !== 'signed_by_customer') {
    throw new AppError('Every customer has to sign before you counter-sign.', 409, 'CUSTOMERS_PENDING');
  }
  const { name, mode } = readSignature({ ...input, accepted: true }, false);
  await ensureContractEmailTemplatesSeeded(db, logger);
  const actor = await adminActor(adminId);
  const storedIp = await maybeStoreIp(ip);
  const fontOptions = await stampFontOptions();
  const dateFormat = await readDateFormat();
  const locale = contract.language || 'de';
  const { t } = pdfInternals();
  const signaturePath = mode === 'drawn' ? await persistSignatureImage(contract, 'admin', input.signatureDataUrl) : null;
  const imageBytes = signaturePath ? fs.readFileSync(signaturePath) : null;
  const signedAt = new Date();
  let written = null;

  let finalSha;
  try {
    finalSha = await db.transaction(async (trx) => {
      const current = await trx('contracts').where({ id: contractId }).forUpdate().first();
      if (current.status !== 'signed_by_customer') {
        throw new AppError('Every customer has to sign before you counter-sign.', 409, 'CUSTOMERS_PENDING');
      }
      const issuer = await trx('contract_signers').where({ contract_id: contractId, role: 'issuer' }).first();
      if (!issuer || issuer.status === 'signed') throw new AppError('This contract is already counter-signed.', 409, 'ALREADY_SIGNED');

      const base = currentPdf(current);
      const manifest = await unsignedManifest(contractId, trx);
      const slot = slotFrom(manifest, issuer.slot_key);
      let pdf = await pdfStampService.stampSlot({
        pdfBuffer: base,
        slot,
        imageBytes,
        typedName: mode === 'typed' ? name : null,
        captions: captionLines({ locale, name, signedAt, mode, via: 'admin', dateFormat }),
        fontOptions,
      });
      // The identifier band under the lowest slot row.
      const lowest = Math.max(...manifest.slots.map((s) => Number(s.captionY)));
      pdf = await pdfStampService.stampBand({
        pdfBuffer: pdf,
        page: slot.page,
        y: lowest + 52,
        text: t(locale, 'signature_band', {
          number: current.contract_number,
          sha: current.pdf_sha256 || '',
          content: current.rendered_content_sha256 || '',
        }),
        fontOptions,
      });
      const stored = await persistContractPdf(current, pdf, 'fully-signed', {
        kind: 'signed', conn: trx, templateVersionId: current.template_version_id,
      });
      written = stored.filePath;

      await trx('contract_signers').where({ id: issuer.id }).update({
        status: 'signed',
        signed_at: signedAt,
        name_enc: fieldEncryption.encrypt(name),
        verified_via: 'admin',
        verified_at: signedAt,
        signature_mode: mode,
        signature_path: signaturePath,
        signature_sha256: imageBytes ? sha256(imageBytes) : null,
        content_sha256: current.rendered_content_sha256 || null,
        document_sha256: sha256(base),
        ip_enc: storedIp !== null ? fieldEncryption.encrypt(ip) : null,
        user_agent_enc: storedIp !== null && userAgent ? fieldEncryption.encrypt(String(userAgent).slice(0, 512)) : null,
        updated_at: signedAt,
      });
      await auditedUpdate(trx, 'contracts', { id: contractId }, {
        status: 'fully_signed',
        signed_by_admin_at: signedAt,
        signed_admin_name: name,
        signed_admin_signature_path: signaturePath,
        signed_pdf_path: stored.filePath,
        signed_pdf_sha256: stored.sha256,
        sealed_at: signedAt,
        updated_at: signedAt,
      }, { actor: adminId, source: 'contract.sign.admin' });
      await signingEvents.appendEvent(trx, contractId, {
        type: 'countersigned', actorType: 'admin', actorLabel: actor.name || name, signerId: issuer.id,
        artifactSha256: stored.sha256, payload: { mode, slot: issuer.slot_key, documentSha256: sha256(base) },
      });
      await signingEvents.appendEvent(trx, contractId, {
        type: 'completed', actorType: 'system', artifactSha256: stored.sha256, payload: { signedPdfSha256: stored.sha256 },
      });
      // Sealed: the certificate names this chain head, so no held link may
      // append to the chain afterwards.
      await signers.revokeAccess(trx, contractId);
      return stored.sha256;
    });
  } catch (err) {
    // Nothing committed, so the files this attempt wrote are orphans.
    removeQuietly(signaturePath);
    removeQuietly(written);
    throw err;
  }

  // Sealed: the contract row points at the signed PDF and the admin's
  // signature, so nothing below may delete them.
  try {
    const certificatePath = await issueCertificate(contractId, finalSha);
    if (!certificatePath) throw new Error('the signing certificate could not be built');
    await sendCompletedEmails(contractId, certificatePath);
    await emitContractEvent(contract, 'signed');
    await clearFollowUpFailure(contractId);
  } catch (err) {
    await recordFollowUpFailure(contractId, 'completion', err);
  }
  await bestEffortLog('contract_fully_signed', { contractId }, actor);
  return { status: 'fully_signed', signedAt };
}

/** The signing certificate, stored with its record. Returns its path (null on failure). */
async function issueCertificate(contractId, signedSha) {
  try {
    const contract = await db('contracts').where({ id: contractId }).first();
    const rows = await signers.listSigners(contractId);
    const events = await signingEvents.listEvents(contractId);
    const chain = await signingEvents.verifyChain(contractId);
    const profile = (await db('business_profile').where({ id: 1 }).first()) || {};
    const fontOptions = await stampFontOptions();
    const { renderSigningCertificate } = require('../pdf/signingCertificate');
    const { buffer } = await renderSigningCertificate({
      contract,
      signers: rows.map((row) => ({
        role: row.role,
        name: signerName(row),
        email: row.role === 'customer' ? signerEmail(row) : null,
        verifiedVia: row.verified_via,
        signatureMode: row.signature_mode,
        signedAt: row.signed_at,
        documentSha256: row.document_sha256,
      })),
      events,
      hashes: { content: contract.rendered_content_sha256, unsigned: contract.pdf_sha256, signed: signedSha },
      chainHead: chain.head,
      locale: contract.language || 'de',
      theme: fontOptions.theme,
      issuer: { ...fontOptions.issuer, companyName: profile.company_name || null },
    });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const stored = await documentArtifactService.persist({
      docType: 'contract',
      docId: contractId,
      kind: 'audit',
      buffer,
      fileName: `${contract.contract_number}_certificate_${stamp}.pdf`,
      year: (contract.issue_date ? new Date(contract.issue_date) : new Date()).getFullYear(),
      manifest: { chainHead: chain.head, events: chain.count },
    });
    return stored.path;
  } catch (err) {
    logger.error('Failed to issue the signing certificate', { contractId, message: err.message });
    return null;
  }
}

/**
 * Both parties get the signed contract and its certificate. Failures are the
 * caller's to record (recordFollowUpFailure): swallowing them here left the
 * admin with a sealed contract, no email, and nothing on screen to say so.
 */
async function sendCompletedEmails(contractId, certificatePath) {
  {
    const contract = await db('contracts').where({ id: contractId }).first();
    const attachments = [{
      filename: `${contract.contract_number}-signed.pdf`, contentPath: contract.signed_pdf_path, contentType: 'application/pdf',
    }];
    if (certificatePath) {
      attachments.push({ filename: `${contract.contract_number}-certificate.pdf`, contentPath: certificatePath, contentType: 'application/pdf' });
    }
    const data = { contract_number: contract.contract_number, title: contract.title || '', attachments };
    const rows = await signers.listSigners(contractId);
    const sent = new Set();
    for (const row of rows.filter((r) => r.role === 'customer')) {
      const email = signerEmail(row);
      if (!email || sent.has(email)) continue;
      sent.add(email);
      await emailProcessor.queueEmail(null, email, 'contract_fully_signed', { ...data, customer_name: signerName(row) });
    }
    const profile = await db('business_profile').where({ id: 1 }).first();
    if (profile && profile.email && !sent.has(profile.email.toLowerCase())) {
      await emailProcessor.queueEmail(null, profile.email, 'contract_fully_signed', { ...data, customer_name: profile.company_name || 'Team' });
    }
  }
}

// ---------------------------------------------------------------------
// Portal and admin views
// ---------------------------------------------------------------------

/**
 * Signing from the customer portal: a v2 contract opens a session for the
 * signer with the customer's email (no code needed, decision #19); a
 * contract from before gets a fresh one-hour link.
 */
async function portalSigningAccess(customer, contractId) {
  const contract = await db('contracts').where({ id: contractId, customer_account_id: customer.id }).first();
  if (!contract || contract.status === 'draft') throw new AppError('Contract not found', 404);
  // A contract sent before signatures v2 signs on the portal's own page with
  // the customer's session (upstream #1465): no token reaches the browser.
  if (!isV2(contract)) {
    if (contract.status !== 'sent') throw new AppError('This contract is not waiting for your signature', 409, 'CONTRACT_NOT_SIGNABLE');
    return { mode: 'portal' };
  }
  // Only a contract still out for signature opens a session. A sealed one
  // would append a `verified` event and move the audit chain past the head
  // its already-issued certificate prints.
  if (contract.status !== 'sent') {
    throw new AppError('This contract is no longer waiting for your signature', 409, 'CONTRACT_NOT_SIGNABLE');
  }
  const emailHash = fieldEncryption.hashEmail(customer.email);
  const row = (await signers.listSigners(contract.id)).find((r) => r.role === 'customer' && r.email_hash === emailHash);
  if (!row) {
    throw new AppError('You are not a signer of this contract. Use the link from the signing email.', 403, 'SIGNER_NOT_FOUND');
  }
  const session = await openSession(contract.id, row, 'portal');
  return { mode: 'session', sessionToken: session.token, expiresAt: session.expiresAt };
}

async function adminOverview(contractId) {
  const contract = await db('contracts').where({ id: contractId }).first();
  if (!contract) throw new AppError('Contract not found', 404);
  const rows = await signers.listSigners(contractId);
  const events = await signingEvents.listEvents(contractId);
  return {
    version: contract.signing_version == null ? null : Number(contract.signing_version),
    order: contract.signing_order || 'parallel',
    // A step after a signature that failed and is worth an admin's attention.
    followUp: contract.follow_up_failed_at
      ? { failedAt: contract.follow_up_failed_at, error: contract.follow_up_error || null }
      : null,
    signers: rows.map(signers.signerToApi),
    events: events.map((e) => ({
      seq: e.seq, type: e.type, actorType: e.actorType, actorLabel: e.actorLabel, signerId: e.signerId,
      occurredAt: e.occurredAt, eventHash: e.eventHash, artifactSha256: e.artifactSha256,
    })),
    chain: events.length ? await signingEvents.verifyChain(contractId) : null,
  };
}

/** The encrypted evidence, decrypted — logged every time it's opened. */
async function revealEvidence(contractId, adminId) {
  const contract = await db('contracts').where({ id: contractId }).first();
  if (!contract) throw new AppError('Contract not found', 404);
  const rows = await signers.listSigners(contractId);
  await bestEffortLog('contract_signing_evidence_viewed', { contractId }, await adminActor(adminId));
  return rows.map((row) => ({
    signerId: row.id,
    name: signerName(row),
    ip: fieldEncryption.tryDecrypt(row.ip_enc),
    userAgent: fieldEncryption.tryDecrypt(row.user_agent_enc),
    declineReason: fieldEncryption.tryDecrypt(row.decline_reason_enc),
    signatureSha256: row.signature_sha256 || null,
    documentSha256: row.document_sha256 || null,
  }));
}

module.exports = {
  VERSION,
  isV2,
  slotsFor,
  prepareSend,
  completeSend,
  inviteDue,
  resendInvitation,
  revokeOnCancel,
  invitationSummary,
  requestCode,
  verifyCode,
  sessionView,
  sessionPdf,
  wetUploadContext,
  sessionAttachment,
  sessionContext,
  sign,
  decline,
  awaitingCustomerSigners,
  assertPaperCoversSigners,
  electronicSignaturePresent,
  recordWetUpload,
  countersign,
  issueCertificate,
  clearFollowUpFailure,
  portalSigningAccess,
  adminOverview,
  revealEvidence,
  _internal: { formatSignedAt, captionLines },
};
