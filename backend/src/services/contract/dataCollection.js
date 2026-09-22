'use strict';

/**
 * Collect the customer's details first, freeze the contract afterwards
 * (#1446).
 *
 * Placeholders are resolved and hashed at send, and the PDF with its
 * signature slots is rendered then, so details supplied after the send
 * could only change what is signed by re-rendering, re-hashing, revoking and
 * re-inviting. Instead the admin can send in two steps:
 *
 *   1. requestData — the contract becomes `awaiting_data`; its signers are
 *      created and only the first one (who has to be the customer account
 *      holder) is invited, with a mail that asks for details and carries no
 *      contract, no PDF and no attachment. `data_requested` goes into the log.
 *      Nothing is rendered or frozen.
 *   2. submitDetails — after the email code, the signer supplies the
 *      allowlisted fields. One transaction claims the step (a conditional
 *      update while `data_collected_at` is NULL), writes them to the customer
 *      account through the accounting history, and logs `data_collected` with
 *      the field keys only. Then the ordinary send runs: snapshot, hash, PDF,
 *      manifest, `sent`, and the other signers are invited. The signer's
 *      session stays valid and opens the frozen contract.
 *
 * If the render fails at that point the details stay saved, the contract
 * stays `awaiting_data`, and the failure is recorded on it
 * (`recordFollowUpFailure('data_freeze')`) for the admin to send again.
 * No value ever goes into the activity log or the event log.
 */

const { db, logActivity } = require('../../database/db');
const { AppError } = require('../../utils/errors');
const { auditedUpdate } = require('../accountingHistory');
const signingEvents = require('./signingEvents');
const { adminActor, ensureCustomerActive } = require('./helpers');

const FIELDS = ['address_line1', 'address_line2', 'postal_code', 'city', 'country_code', 'company_name', 'vat_id', 'phone'];
const REQUIRED = ['address_line1', 'postal_code', 'city', 'country_code'];
// The admin customer form's limits (routes/adminCustomers.js).
const MAX = {
  address_line1: 255, address_line2: 255, postal_code: 20, city: 120, country_code: 2, company_name: 120, vat_id: 40, phone: 40,
};

/** Whether `{{customer_address}}` would print empty for this customer. */
function addressMissing(customer) {
  return !customer || ![customer.address_line1, customer.address_line2, customer.postal_code, customer.city]
    .some((value) => value && String(value).trim());
}

function parseRequest(raw) {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (value && Array.isArray(value.fields)) return value;
  } catch (_) { /* fall through */ }
  return { fields: FIELDS, required: REQUIRED };
}

/**
 * The details, validated like the admin customer form: strings within its
 * limits, a two-letter country code, every required field filled. Unknown
 * keys are refused. Returns the columns to write.
 */
function validateDetails(input, request) {
  const allowed = new Set(request.fields);
  const values = input && typeof input === 'object' ? input : {};
  const invalid = [];
  const out = {};
  for (const [key, raw] of Object.entries(values)) {
    if (!allowed.has(key)) {
      invalid.push(key);
      continue;
    }
    if (raw != null && typeof raw !== 'string') {
      invalid.push(key);
      continue;
    }
    let value = raw == null ? '' : raw.trim();
    if (key === 'country_code') {
      value = value.toUpperCase();
      if (value && !/^[A-Z]{2}$/.test(value)) invalid.push(key);
    }
    if (value.length > MAX[key]) invalid.push(key);
    out[key] = value || null;
  }
  for (const key of request.required || []) {
    if (!out[key]) invalid.push(key);
  }
  if (invalid.length) {
    const err = new AppError('Check the highlighted details.', 400, 'DETAILS_INVALID');
    err.details = { fields: [...new Set(invalid)] };
    throw err;
  }
  return out;
}

/** Step 1: ask the customer for their details; nothing is frozen. */
async function requestData(contractId, adminId) {
  const signingV2 = require('./signingV2');
  const { ensureContractEmailTemplatesSeeded } = require('../contractEmailTemplates');
  await ensureContractEmailTemplatesSeeded(db, require('../../utils/logger'));
  const contract = await db('contracts').where({ id: contractId }).first();
  if (!contract) throw new AppError('Contract not found', 404);
  if (contract.status !== 'draft') {
    throw new AppError(`Cannot send a contract with status '${contract.status}'`, 409);
  }
  const customer = await db('customer_accounts').where({ id: contract.customer_account_id }).first();
  ensureCustomerActive(customer);
  const { rows } = await signingV2.prepareSend(contract);
  const first = rows.find((row) => row.role === 'customer' && Number(row.position) === 1);
  if (!first || !(await signingV2.isAccountHolder(contract, first))) {
    throw new AppError(
      'Only the customer themselves can complete their details. Make them the first signer, or send the contract as it is.',
      409, 'DATA_REQUEST_SIGNER',
    );
  }
  const actor = await adminActor(adminId);
  const request = { fields: FIELDS, required: REQUIRED };
  await db.transaction(async (trx) => {
    const now = new Date().toISOString();
    const claimed = await auditedUpdate(trx, 'contracts',
      (q) => q.where({ id: contractId, status: 'draft', lock_version: contract.lock_version }),
      {
        status: 'awaiting_data',
        signing_version: signingV2.VERSION,
        data_request: JSON.stringify(request),
        data_collected_at: null,
        lock_version: (Number(contract.lock_version) || 1) + 1,
        updated_at: now,
      },
      { actor: adminId, source: 'contract.data_request' });
    if (!claimed) {
      throw new AppError('This contract changed while it was being sent. Reload it and send again.', 409, 'CONTRACT_CHANGED');
    }
    await signingEvents.appendEvent(trx, contractId, {
      type: 'data_requested', actorType: 'admin', actorLabel: actor.name || null, payload: { fields: request.fields },
    });
  });
  const invited = await signingV2.inviteDue(contractId, actor);
  try {
    await logActivity('contract_data_requested', { contractId, signersInvited: invited }, null, actor);
  } catch (_) { /* logging is best-effort */ }
  return { status: 'awaiting_data', invited };
}

