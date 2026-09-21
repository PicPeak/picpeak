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
async function sendContract(id, adminId) {
  // Self-heal: dev installs that ran migration 130 BEFORE we added
  // contract_fully_signed to the seed list won't have all three
  // contract templates in email_templates. Insert any missing rows
  // before we queue the email. Idempotent + module-cached.
  await ensureContractEmailTemplatesSeeded(db, logger);

  const data = await getContractById(id);
  if (!data) throw new AppError('Contract not found', 404);
  const { contract } = data;

  if (!['draft'].includes(contract.status)) {
    throw new AppError(`Cannot send a contract with status '${contract.status}'`, 409);
  }

  const customer = await db('customer_accounts').where({ id: contract.customer_account_id }).first();
  ensureCustomerActive(customer);

  // The signers (#1446): the ones set on the draft, or the contract's
  // customer; each gets a slot on the signature page, the issuer last.
  const signingV2 = require('./signingV2');
  const { slots: signatureSlots } = await signingV2.prepareSend(contract);

  const refreshed = await getContractById(id);

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
  // who may sign now their own link.
  const invited = await signingV2.completeSend(id, {
    pdfPath, pdfSha256, adminId, freeze, lockVersion: refreshed.contract.lock_version,
  });

  try {
    await logActivity('contract_sent', { contractId: id, signersInvited: invited }, null, await adminActor(adminId));
  } catch (_) { /* logging is best-effort */ }

  await emitContractEvent(contract, 'sent');

  logger.info('Contract sent', { adminId, contractId: id });
  return { pdfPath, invited };
}
module.exports = {
  renderContractPdfBuffer,
  sendContract,
};
