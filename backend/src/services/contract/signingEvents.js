'use strict';

/**
 * The signing event log (#1446): append-only, one chain per contract.
 *
 * Every event stores the hash of the one before it, and its own hash covers
 * that value together with the event's contents and timestamp. Changing an
 * event, removing one or reordering them breaks every hash after it, and
 * verifyChain() says where. The contract row keeps the latest hash
 * (audit_chain_head), which the audit certificate prints, so a copy of the
 * certificate pins the whole log as it was at completion.
 */

const { db } = require('../../database/db');
const { canonicalJson, canonicalSha256 } = require('../../utils/canonicalJson');

const GENESIS = '0'.repeat(64);

function hashOf(event) {
  return canonicalSha256({
    contractId: Number(event.contractId),
    seq: Number(event.seq),
    type: event.type,
    actorType: event.actorType,
    actorLabel: event.actorLabel || null,
    signerId: event.signerId == null ? null : Number(event.signerId),
    payload: event.payload || {},
    artifactSha256: event.artifactSha256 || null,
    prevHash: event.prevHash,
    occurredAt: event.occurredAt,
  });
}

function parsePayload(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (_) {
    return { unreadable: true };
  }
}

function fromRow(row) {
  return {
    contractId: Number(row.contract_id),
    seq: Number(row.seq),
    type: row.event_type,
    actorType: row.actor_type,
    actorLabel: row.actor_label || null,
    signerId: row.signer_id == null ? null : Number(row.signer_id),
    payload: parsePayload(row.payload),
    artifactSha256: row.artifact_sha256 || null,
    prevHash: row.prev_hash,
    eventHash: row.event_hash,
    occurredAt: row.occurred_at,
  };
}

/**
 * Append an event. Pass the caller's transaction when there is one: the
 * contract row is locked first (Postgres), so two appends can't take the
 * same sequence number; the unique (contract_id, seq) index is the backstop.
 */
async function appendEvent(conn, contractId, {
  type, actorType = 'system', actorLabel = null, signerId = null, payload = {}, artifactSha256 = null,
}) {
  const run = async (trx) => {
    await trx('contracts').where({ id: contractId }).forUpdate().first('id');
    const last = await trx('contract_signing_events').where({ contract_id: contractId }).orderBy('seq', 'desc').first();
    const event = {
      contractId,
      seq: last ? Number(last.seq) + 1 : 1,
      type,
      actorType,
      actorLabel,
      signerId,
      payload,
      artifactSha256,
      prevHash: last ? last.event_hash : GENESIS,
      occurredAt: new Date().toISOString(),
    };
    event.eventHash = hashOf(event);
    await trx('contract_signing_events').insert({
      contract_id: contractId,
      seq: event.seq,
      event_type: type,
      actor_type: actorType,
      actor_label: actorLabel,
      signer_id: signerId,
      payload: canonicalJson(payload || {}),
      artifact_sha256: artifactSha256,
      prev_hash: event.prevHash,
      event_hash: event.eventHash,
      occurred_at: event.occurredAt,
      created_at: new Date(),
    });
    await trx('contracts').where({ id: contractId }).update({ audit_chain_head: event.eventHash });
    return event;
  };
  return conn && conn.isTransaction ? run(conn) : db.transaction(run);
}

async function listEvents(contractId, conn = db) {
  const rows = await conn('contract_signing_events').where({ contract_id: contractId }).orderBy('seq', 'asc');
  return rows.map(fromRow);
}

/**
 * Recompute the chain. `{ ok, count, head, brokenAt, reason }` — brokenAt is
 * the first sequence number whose link or hash doesn't hold.
 */
async function verifyChain(contractId, conn = db) {
  const events = await listEvents(contractId, conn);
  let prev = GENESIS;
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (event.seq !== i + 1) return { ok: false, count: events.length, head: prev, brokenAt: i + 1, reason: 'missing_event' };
    if (event.prevHash !== prev) return { ok: false, count: events.length, head: prev, brokenAt: event.seq, reason: 'broken_link' };
    if (hashOf(event) !== event.eventHash) return { ok: false, count: events.length, head: prev, brokenAt: event.seq, reason: 'altered_event' };
    prev = event.eventHash;
  }
  const contract = await conn('contracts').where({ id: contractId }).first('audit_chain_head');
  if (events.length && contract && contract.audit_chain_head && contract.audit_chain_head !== prev) {
    return { ok: false, count: events.length, head: prev, brokenAt: events.length, reason: 'head_mismatch' };
  }
  return { ok: true, count: events.length, head: events.length ? prev : null, brokenAt: null, reason: null };
}

module.exports = {
  GENESIS,
  appendEvent,
  listEvents,
  verifyChain,
  _internal: { hashOf },
};
