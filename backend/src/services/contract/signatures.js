// Extracted verbatim from contractService.js — see ../contractService.js for the
// module-level overview. Do not add behavior here without updating the entry re-exports.

const fs = require('fs');
const { db, logActivity } = require('../../database/db');
const logger = require('../../utils/logger');
const { getAppSetting } = require('../../utils/appSettings');
const { AppError } = require('../../utils/errors');
const { hasColumnCached } = require('../../utils/schemaCache');
const businessProfileService = require('../businessProfileService');
const pdfStampService = require('../pdfStampService');
const emailProcessor = require('../emailProcessor');
const { ensureContractEmailTemplatesSeeded } = require('../contractEmailTemplates');
const { getFrontendBaseUrl } = require('../../utils/frontendUrl');
const { adminActor, customerPublicActor, emitContractEvent, maybeStoreIp } = require('./helpers');
const { buildSignatureStamps, persistAuditCertificate, persistContractPdf, persistSignatureImage, sha256OfFile } = require('./signatureAssets');
const { getContractById } = require('./crud');


/**
 * Record a customer's in-browser signature (canvas + typed name +
 * "I accept" checkbox). Validates the token, persists the signature
 * PNG, re-renders the PDF with the signature stamped, flips status
 * to `signed_by_customer`, and queues the admin notification email.
 */