/** What the first signer sees during the step: the form, not the contract. */
async function dataView(contract, signer, session) {
  const publicView = require('./publicView');
  const request = parseRequest(contract.data_request);
  const customer = (await db('customer_accounts').where({ id: contract.customer_account_id }).first()) || {};
  const profile = await db('business_profile').where({ id: 1 }).first();
  return {
    contractNumber: contract.contract_number,
    status: contract.status,
    language: contract.language,
    issuer: await publicView.issuerSummary(profile),
    dataRequest: {
      fields: request.fields,
      required: request.required || [],
      // The account holder's own details, to correct rather than retype.
      values: Object.fromEntries(request.fields.map((key) => [key, customer[key] || ''])),
      submitted: !!contract.data_collected_at,
    },
    signing: {
      status: signer.status,
      verifiedVia: session.verified_via,
      canSign: false,
      canDecline: false,
      waitingForOthers: false,
    },
  };
}

/** Step 2: the details, then the freeze. */
async function submitDetails(sessionToken, input) {
  const signingV2 = require('./signingV2');
  const { signer, contract } = await signingV2.sessionContext(sessionToken);
  if (contract.status !== 'awaiting_data') {
    throw new AppError('This contract is not waiting for your details.', 409, 'DATA_NOT_REQUESTED');
  }
  await signingV2.assertDataSigner(contract, signer);
  const clean = validateDetails(input, parseRequest(contract.data_request));
  const name = signingV2.signerDisplayName(signer);
  await db.transaction(async (trx) => {
    const now = new Date().toISOString();
    const claimed = await auditedUpdate(trx, 'contracts',
      (q) => q.where({ id: contract.id, status: 'awaiting_data' }).whereNull('data_collected_at'),
      { data_collected_at: now, updated_at: now },
      { actor: { type: 'customer', name }, source: 'contract.data_collection' });
    if (!claimed) throw new AppError('Your details were already received.', 409, 'DATA_ALREADY_SUBMITTED');
    if (Object.keys(clean).length) {
      await auditedUpdate(trx, 'customer_accounts', { id: contract.customer_account_id },
        { ...clean, updated_at: now }, { actor: { type: 'customer', name }, source: 'contract.data_collection' });
    }
    // Field keys only: the values are the customer's, and the log is kept.
    await signingEvents.appendEvent(trx, contract.id, {
      type: 'data_collected', actorType: 'signer', actorLabel: name, signerId: signer.id,
      payload: { fields: Object.keys(clean).sort() },
    });
  });
  try {
    await logActivity('contract_data_collected', { contractId: contract.id, fields: Object.keys(clean).sort() }, null,
      { type: 'customer', name: 'Customer (signing link)' });
  } catch (_) { /* logging is best-effort */ }
  return freeze(contract.id, null);
}

/**
 * Render, hash and send the contract with the collected details. Never
 * throws: a failure keeps the details and the status, and is recorded on
 * the contract for the admin to send again.
 */
async function freeze(contractId, adminId) {
  const signingV2 = require('./signingV2');
  try {
    await require('./sending').sendContract(contractId, adminId);
    await signingV2.clearFollowUpFailure(contractId, { steps: ['data_freeze'] });
    return { status: 'sent', frozen: true };
  } catch (err) {
    // The send commits before it invites anyone: a failed invitation after
    // that is not a failed freeze. The contract is out, the signer's session
    // opens it, and the hourly sweep invites whoever is still pending.
    const current = await db('contracts').where({ id: contractId }).first('status');
    if (current && current.status !== 'awaiting_data') {
      await signingV2.clearFollowUpFailure(contractId, { steps: ['data_freeze'] });
      await signingV2.recordFollowUpFailure(contractId, 'invitation', err);
      return { status: current.status, frozen: true };
    }
    await signingV2.recordFollowUpFailure(contractId, 'data_freeze', err);
    return { status: 'awaiting_data', frozen: false };
  }
}

module.exports = {
  FIELDS,
  REQUIRED,
  addressMissing,
  parseRequest,
  validateDetails,
  requestData,
  dataView,
  submitDetails,
  freeze,
};
