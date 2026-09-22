// Extracted verbatim from contractService.js — see ../contractService.js for the
// module-level overview. Do not add behavior here without updating the entry re-exports.

const { db, logActivity } = require('../../database/db');
const logger = require('../../utils/logger');
const { AppError } = require('../../utils/errors');
const pdfService = require('../pdfService');
const { ensureContractEmailTemplatesSeeded } = require('../contractEmailTemplates');
const { adminActor, emitContractEvent, ensureCustomerActive } = require('./helpers');
const { buildRenderContext } = require('./renderContext');
const { persistContractPdf } = require('./signatureAssets');
const { getContractById } = require('./crud');


/**
 * Render PDF for a saved contract (preview before send, or re-render
 * after signing).
 */
async function renderContractPdfBuffer(contractId) {
  const data = await getContractById(contractId);
  if (!data) throw new AppError('Contract not found', 404);
  const ctx = await buildRenderContext(data.contract, data.inclusions, data.textSections);
  return await pdfService.renderContractToBuffer(ctx);
}

/**
 * Send the contract: snapshot every included block's body, render the PDF
 * with a signature slot per signer, persist it, and invite the signers
 * (signatures v2, #1446 — each signer gets their own link).
 */
const ensureIntOr = (v) => (v == null ? 1 : Number(v));