async function recordCustomerSignature({ token, name, ip, signatureDataUrl, accepted }) {
  // Self-heal contract email templates. The contract_signed_admin_notification
  // email fires from this function — if its row is missing, the admin
  // never learns the customer signed.
  await ensureContractEmailTemplatesSeeded(db, logger);

  if (accepted !== true) {
    throw new AppError('You must confirm that you have read and agree to the terms.', 400, 'TOS_REQUIRED');
  }
  if (!name || !String(name).trim()) {
    throw new AppError('Your name is required.', 400, 'NAME_REQUIRED');
  }
  // Server-side guard for the "require drawn signature" admin toggle.
  // The public sign page also enforces this client-side, but the
  // server is the source of truth — a malicious caller posting
  // directly to /sign with a blank signatureDataUrl would otherwise
  // bypass the requirement.
  const requireDrawn = await getAppSetting('crm_contracts_require_drawn_signature');
  if (requireDrawn === true && (!signatureDataUrl || !String(signatureDataUrl).trim())) {
    throw new AppError(
      'A drawn signature is required for this contract — typing your name alone is not sufficient.',
      400, 'SIGNATURE_REQUIRED',
    );
  }
  const tokenRow = await db('contract_action_tokens').where({ token }).first();
  if (!tokenRow) throw new AppError('Token not found', 404);
  if (tokenRow.expires_at && new Date(tokenRow.expires_at).getTime() < Date.now()) {
    throw new AppError('This signing link has expired', 410);
  }
  if (tokenRow.used_at) {
    throw new AppError('This contract has already been signed', 410, 'TOKEN_ALREADY_USED');
  }

  const contract = await db('contracts').where({ id: tokenRow.contract_id }).first();
  if (!contract) throw new AppError('Contract not found', 404);
  if (!['sent'].includes(contract.status)) {
    throw new AppError(`Contract cannot be signed in status '${contract.status}'`, 409);
  }

  const signaturePath = signatureDataUrl
    ? await persistSignatureImage(contract, 'customer', signatureDataUrl)
    : null;

  const now = new Date();
  // Resolve the IP gate ONCE before the transaction so both writes
  // (contracts row + tokens row) agree. Setting flip mid-transaction
  // can't happen anyway, but doing it upfront keeps the data
  // consistent and saves a redundant read.
  const persistedIp = await maybeStoreIp(ip);
  try {
    await db.transaction(async (trx) => {
      await trx('contracts').where({ id: contract.id }).update({
        status: 'signed_by_customer',
        signed_by_customer_at: now,
        signed_customer_name: String(name).trim(),
        signed_customer_ip: persistedIp,
        signed_customer_signature_path: signaturePath,
        updated_at: now,
      });
      await trx('contract_action_tokens').where({ id: tokenRow.id }).update({
        used_at: now,
        used_action: 'signed_by_customer',
        used_ip: persistedIp,
      });
    });
  } catch (txErr) {
    // C.7 — clean up the orphan signature PNG we wrote before the
    // transaction. The DB rollback already undid the contract +
    // token writes; the file would otherwise sit forever in
    // storage/business-docs/contract/.../signatures/. Best-effort
    // unlink — if the cleanup itself fails, log and re-throw the
    // original transaction error so the caller still sees the real
    // failure cause.
    if (signaturePath) {
      try {
        if (fs.existsSync(signaturePath)) fs.unlinkSync(signaturePath);
      } catch (cleanupErr) {
        logger.warn('Orphan signature PNG cleanup failed', {
          path: signaturePath, message: cleanupErr.message,
        });
      }
    }
    throw txErr;
  }

  // Stamp the customer's signature onto the UNSIGNED PDF on disk.
  // Byte-immutable approach (see pdfStampService): we read pdf_path
  // (the immutable as-sent PDF), stamp the customer's signature PNG
  // at the fixed coordinates on the signature page, save as a new
  // timestamped file, and update signed_pdf_path. Original file
  // stays untouched on disk.
  const refreshed = await getContractById(contract.id);
  try {
    if (!refreshed.contract.pdf_path || !fs.existsSync(refreshed.contract.pdf_path)) {
      throw new Error(`Unsigned PDF missing on disk at ${refreshed.contract.pdf_path}`);
    }
    const originalPdfBuffer = fs.readFileSync(refreshed.contract.pdf_path);
    const stampedBuffer = await pdfStampService.stampSignature({
      pdfBuffer: originalPdfBuffer,
      signaturePngPath: signaturePath,
      role: 'customer',
      caption: {
        name: String(name).trim(),
        signedAt: now,
        nameLabel: refreshed.contract.language === 'de' ? 'Name' : 'Name',
        dateLabel: refreshed.contract.language === 'de' ? 'Datum' : 'Date',
      },
    });
    const { filePath: signedPath, sha256: signedSha256 } = await persistContractPdf(
      refreshed.contract, stampedBuffer, 'signed-by-customer',
    );
    const hasSignedPdfSha = await hasColumnCached('contracts', 'signed_pdf_sha256');
    const updates = {
      signed_pdf_path: signedPath,
      updated_at: new Date(),
    };
    if (hasSignedPdfSha) updates.signed_pdf_sha256 = signedSha256;
    // Migration 136 — clear any pre-existing render-failed marker; the
    // most recent stamp attempt just succeeded.
    if (await hasColumnCached('contracts', 'signed_pdf_render_failed_at')) {
      updates.signed_pdf_render_failed_at = null;
      updates.signed_pdf_render_error = null;
    }
    await db('contracts').where({ id: contract.id }).update(updates);
  } catch (err) {
    // Signature recorded; PDF re-render is best-effort. The admin can
    // re-render manually from the detail page if this fails. Logged as
    // error (not warn) so persistent failures surface in monitoring.
    logger.error('Failed to re-render contract PDF after customer signature', {
      contractId: contract.id,
      message: err.message,
      stack: err.stack,
    });
    // Migration 136 — surface the failure on the contract row so the
    // admin detail page can render a recovery banner instead of the
    // admin only discovering this through monitoring. err.message is
    // truncated to 2 KB; the full stack stays in server logs.
    try {
      if (await hasColumnCached('contracts', 'signed_pdf_render_failed_at')) {
        await db('contracts').where({ id: contract.id }).update({
          signed_pdf_render_failed_at: new Date(),
          signed_pdf_render_error: String(err.message || 'Unknown error').slice(0, 2048),
          updated_at: new Date(),
        });
      }
    } catch (markErr) {
      // Marker write itself failed — log + swallow so the customer
      // sign response still succeeds. The orphan stays orphan but
      // we've at least surfaced both errors.
      logger.error('Failed to record signed_pdf_render_failed marker', {
        contractId: contract.id, message: markErr.message,
      });
    }
  }

  // Notify admin.
  const customer = await db('customer_accounts').where({ id: contract.customer_account_id }).first();
  const frontendUrl = (await getFrontendBaseUrl()) || 'http://localhost:3000';
  try {
    await emailProcessor.queueEmail(null, null, 'contract_signed_admin_notification', {
      contract_number: contract.contract_number,
      customer_email: customer?.email || '',
      signed_customer_name: String(name).trim(),
      admin_dashboard_url: `${frontendUrl}/admin/clients/contracts/${contract.id}`,
    });
  } catch (err) {
    logger.warn('Failed to queue admin notification after customer signature', {
      contractId: contract.id, error: err.message,
    });
  }

  try {
    await logActivity('contract_signed_by_customer', { contractId: contract.id, token }, null, customerPublicActor());
  } catch (_) { /* logging is best-effort */ }

  return { status: 'signed_by_customer', signedAt: now };
}

/**
 * Admin counter-signature. Bumps status to `fully_signed` (or
 * `signed_by_admin` if the customer hasn't signed yet — edge case
 * where admin signs first, e.g. issuer-side framework agreement).
 */
