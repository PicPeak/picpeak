/**
 * contractService — orchestrates the lifecycle of `contracts`, their
 * `contract_block_inclusions` (which blocks from the library make it
 * onto a given contract), and the public `contract_action_tokens` used
 * by the customer's signing link.
 *
 * Contracts are an INDEPENDENT document type alongside quotes and
 * invoices. Composition model:
 *   - Admin picks blocks from the `contract_blocks` library and toggles
 *     them on/off per section (basics → scope → privacy → commercial →
 *     nda → closing). Order within a section is admin-controlled.
 *   - On send, every included block's body is FROZEN into
 *     `body_text_snapshot` on the inclusion row, so future edits to
 *     the source block don't mutate already-sent contracts.
 *
 * Signing:
 *   1. Customer opens /contract/:token and either:
 *      a) Types name, optionally draws a signature on canvas, ticks
 *         "I have read and agree", submits → recordCustomerSignature
 *         stamps the signature into a re-rendered PDF and the system
 *         emails the admin.
 *      b) Uploads a wet-signed PDF → attachSignedPdfUpload sets the
 *         signed_pdf_path as the authoritative copy.
 *   2. Admin counter-signs (in-browser or by re-uploading the
 *      double-signed PDF) → status flips to `fully_signed`.
 *
 * Bodies support {{placeholders}} resolved at PDF/preview render time
 * using the same Handlebars-lite regex that emailProcessor.safeTemplateReplace
 * uses. We rebuild it inline here (not exported from emailProcessor) to
 * keep the dependency tree shallow and so contracts can render
 * client-side previews in the future without pulling the email
 * processor.
 */
//
// Decomposed into ./contract/* modules (move-code refactor). This file is the
// stable public entry point: same require path, same exported names.

const helpers = require('./contract/helpers');
const renderContext = require('./contract/renderContext');
const crud = require('./contract/crud');
const sending = require('./contract/sending');
const signatures = require('./contract/signatures');
const conversions = require('./contract/conversions');

const { SECTIONS_ORDER, nextContractNumber } = helpers;
const { renderTemplatedBody, buildPlaceholderContext, buildRenderContext } = renderContext;
const {
  listContracts, getContractById, createContract, updateContract, cancelContract,
} = crud;
const { renderContractPdfBuffer, sendContract } = sending;
const {
  recordCustomerSignature, recordAdminCountersignature, attachSignedPdfUpload,
  rerenderAndResend, restampSignatures, getAuditTrail, verifyIntegrity,
} = signatures;
const { createFromQuote, convertToEvent, convertToInvoiceOnly } = conversions;

module.exports = {
  listContracts,
  getContractById,
  createContract,
  updateContract,
  sendContract,
  renderContractPdfBuffer,
  recordCustomerSignature,
  recordAdminCountersignature,
  attachSignedPdfUpload,
  cancelContract,
  createFromQuote,
  convertToEvent,
  convertToInvoiceOnly,
  rerenderAndResend,
  restampSignatures,
  getAuditTrail,
  verifyIntegrity,
  // Exported for tests + the public-route preview endpoint.
  _internal: {
    nextContractNumber,
    renderTemplatedBody,
    buildPlaceholderContext,
    buildRenderContext,
    SECTIONS_ORDER,
  },
};