async function sendContract(id, adminId, { reviewToken = null, collectData = false } = {}) {
  // Ask the customer for their details first; this send runs once they have
  // (#1446, dataCollection.js).
  if (collectData) return require('./dataCollection').requestData(id, adminId);

  // Self-heal: dev installs that ran migration 130 BEFORE we added
  // contract_fully_signed to the seed list won't have all three
  // contract templates in email_templates. Insert any missing rows
  // before we queue the email. Idempotent + module-cached.
  await ensureContractEmailTemplatesSeeded(db, logger);

  const data = await getContractById(id);
  if (!data) throw new AppError('Contract not found', 404);
  const { contract } = data;

  if (!['draft', 'awaiting_data'].includes(contract.status)) {
    throw new AppError(`Cannot send a contract with status '${contract.status}'`, 409);
  }
  // A contract collecting the customer's details is frozen once they are in:
  // from the customer's submission, or the admin's retry after a failed one.
  const fromStatus = contract.status;
  if (fromStatus === 'awaiting_data' && !contract.data_collected_at) {
    throw new AppError('The customer hasn\'t completed their details yet.', 409, 'DATA_PENDING');
  }

  const customer = await db('customer_accounts').where({ id: contract.customer_account_id }).first();
  ensureCustomerActive(customer);

  // The signers (#1446): the ones set on the draft, or the contract's
  // customer; each gets a slot on the signature page, the issuer last.
  const signingV2 = require('./signingV2');
  const { rows: signerRows, slots: signatureSlots } = await signingV2.prepareSend(contract);
  // The customer and signers this send renders with: compared again, rows
  // locked, when the contract is marked sent (completeSend). Taken before the
  // review check below, so what that check read lies between the two reads.
  const sendInputs = await require('./signers').readSendInputsSha256(db, contract, { signerRows });

  const refreshed = await getContractById(id);

  // Sent from the pre-send review (#1445): only what was reviewed goes out.
  // Checked after `refreshed` is read, and the token covers the lock version:
  // a save between the two changes the token, and one after it fails the
  // lock claim in completeSend, which uses `refreshed`'s lock.
  if (reviewToken) {
    const { buildSendPreview } = require('./sendPreview');
    const current = await buildSendPreview(id);
    if (current.reviewToken !== reviewToken || current.lockVersion !== ensureIntOr(refreshed.contract.lock_version)) {
      throw new AppError('The contract changed since the review. Review it again before sending.', 409, 'CONTRACT_REVIEW_STALE');
    }
    // A problem that arose since (the customer deactivated) is not in the
    // token: the review's own errors refuse the send as the dialog would.
    const blocking = current.problems.filter((p) => p.severity === 'error');
    if (blocking.length) {
      throw new AppError(blocking.map((p) => p.message).join(' · '), 409, 'CONTRACT_REVIEW_STALE');
    }
  }

  // What the send freezes: every included block's body in every language
  // (#1445; only EN and DE were frozen before), plus the content — clauses,
  // title, intro, outro, this moment's placeholder values and the source
  // quote's line items and totals — with its sha256. The PDF, the signing
  // page and later re-renders read this.
  //
  // Built once, before the render, and the render reads it: the PDF is drawn
  // from the very object that is frozen, so the two cannot disagree. Rendered
  // from the bare draft instead, the PDF read the live line items and no
  // totals at all — only a stored snapshot carries them — so the unsigned PDF
  // named no sum while the signing page and every re-render did.
  //
  // It reaches the render in memory only; nothing is written to the draft
  // until completeSend. A send that fails at the attachment check used to
  // leave the snapshot on the draft, and the renderer prefers a snapshot:
  // later edits then never showed in the preview.
  //
  // completeSend writes it inside its transaction, against the draft's
  // lock_version, so it lands only if this send is the one that goes out: two
  // overlapping sends both pass the draft check above, and the loser's freeze
  // would otherwise be written over the winner's sent contract. The same
  // condition catches an edit saved between the render and the send, which
  // passed its own lock check but never reached the rendered PDF.
  const { snapshot, sha256: contentSha256 } = await require('./renderContext')
    .buildContentSnapshot(refreshed.contract, refreshed.inclusions, refreshed.textSections);
  const renderedContent = JSON.stringify(snapshot);
  const ctx = await buildRenderContext(
    { ...refreshed.contract, rendered_content: renderedContent },
    refreshed.inclusions,
    refreshed.textSections,
  );
  ctx.signatureSlots = signatureSlots;
  // The footers are drawn now, the attachments are merged after, so the page
  // numbers have to be told how many pages will land in between.
  ctx.mergedAttachmentPages = await require('./attachments').mergedPageCount(id);
  // Where each signature slot landed goes into the record (#1445).
  const { buffer: rendered, slots } = await pdfService.renderContractWithSlots(ctx);
  // Attachments (#1445): merged ones go between the body and the signature
  // page, separate ones are delivered next to the PDF; each is checked
  // against the sha256 the contract recorded for it.
  const attachments = require('./attachments');
  const sendable = await attachments.buildSendable(refreshed.contract, rendered, { slots });

  const content = require('./content');
  const freeze = {
    renderedContent,
    contentSha256,
    // The attachments that go with it — merged or separate — bound into the
    // signature beside the content (#1446).
    manifestSha256: attachments.manifestSha256(sendable.manifest),
    inclusions: refreshed.inclusions
      .filter((inc) => inc.included === true || inc.included === 1 || inc.included === '1')
      .map((inc) => ({
        id: inc.id,
        columns: content.snapshotColumns({
          ...content.blockBodies(inc, 'block_'),
          ...content.inclusionSnapshot(inc),
        }),
      })),
  };

  const { filePath: pdfPath, sha256: pdfSha256 } = await persistContractPdf(refreshed.contract, sendable.buffer, '', {
    kind: 'unsigned',
    theme: ctx.theme,
    issuer: ctx.issuer,
    templateVersionId: refreshed.contract.template_version_id,
    manifest: sendable.manifest,
    // The contract row does not carry this yet — completeSend writes it with
    // the status, after the PDF exists. Passing it means the log entry for
    // the send names the content the PDF was built from.
    contentSha256,
    actor: await adminActor(adminId),
  });

  // Marks the contract sent, starts the event log and emails each signer
  // who may sign now their own link. A failed invitation after the commit
  // doesn't throw: the contract is out, the failure is recorded, the hourly
  // sweep invites whoever is left pending, and the send answers with a
  // warning. (After collected details, the first signer below still hears
  // the contract is ready.)
  const { invited, invitationFailed } = await signingV2.completeSend(id, {
    pdfPath, pdfSha256, adminId, freeze, lockVersion: refreshed.contract.lock_version, sendInputs, fromStatus,
  });

  // A freeze that failed after the customer's details came in is done now.
  if (fromStatus === 'awaiting_data') await signingV2.clearFollowUpFailure(id, { steps: ['data_freeze'] });
  // The admin finishing that failed freeze: the first signer was told to
  // wait for an email, and still holds only the details link — they get a
  // new one to the contract now. (The customer's own submission freezes
  // with them on the page; their session opens the contract.)
  if (fromStatus === 'awaiting_data' && adminId) {
    const firsts = (await require('./signers').listSigners(id))
      .filter((row) => row.role === 'customer' && Number(row.position) === 1 && row.status === 'invited');
    for (const row of firsts) {
      try {
        await signingV2.resendInvitation(id, row.id, adminId);
      } catch (err) {
        await signingV2.recordFollowUpFailure(id, 'invitation', err);
      }
    }
  }

  try {
    await logActivity('contract_sent', { contractId: id, signersInvited: invited }, null, await adminActor(adminId));
  } catch (_) { /* logging is best-effort */ }

  await emitContractEvent(contract, 'sent');

  logger.info('Contract sent', { adminId, contractId: id });
  return invitationFailed ? { pdfPath, invited, invitationFailed: true } : { pdfPath, invited };
}
module.exports = {
  renderContractPdfBuffer,
  sendContract,
};