async function recordAdminCountersignature(contractId, { name, ip, signatureDataUrl }, adminId) {
  // Self-heal: ensure the contract_fully_signed template exists
  // before we counter-sign. The dual-party send fires from this
  // function on the fully_signed transition; without the template
  // it silently fails and the customer never receives the PDF.
  await ensureContractEmailTemplatesSeeded(db, logger);

  if (!name || !String(name).trim()) {
    throw new AppError('Your name is required.', 400, 'NAME_REQUIRED');
  }
  const contract = await db('contracts').where({ id: contractId }).first();
  if (!contract) throw new AppError('Contract not found', 404);
  if (!['signed_by_customer', 'sent'].includes(contract.status)) {
    throw new AppError(`Cannot counter-sign a contract with status '${contract.status}'`, 409);
  }

  const signaturePath = signatureDataUrl
    ? await persistSignatureImage(contract, 'admin', signatureDataUrl)
    : null;

  const now = new Date();
  const newStatus = contract.status === 'signed_by_customer' ? 'fully_signed' : 'signed_by_admin';
  const persistedAdminIp = await maybeStoreIp(ip);
  try {
    await db('contracts').where({ id: contract.id }).update({
      status: newStatus,
      signed_by_admin_at: now,
      signed_admin_name: String(name).trim(),
      signed_admin_ip: persistedAdminIp,
      signed_admin_signature_path: signaturePath,
      updated_at: now,
    });
  } catch (updateErr) {
    // C.7 — clean up the orphan signature PNG if the contract row
    // update threw. Best-effort; log on cleanup failure and re-throw
    // the original update error.
    if (signaturePath) {
      try {
        if (fs.existsSync(signaturePath)) fs.unlinkSync(signaturePath);
      } catch (cleanupErr) {
        logger.warn('Orphan admin signature PNG cleanup failed', {
          path: signaturePath, message: cleanupErr.message,
        });
      }
    }
    throw updateErr;
  }

  // Stamp the admin's signature ON TOP of whatever signed_pdf_path
  // currently holds (the customer-stamped PDF, in the normal flow)
  // — or directly onto the unsigned pdf_path if the admin is the
  // first to sign (edge case). Byte-immutable: each prior PDF stays
  // on disk; the new file is a fresh timestamped version.
  const refreshed = await getContractById(contract.id);
  let signedPath = null;
  let signedSha256 = null;
  try {
    const baseFile = (refreshed.contract.signed_pdf_path && fs.existsSync(refreshed.contract.signed_pdf_path))
      ? refreshed.contract.signed_pdf_path
      : refreshed.contract.pdf_path;
    if (!baseFile || !fs.existsSync(baseFile)) {
      throw new Error(`Contract base PDF missing on disk for stamping (signed_pdf_path=${refreshed.contract.signed_pdf_path}, pdf_path=${refreshed.contract.pdf_path})`);
    }
    const baseBuffer = fs.readFileSync(baseFile);
    const stampedBuffer = await pdfStampService.stampSignature({
      pdfBuffer: baseBuffer,
      signaturePngPath: signaturePath,
      role: 'admin',
      caption: {
        name: String(name).trim(),
        signedAt: now,
        nameLabel: refreshed.contract.language === 'de' ? 'Name' : 'Name',
        dateLabel: refreshed.contract.language === 'de' ? 'Datum' : 'Date',
      },
    });
    const suffix = newStatus === 'fully_signed' ? 'fully-signed' : 'signed-by-admin';
    const persisted = await persistContractPdf(refreshed.contract, stampedBuffer, suffix);
    signedPath = persisted.filePath;
    signedSha256 = persisted.sha256;
    const hasSignedPdfSha = await hasColumnCached('contracts', 'signed_pdf_sha256');
    const updates = {
      signed_pdf_path: signedPath,
      updated_at: new Date(),
    };
    if (hasSignedPdfSha) updates.signed_pdf_sha256 = signedSha256;
    if (await hasColumnCached('contracts', 'signed_pdf_render_failed_at')) {
      updates.signed_pdf_render_failed_at = null;
      updates.signed_pdf_render_error = null;
    }
    await db('contracts').where({ id: contract.id }).update(updates);
  } catch (err) {
    logger.error('Failed to stamp contract PDF after admin signature', {
      contractId: contract.id,
      newStatus,
      message: err.message,
      stack: err.stack,
    });
    // Migration 136 — mirror the customer-sign branch: persist a
    // recovery marker so the admin detail page can surface a banner.
    try {
      if (await hasColumnCached('contracts', 'signed_pdf_render_failed_at')) {
        await db('contracts').where({ id: contract.id }).update({
          signed_pdf_render_failed_at: new Date(),
          signed_pdf_render_error: String(err.message || 'Unknown error').slice(0, 2048),
          updated_at: new Date(),
        });
      }
    } catch (markErr) {
      logger.error('Failed to record signed_pdf_render_failed marker (admin sign)', {
        contractId: contract.id, message: markErr.message,
      });
    }
  }

  // When the admin's signature is what FINALISED the contract (i.e.
  // status flipped to fully_signed), email a copy of the freshly
  // re-rendered PDF to both parties. We send two separate queueEmail
  // calls so each recipient gets the email rendered with their own
  // greeting + name. The admin BCC is delivered as "to the issuer"
  // so it lands in the same inbox the contract_sent email originated
  // from.
  if (newStatus === 'fully_signed') {
    try {
      // Pick the best available PDF as the attachment, in priority
      // order: this counter-sign's freshly-rendered signed copy →
      // the customer-only signed copy we wrote earlier → the
      // original unsigned PDF. Falling all the way through to no
      // attachment is acceptable; the email still goes out with the
      // contract number so the customer knows it's binding.
      const refetched = await db('contracts').where({ id: contract.id }).first();
      const attachmentPath = signedPath
        || refetched?.signed_pdf_path
        || refetched?.pdf_path
        || null;

      const customer = await db('customer_accounts').where({ id: contract.customer_account_id }).first();
      const profile = (await businessProfileService.getProfile()).profile || {};
      const adminRow = await db('admin_users').where({ id: adminId }).first();
      const customerName = customer?.display_name
        || [customer?.first_name, customer?.last_name].filter(Boolean).join(' ')
        || customer?.email?.split('@')[0]
        || '';
      // Generate the audit certificate as a SIBLING document (separate
      // PDF) and attach it alongside the stamped contract. Audit cert
      // captures timestamps, IPs, names, and SHA-256 hashes — the legal
      // provenance record. Reproducible from contract data so safe to
      // regenerate on demand; we still persist a copy to disk for the
      // forensic trail.
      const auditCertPath = await persistAuditCertificate(refetched || refreshed.contract);

      const attachments = [];
      if (attachmentPath) {
        attachments.push({
          filename: `${refreshed.contract.contract_number}-signed.pdf`,
          contentPath: attachmentPath,
          contentType: 'application/pdf',
        });
      }
      if (auditCertPath) {
        attachments.push({
          filename: `${refreshed.contract.contract_number}-audit.pdf`,
          contentPath: auditCertPath,
          contentType: 'application/pdf',
        });
      }
      const attachmentsArg = attachments.length > 0 ? attachments : undefined;

      // 1. Customer copy
      if (customer?.email) {
        await emailProcessor.queueEmail(null, customer.email, 'contract_fully_signed', {
          contract_number: refreshed.contract.contract_number,
          customer_name: customerName,
          title: refreshed.contract.title || '',
          attachments: attachmentsArg,
        });
      }
      // 2. Admin copy. Prefer business_profile.email (the inbox the
      // contract was sent FROM); fall back to the counter-signing
      // admin's account email so the audit trail still reaches a
      // human even on installs where business_profile.email is blank.
      const adminEmail = profile.email || adminRow?.email;
      if (adminEmail && adminEmail !== customer?.email) {
        await emailProcessor.queueEmail(null, adminEmail, 'contract_fully_signed', {
          contract_number: refreshed.contract.contract_number,
          customer_name: profile.company_name || adminRow?.first_name || 'Team',
          title: refreshed.contract.title || '',
          attachments: attachmentsArg,
        });
      }
    } catch (err) {
      logger.error('Failed to send contract_fully_signed emails', {
        contractId: contract.id,
        message: err.message,
        stack: err.stack,
      });
    }
  }

  try {
    await logActivity(`contract_${newStatus}`, { contractId: contract.id }, null, await adminActor(adminId));
  } catch (_) { /* logging is best-effort */ }

  // The binding moment — fire contract.signed once the contract is fully signed
  // (matches the editor's trigger). Best-effort / fail-closed.
  if (newStatus === 'fully_signed') await emitContractEvent(contract, 'signed');

  return { status: newStatus, signedAt: now };
}

