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
  const { contract, inclusions } = data;

  if (!['draft'].includes(contract.status)) {
    throw new AppError(`Cannot send a contract with status '${contract.status}'`, 409);
  }

  const customer = await db('customer_accounts').where({ id: contract.customer_account_id }).first();
  ensureCustomerActive(customer);

  // Snapshot every included block's body into the inclusion row so
  // future block edits don't mutate the sent contract — in every language
  // (#1445; only EN and DE were frozen). Text a template already froze into
  // the contract stays as it is.
  const content = require('./content');
  await db.transaction(async (trx) => {
    for (const inc of inclusions) {
      if (!(inc.included === true || inc.included === 1 || inc.included === '1')) continue;
      const frozen = content.inclusionSnapshot(inc);
      await trx('contract_block_inclusions').where({ id: inc.id }).update({
        ...content.snapshotColumns(Object.keys(frozen).length ? frozen : content.blockBodies(inc, 'block_')),
        updated_at: new Date(),
      });
    }
  });

  // Freeze the resolved content — clauses in every language, title, intro,
  // outro and the placeholder values of this moment — with its sha256
  // (#1445). The PDF, the signing page and later re-renders read this.
  const frozenDraft = await getContractById(id);
  const { snapshot, sha256: contentSha256 } = await require('./renderContext')
    .buildContentSnapshot(frozenDraft.contract, frozenDraft.inclusions, frozenDraft.textSections);
  await db('contracts').where({ id }).update({
    rendered_content: JSON.stringify(snapshot),
    rendered_content_sha256: contentSha256,
    updated_at: new Date(),
  });

  // The signers (#1446): the ones set on the draft, or the contract's
  // customer; each gets a slot on the signature page, the issuer last.
  const signingV2 = require('./signingV2');
  const refreshed = await getContractById(id);
  const { slots: signatureSlots } = await signingV2.prepareSend(refreshed.contract);

  // Re-fetched with snapshots populated so the renderer uses the frozen
  // bodies (matches post-send reads).
  const ctx = await buildRenderContext(refreshed.contract, refreshed.inclusions, refreshed.textSections);
  ctx.signatureSlots = signatureSlots;
  // Where each signature slot landed goes into the record (#1445).
  const { buffer: rendered, slots } = await pdfService.renderContractWithSlots(ctx);
  // Attachments (#1445): merged ones go between the body and the signature
  // page, separate ones are delivered next to the PDF; each is checked
  // against the sha256 the contract recorded for it.
  const attachments = require('./attachments');
  const sendable = await attachments.buildSendable(refreshed.contract, rendered, { slots });
  const { filePath: pdfPath, sha256: pdfSha256 } = await persistContractPdf(refreshed.contract, sendable.buffer, '', {
    kind: 'unsigned',
    theme: ctx.theme,
    issuer: ctx.issuer,
    templateVersionId: refreshed.contract.template_version_id,
    manifest: sendable.manifest,
  });

  // Marks the contract sent, starts the event log and emails each signer
  // who may sign now their own link.
  const invited = await signingV2.completeSend(id, { pdfPath, pdfSha256, adminId });

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
