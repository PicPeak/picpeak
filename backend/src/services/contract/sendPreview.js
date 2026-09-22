'use strict';

/**
 * The pre-send review of a draft contract (#1445): everything the send will
 * freeze and deliver, resolved now, without sending — the content as the
 * signing page will show it, the signers and their order, the attachments
 * with the result of the same file check the send runs, the price the
 * snapshot will freeze, the template version, and the problems that would
 * make the send fail or that the admin should see first.
 *
 * Read-only: no status change, no signer rows written, nothing logged.
 */

const { db } = require('../../database/db');
const { AppError } = require('../../utils/errors');
const { ensureInt } = require('../../utils/numericHelpers');
const { PLACEHOLDER_PATTERN } = require('../../utils/placeholders');

const problem = (code, severity, message, extra = {}) => ({ code, severity, message, ...extra });

async function buildSendPreview(contractId) {
  const contract = await db('contracts').where({ id: contractId }).first();
  if (!contract) throw new AppError('Contract not found', 404);
  const problems = [];

  if (contract.status !== 'draft') {
    problems.push(problem('CONTRACT_NOT_DRAFT', 'error', `A contract with status '${contract.status}' can't be sent`));
  }
  const customer = await db('customer_accounts').where({ id: contract.customer_account_id }).first();
  if (!customer) problems.push(problem('CUSTOMER_MISSING', 'error', 'The customer no longer exists'));
  else if (customer.is_active === false || customer.is_active === 0) {
    problems.push(problem('CUSTOMER_INACTIVE', 'error', 'The customer is deactivated'));
  }

  // The content as the signing page will show it (for a draft, the live
  // clauses with this moment's placeholder values — what the send freezes).
  const publicView = require('./publicView');
  const view = await publicView.buildPublicView(contractId);
  const quote = await require('./renderContext').buildQuoteSnapshot(contract);
  const content = {
    contractNumber: view.contractNumber,
    language: view.language,
    title: view.title,
    introText: view.introText,
    outroText: view.outroText,
    sections: view.sections,
    recipient: view.recipient,
    commercial: quote ? publicView.commercialView(quote) : null,
  };
  const texts = [content.introText, content.outroText, ...content.sections.flatMap((s) => s.blocks.map((b) => b.body))];
  const unresolved = [...new Set(texts.flatMap((text) => [...String(text || '').matchAll(PLACEHOLDER_PATTERN)].map((m) => m[1])))];
  if (unresolved.length) {
    problems.push(problem('PLACEHOLDER_UNRESOLVED', 'warning',
      `Placeholders that will print as typed: ${unresolved.map((k) => `{{${k}}}`).join(', ')}`, { keys: unresolved }));
  }
  if (!content.sections.length) problems.push(problem('NO_CLAUSES', 'warning', 'The contract has no clauses'));

  // The signers: the ones set on the draft, or the ones the send will create
  // (the contract's customer, then the issuer) — computed, not written.
  const signersModule = require('./signers');
  const rows = await signersModule.listSigners(contractId);
  let signers;
  if (rows.length) {
    signers = rows.map((row) => {
      const api = signersModule.signerToApi(row);
      return { position: api.position, role: api.role, name: api.name, email: api.email };
    });
  } else {
    const profile = await db('business_profile').where({ id: 1 }).first();
    if (customer && !customer.email) {
      problems.push(problem('SIGNER_EMAIL_MISSING', 'error', 'The customer has no email address to sign with'));
    }
    signers = [
      ...(customer ? [{
        position: 1, role: 'customer', name: signersModule.customerName(customer), email: customer.email ? customer.email.toLowerCase() : null,
      }] : []),
      { position: customer ? 2 : 1, role: 'issuer', name: (profile && profile.company_name) || 'Issuer', email: null },
    ];
  }

  const attachments = (await require('./attachments').verifyContractAttachments(contractId)).map(({ problem: code, ...rest }) => {
    if (code) {
      problems.push(problem(code, 'error', code === 'ATTACHMENT_CHANGED'
        ? `"${rest.name}" no longer matches the file that was added`
        : `The file of "${rest.name}" is missing`, { attachmentId: rest.attachmentId }));
    }
    return rest;
  });

  let template = null;
  if (contract.template_version_id) {
    const row = await db('contract_template_versions as v')
      .join('contract_templates as t', 't.id', 'v.template_id')
      .where('v.id', contract.template_version_id)
      .select('t.id', 't.name', 'v.version_number')
      .first();
    if (row) template = { id: row.id, name: row.name, version: ensureInt(row.version_number) };
  }

  return {
    content,
    signingOrder: contract.signing_order || 'parallel',
    signers,
    attachments,
    totals: content.commercial ? { currency: content.commercial.currency, ...content.commercial.totals } : null,
    template,
    problems,
  };
}

module.exports = { buildSendPreview };