/**
 * Attach a wet-signed PDF as the authoritative signed copy. Either
 * party can upload (admin via admin route, customer via public token
 * route). When the customer uploads, status flips to `fully_signed`
 * because the wet signature is treated as a full agreement (admin
 * would normally also sign the wet copy before sending it to the
 * customer).
 */
async function attachSignedPdfUpload(contractId, filePath, uploaderRole) {
  // Self-heal contract email templates — same reason as the
  // sendContract + recordAdminCountersignature paths.
  await ensureContractEmailTemplatesSeeded(db, logger);

  if (!filePath) throw new AppError('No file uploaded', 400);
  const contract = await db('contracts').where({ id: contractId }).first();
  if (!contract) throw new AppError('Contract not found', 404);
  if (['cancelled', 'draft'].includes(contract.status)) {
    throw new AppError(`Cannot attach a signed PDF to a contract in status '${contract.status}'`, 409);
  }

  const now = new Date();
  const updates = {
    signed_pdf_path: filePath,
    status: 'fully_signed',
    updated_at: now,
  };
  // Migration 135 — durable wet-upload discriminator. Persists the
  // "this row holds an authoritative wet upload, do not auto-overwrite"
  // signal as a column rather than inferring from the file path. See
  // the migration body for the full rationale.
  if (await hasColumnCached('contracts', 'signed_pdf_is_wet_upload')) {
    updates.signed_pdf_is_wet_upload = true;
  }
  // Hash the uploaded PDF on disk so we can later prove it wasn't
  // tampered with after upload. Multer wrote the file synchronously
  // before this handler runs, so reading it here is safe.
  if (await hasColumnCached('contracts', 'signed_pdf_sha256')) {
    updates.signed_pdf_sha256 = sha256OfFile(filePath);
  }
  if (uploaderRole === 'customer' && !contract.signed_by_customer_at) {
    updates.signed_by_customer_at = now;
  }
  if (uploaderRole === 'admin' && !contract.signed_by_admin_at) {
    updates.signed_by_admin_at = now;
  }
  await db('contracts').where({ id: contractId }).update(updates);

  // attachSignedPdfUpload always transitions to fully_signed (see
  // updates.status above), so the dual-party send fires here too —
  // same pattern as recordAdminCountersignature. The uploaded PDF
  // IS the authoritative copy so we attach it directly.
  try {
    const refreshedContract = await db('contracts').where({ id: contractId }).first();
    const customer = await db('customer_accounts').where({ id: refreshedContract.customer_account_id }).first();
    const profile = (await businessProfileService.getProfile()).profile || {};
    const customerName = customer?.display_name
      || [customer?.first_name, customer?.last_name].filter(Boolean).join(' ')
      || customer?.email?.split('@')[0]
      || '';
    const attachments = [{
      filename: `${refreshedContract.contract_number}-signed.pdf`,
      contentPath: filePath,
      contentType: 'application/pdf',
    }];
    // Sibling audit certificate — same legal-provenance record as the
    // in-browser sign path. Best-effort; missing cert doesn't block the
    // wet-signed PDF from reaching the parties.
    const auditCertPath = await persistAuditCertificate(refreshedContract);
    if (auditCertPath) {
      attachments.push({
        filename: `${refreshedContract.contract_number}-audit.pdf`,
        contentPath: auditCertPath,
        contentType: 'application/pdf',
      });
    }
    if (customer?.email) {
      await emailProcessor.queueEmail(null, customer.email, 'contract_fully_signed', {
        contract_number: refreshedContract.contract_number,
        customer_name: customerName,
        title: refreshedContract.title || '',
        attachments,
      });
    }
    if (profile.email && profile.email !== customer?.email) {
      await emailProcessor.queueEmail(null, profile.email, 'contract_fully_signed', {
        contract_number: refreshedContract.contract_number,
        customer_name: profile.company_name || 'Team',
        title: refreshedContract.title || '',
        attachments,
      });
    }
  } catch (err) {
    logger.warn('Failed to send contract_fully_signed emails after PDF upload', {
      contractId, error: err.message,
    });
  }

  try {
    await logActivity('contract_signed_pdf_uploaded', { contractId, uploaderRole }, null,
      uploaderRole === 'admin' ? { type: 'admin', name: 'Admin (PDF upload)' } : customerPublicActor());
  } catch (_) { /* logging is best-effort */ }

  await emitContractEvent(contract, 'signed');

  return { status: 'fully_signed', signedPdfPath: filePath };
}

/**
 * Recovery helper: re-render the signed PDF + resend the
 * contract_fully_signed email to both parties. Used by the admin
 * detail page when:
 *   - a previous render silently failed (signed_pdf_path is empty
 *     on a fully_signed contract)
 *   - the customer reports they didn't receive the email
 *   - the bodies of the seeded blocks were updated post-signing and
 *     the admin wants the latest text on file
 *
 * Only available on fully_signed contracts. The wet-signed PDF path
 * is preserved: when signed_pdf_path already points at an uploaded
 * file (not a re-render path) we DO NOT overwrite — the uploaded PDF
 * is the authoritative copy. We still resend the email with that
 * uploaded PDF as the attachment.
 */
async function rerenderAndResend(contractId, adminId) {
  // Self-heal contract email templates. This is the most likely
  // recovery path the admin reaches when a prior dual-party send
  // failed silently — including when the failure was caused by the
  // template being missing in the first place.
  const newlySeeded = await ensureContractEmailTemplatesSeeded(db, logger);
  if (newlySeeded.length > 0) {
    logger.warn('rerenderAndResend self-healed missing email templates', {
      contractId, seeded: newlySeeded,
    });
  }

  const contract = await db('contracts').where({ id: contractId }).first();
  if (!contract) throw new AppError('Contract not found', 404);
  if (contract.status !== 'fully_signed') {
    throw new AppError(
      `Re-send is only available on fully-signed contracts (status: ${contract.status})`,
      409, 'NOT_FULLY_SIGNED',
    );
  }

  let attachmentPath = contract.signed_pdf_path || null;
  // Migration 135 — `signed_pdf_is_wet_upload` is the durable
  // authoritative-source discriminator. It's set TRUE only by
  // attachSignedPdfUpload, so any non-wet path here is a system
  // stamp safe to replace. We still null-check the path so missing
  // (re-stamp recovery) cases trigger the re-stamp branch below.
  const hasWetFlagColumn = await hasColumnCached('contracts', 'signed_pdf_is_wet_upload');
  const isWetSignedUpload = hasWetFlagColumn
    ? (contract.signed_pdf_is_wet_upload === true || contract.signed_pdf_is_wet_upload === 1)
    // Fallback ONLY for installs where the migration hasn't applied yet:
    // preserve the historical substring rule so we don't accidentally
    // overwrite uploads on an un-migrated DB.
    : !!(attachmentPath && attachmentPath.includes('uploads/contracts/signed'));
  if (!attachmentPath || !isWetSignedUpload) {
    // Stamp signatures onto the immutable unsigned pdf_path using
    // pdf-lib (NOT a full re-render). This preserves the exact bytes
    // the customer originally agreed to and side-steps the silent re-
    // render failure that left signed_pdf_path NULL on prior contracts.
    const refreshed = await getContractById(contract.id);
    if (!refreshed.contract.pdf_path || !fs.existsSync(refreshed.contract.pdf_path)) {
      throw new AppError(
        `Unsigned PDF missing on disk at ${refreshed.contract.pdf_path}; cannot re-stamp.`,
        500, 'UNSIGNED_PDF_MISSING',
      );
    }
    const originalBuffer = fs.readFileSync(refreshed.contract.pdf_path);
    const stamps = buildSignatureStamps(refreshed.contract);
    const { buffer: stampedBuffer, sha256: signedSha256 } =
      await pdfStampService.stampSignatures(originalBuffer, stamps);
    const persisted = await persistContractPdf(refreshed.contract, stampedBuffer, 'fully-signed');
    attachmentPath = persisted.filePath;
    const hasSignedPdfSha = await hasColumnCached('contracts', 'signed_pdf_sha256');
    const updates = {
      signed_pdf_path: attachmentPath,
      updated_at: new Date(),
    };
    if (hasSignedPdfSha) updates.signed_pdf_sha256 = signedSha256;
    // Migration 136 — this branch is a recovery path; clear any
    // existing failed-render marker.
    if (await hasColumnCached('contracts', 'signed_pdf_render_failed_at')) {
      updates.signed_pdf_render_failed_at = null;
      updates.signed_pdf_render_error = null;
    }
    await db('contracts').where({ id: contract.id }).update(updates);
  }

  // Resend the dual-party email with the now-guaranteed attachment.
  const refetched = await db('contracts').where({ id: contract.id }).first();
  const customer = await db('customer_accounts').where({ id: refetched.customer_account_id }).first();
  const profile = (await businessProfileService.getProfile()).profile || {};
  const adminRow = await db('admin_users').where({ id: adminId }).first();
  const customerName = customer?.display_name
    || [customer?.first_name, customer?.last_name].filter(Boolean).join(' ')
    || customer?.email?.split('@')[0]
    || '';
  // Sibling audit certificate (timestamps + IPs + hashes). Best-effort:
  // missing certificate doesn't block the email — the stamped contract
  // alone is the primary attachment.
  const auditCertPath = await persistAuditCertificate(refetched);

  const attachments = [{
    filename: `${refetched.contract_number}-signed.pdf`,
    contentPath: attachmentPath,
    contentType: 'application/pdf',
  }];
  if (auditCertPath) {
    attachments.push({
      filename: `${refetched.contract_number}-audit.pdf`,
      contentPath: auditCertPath,
      contentType: 'application/pdf',
    });
  }

  if (customer?.email) {
    await emailProcessor.queueEmail(null, customer.email, 'contract_fully_signed', {
      contract_number: refetched.contract_number,
      customer_name: customerName,
      title: refetched.title || '',
      attachments,
    });
  }
  const adminEmail = profile.email || adminRow?.email;
  if (adminEmail && adminEmail !== customer?.email) {
    await emailProcessor.queueEmail(null, adminEmail, 'contract_fully_signed', {
      contract_number: refetched.contract_number,
      customer_name: profile.company_name || adminRow?.first_name || 'Team',
      title: refetched.title || '',
      attachments,
    });
  }

  try {
    await logActivity('contract_resent_signed', { contractId }, null, await adminActor(adminId));
  } catch (_) { /* logging is best-effort */ }

  return { signedPdfPath: attachmentPath, resent: true };
}

/**
 * Recovery helper: admin re-stamps signatures (customer and/or admin)
 * on a contract whose signature_path columns are null/broken because
 * the original sign happened before the canvas worked correctly.
 *
 * The admin draws BOTH signatures on the detail page — the customer's
 * signature is admin-attested in this flow (the customer already
 * agreed via the original sign; this just makes the PDF show
 * something). Original signed_by_*_at + signed_*_name + signed_*_ip
 * stay untouched; only the *_signature_path columns + the rendered
 * PDF get refreshed.
 *
 * Available on contracts in status:
 *   signed_by_customer (re-stamp customer, optionally admin too)
 *   signed_by_admin    (re-stamp admin, optionally customer too)
 *   fully_signed       (re-stamp either or both)
 */
async function restampSignatures(contractId, { customerSignatureDataUrl, adminSignatureDataUrl }, adminId) {
  const contract = await db('contracts').where({ id: contractId }).first();
  if (!contract) throw new AppError('Contract not found', 404);
  if (!['signed_by_customer', 'signed_by_admin', 'fully_signed'].includes(contract.status)) {
    throw new AppError(
      `Cannot re-stamp signatures on a contract in status '${contract.status}'.`,
      409, 'WRONG_STATUS',
    );
  }
  if (!customerSignatureDataUrl && !adminSignatureDataUrl) {
    throw new AppError('At least one signature data URL must be provided.', 400, 'NO_SIGNATURE');
  }

  const updates = { updated_at: new Date() };
  if (customerSignatureDataUrl) {
    updates.signed_customer_signature_path = await persistSignatureImage(contract, 'customer', customerSignatureDataUrl);
  }
  if (adminSignatureDataUrl) {
    updates.signed_admin_signature_path = await persistSignatureImage(contract, 'admin', adminSignatureDataUrl);
  }
  await db('contracts').where({ id: contract.id }).update(updates);

  // Re-stamp signature images onto the immutable unsigned pdf_path
  // using pdf-lib (NOT a full re-render). This is the recovery path
  // for contracts where signature images existed on disk but the
  // earlier re-render approach failed silently and left signed_pdf_path
  // NULL or pointing at a stale file. We always rebuild the stamp from
  // pdf_path (the as-sent bytes) so the result is reproducible from
  // the audit record.
  //
  // Wet-signed PDF uploads remain authoritative — if signed_pdf_path
  // already points at an uploaded PDF we still produce a stamped copy
  // on disk for the audit trail, but signed_pdf_path is not updated.
  const refreshed = await getContractById(contract.id);
  if (!refreshed.contract.pdf_path || !fs.existsSync(refreshed.contract.pdf_path)) {
    throw new AppError(
      `Unsigned PDF missing on disk at ${refreshed.contract.pdf_path}; cannot re-stamp.`,
      500, 'UNSIGNED_PDF_MISSING',
    );
  }
  const originalBuffer = fs.readFileSync(refreshed.contract.pdf_path);
  const stamps = buildSignatureStamps(refreshed.contract);
  const { buffer: stampedBuffer, sha256: signedSha256 } =
    await pdfStampService.stampSignatures(originalBuffer, stamps);
  const { filePath: signedPath } = await persistContractPdf(refreshed.contract, stampedBuffer,
    contract.status === 'fully_signed' ? 'fully-signed' : 'partially-signed');

  // Migration 135 — read the discriminator column. Fall back to the
  // historical substring rule only when the column is absent (un-
  // migrated install) so we never accidentally overwrite a wet upload.
  const hasWetFlagColumn = await hasColumnCached('contracts', 'signed_pdf_is_wet_upload');
  const isWetSignedUpload = hasWetFlagColumn
    ? (contract.signed_pdf_is_wet_upload === true || contract.signed_pdf_is_wet_upload === 1)
    : !!(contract.signed_pdf_path
      && contract.signed_pdf_path.includes('uploads/contracts/signed'));
  if (!isWetSignedUpload) {
    const hasSignedPdfSha = await hasColumnCached('contracts', 'signed_pdf_sha256');
    const updates = {
      signed_pdf_path: signedPath,
      updated_at: new Date(),
    };
    if (hasSignedPdfSha) updates.signed_pdf_sha256 = signedSha256;
    // Migration 136 — restamp is a recovery path; clear the marker.
    if (await hasColumnCached('contracts', 'signed_pdf_render_failed_at')) {
      updates.signed_pdf_render_failed_at = null;
      updates.signed_pdf_render_error = null;
    }
    await db('contracts').where({ id: contract.id }).update(updates);
  }

  try {
    await logActivity('contract_signatures_restamped', {
      contractId,
      stamped: {
        customer: !!customerSignatureDataUrl,
        admin: !!adminSignatureDataUrl,
      },
    }, null, await adminActor(adminId));
  } catch (_) { /* logging is best-effort */ }

  return {
    signedPdfPath: isWetSignedUpload ? contract.signed_pdf_path : signedPath,
    stamped: {
      customer: !!customerSignatureDataUrl,
      admin: !!adminSignatureDataUrl,
    },
  };
}

/**
 * Read the chronological audit trail for a contract from activity_logs.
 * Matches every `contract_*` activity_type where metadata.contractId
 * equals this contract's id. Ordered oldest → newest so the UI can
 * render a vertical timeline. Read-only; used by the admin detail
 * page's AuditTrailCard.
 */
async function getAuditTrail(contractId) {
  if (!(await db.schema.hasTable('activity_logs'))) return [];
  // Push the metadata.contractId filter into SQL instead of fetching
  // every contract_* row and filtering in JS. The previous shape
  // scanned the entire history every time the detail page loaded —
  // O(rows-since-CRM-launch) per request. Both Postgres and SQLite
  // store metadata as a JSON-encoded string here, so we match on
  // a literal substring that covers either compact or whitespaced
  // JSON encodings — `"contractId":<n>` or `"contractId": <n>` —
  // bounded by the activity_type prefix so the search hits the
  // contract_* slice of the index.
  //
  // The substring patterns intentionally don't anchor on word
  // boundaries; activity_logs.metadata never contains a contractId
  // key collision with another id-shaped value because logActivity
  // serialises only what callers pass.
  const id = Number(contractId);
  if (!Number.isFinite(id)) return [];
  const rows = await db('activity_logs')
    .where('activity_type', 'like', 'contract_%')
    .andWhere(function () {
      this.where('metadata', 'like', `%"contractId":${id}%`)
        .orWhere('metadata', 'like', `%"contractId": ${id}%`);
    })
    .orderBy('created_at', 'asc')
    .select('id', 'activity_type', 'actor_type', 'actor_id', 'actor_name', 'metadata', 'created_at');

  return rows.map((r) => {
    let meta = r.metadata;
    if (typeof meta === 'string') {
      try { meta = JSON.parse(meta); } catch { meta = {}; }
    }
    return { ...r, metadata: meta || {} };
  });
}

/**
 * Re-hash the two on-disk PDFs and compare against the stored hashes
 * (pdf_sha256 / signed_pdf_sha256 from migration 131). Lets the admin
 * confirm that backups, manual moves, or storage corruption haven't
 * silently altered the issued document.
 *
 * Each leg of the response carries:
 *   - `path`: the stored path string (so the UI can show what was
 *     checked even when it's missing)
 *   - `present`: file exists on disk
 *   - `expected`: the SHA-256 column value (null if never persisted)
 *   - `actual`: the freshly-computed hash, or null when file missing
 *   - `match`: true iff both hashes exist AND they're equal
 *
 * The customer already has both expected hashes via the audit
 * certificate the signing flow ships as a second email attachment, so
 * they can verify independently with `shasum -a 256`. This endpoint
 * is the admin-side equivalent — single click instead of dropping to
 * a shell.
 */
async function verifyIntegrity(id) {
  const contract = await db('contracts')
    .where({ id })
    .select('id', 'pdf_path', 'pdf_sha256', 'signed_pdf_path', 'signed_pdf_sha256')
    .first();
  if (!contract) throw new AppError('Contract not found', 404);

  const checkLeg = (filePath, expected) => {
    const present = !!filePath && fs.existsSync(filePath);
    const actual = present ? sha256OfFile(filePath) : null;
    return {
      path: filePath || null,
      present,
      expected: expected || null,
      actual,
      match: !!(expected && actual && expected === actual),
    };
  };

  return {
    unsigned: checkLeg(contract.pdf_path, contract.pdf_sha256),
    signed: checkLeg(contract.signed_pdf_path, contract.signed_pdf_sha256),
  };
}
module.exports = {
  recordCustomerSignature,
  recordAdminCountersignature,
  attachSignedPdfUpload,
  rerenderAndResend,
  restampSignatures,
  getAuditTrail,
  verifyIntegrity,
};
