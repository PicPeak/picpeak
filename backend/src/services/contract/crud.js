// Extracted verbatim from contractService.js — see ../contractService.js for the
// module-level overview. Do not add behavior here without updating the entry re-exports.

const crypto = require('crypto');
const { db, withRetry, logActivity } = require('../../database/db');
const logger = require('../../utils/logger');
const { getAppSetting } = require('../../utils/appSettings');
const { AppError } = require('../../utils/errors');
const { hasColumnCached } = require('../../utils/schemaCache');
const businessProfileService = require('../businessProfileService');
const { ensureSystemBlocksSeeded } = require('../contractBlocksService');
const { ensureInt } = require('../../utils/numericHelpers');
const { adminActor, ensureCustomerActive, nextContractNumber } = require('./helpers');


// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

async function listContracts({ filters = {}, sort = 'issue_desc', page = 1, pageSize = 25 } = {}) {
  return await withRetry(async () => {
    let query = db('contracts')
      .leftJoin('customer_accounts', 'contracts.customer_account_id', 'customer_accounts.id')
      .select(
        'contracts.*',
        'customer_accounts.email as customer_email',
        'customer_accounts.display_name as customer_display_name',
        'customer_accounts.first_name as customer_first_name',
        'customer_accounts.last_name as customer_last_name',
        'customer_accounts.company_name as customer_company_name',
      );

    if (Array.isArray(filters.status) && filters.status.length > 0) {
      query = query.whereIn('contracts.status', filters.status);
    }
    if (filters.customerAccountId) {
      query = query.where('contracts.customer_account_id', filters.customerAccountId);
    }
    if (filters.q && String(filters.q).trim()) {
      const term = `%${String(filters.q).trim()}%`;
      query = query.andWhere(function() {
        this.where('contracts.contract_number', 'like', term)
          .orWhere('contracts.title', 'like', term)
          .orWhere('customer_accounts.email', 'like', term)
          .orWhere('customer_accounts.company_name', 'like', term);
      });
    }

    const countQuery = query.clone().clearSelect().clearOrder().count('contracts.id as total').first();
    const totalRow = await countQuery;
    const total = ensureInt(totalRow?.total || 0);

    switch (sort) {
    case 'oldest':
      query = query.orderBy('contracts.created_at', 'asc').orderBy('contracts.id', 'asc');
      break;
    case 'issue_asc':
      query = query.orderBy('contracts.issue_date', 'asc').orderBy('contracts.id', 'asc');
      break;
    case 'issue_desc':
      query = query.orderBy('contracts.issue_date', 'desc').orderBy('contracts.id', 'desc');
      break;
    case 'customer_asc':
      query = query
        .orderByRaw('COALESCE(customer_accounts.company_name, customer_accounts.last_name, customer_accounts.email) asc')
        .orderBy('contracts.id', 'desc');
      break;
    case 'customer_desc':
      query = query
        .orderByRaw('COALESCE(customer_accounts.company_name, customer_accounts.last_name, customer_accounts.email) desc')
        .orderBy('contracts.id', 'desc');
      break;
    case 'newest':
    default:
      query = query.orderBy('contracts.created_at', 'desc').orderBy('contracts.id', 'desc');
      break;
    }

    const offset = Math.max(0, (page - 1) * pageSize);
    query = query.offset(offset).limit(pageSize);
    const rows = await query;
    return { rows, total, page, pageSize };
  });
}

async function getContractById(id) {
  return await withRetry(async () => {
    const contract = await db('contracts')
      .leftJoin('customer_accounts', 'contracts.customer_account_id', 'customer_accounts.id')
      .where('contracts.id', id)
      .select(
        'contracts.*',
        'customer_accounts.email as customer_email',
        'customer_accounts.display_name as customer_display_name',
        'customer_accounts.first_name as customer_first_name',
        'customer_accounts.last_name as customer_last_name',
        'customer_accounts.company_name as customer_company_name',
        'customer_accounts.preferred_language as customer_preferred_language',
      )
      .first();
    if (!contract) return null;

    const inclusions = await db('contract_block_inclusions as inc')
      .leftJoin('contract_blocks as blk', 'blk.id', 'inc.block_id')
      .where('inc.contract_id', id)
      .orderByRaw(`
        CASE inc.section
          WHEN 'basics' THEN 1
          WHEN 'scope' THEN 2
          WHEN 'privacy' THEN 3
          WHEN 'commercial' THEN 4
          WHEN 'nda' THEN 5
          WHEN 'closing' THEN 6
          ELSE 99
        END
      `)
      .orderBy('inc.position', 'asc')
      .select(
        'inc.*',
        'blk.slug as block_slug',
        'blk.name as block_name',
        'blk.description as block_description',
        'blk.body_text as block_body_text',
        'blk.body_text_de as block_body_text_de',
        // Migration 131 — locale variants. Pulled with column-existence
        // guard so installs that haven't run migration 131 still load
        // contracts (just without the new columns).
        ...(await hasColumnCached('contract_blocks', 'body_text_ru')
          ? ['blk.body_text_ru as block_body_text_ru'] : []),
        ...(await hasColumnCached('contract_blocks', 'body_text_pt')
          ? ['blk.body_text_pt as block_body_text_pt'] : []),
        ...(await hasColumnCached('contract_blocks', 'body_text_nl')
          ? ['blk.body_text_nl as block_body_text_nl'] : []),
        ...(await hasColumnCached('contract_blocks', 'body_text_fr')
          ? ['blk.body_text_fr as block_body_text_fr'] : []),
        'blk.is_system as block_is_system',
      );
    return { contract, inclusions };
  });
}

/**
 * Create a draft contract. Pre-populates `contract_block_inclusions`
 * with every active system block toggled ON so the admin sees a
 * sensible starting point and just toggles off what they don't need.
 *
 * Custom (non-system) blocks are NOT auto-included — admin opts in to
 * those explicitly so a runaway block library doesn't pollute every
 * new contract.
 */
async function createContract(payload, adminId) {
  // Self-heal: ensure runtime-seeded system blocks (e.g. the
  // quote_line_items_table added after migration 131 was deployed)
  // exist before we copy active system blocks into the new contract's
  // inclusion list. Idempotent — only fires if rows are missing.
  await ensureSystemBlocksSeeded();

  const customer = await db('customer_accounts').where({ id: payload.customerAccountId }).first();
  ensureCustomerActive(customer);

  const profile = (await businessProfileService.getProfile()).profile;
  const language = payload.language || customer.preferred_language || profile?.default_locale || 'de';
  const validDays = ensureInt(await getAppSetting('crm_contracts_default_valid_days')) || 30;
  const issueDate = payload.issueDate || new Date().toISOString().slice(0, 10);
  const validUntil = payload.validUntil || new Date(Date.now() + validDays * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);

  // Schema-drift guard for the event-snapshot columns added as
  // in-place migration 130 edits. We only write them when the DB
  // actually has them; older dev installs that haven't re-migrated
  // simply skip these fields (contract still saves successfully).
  const hasEventCols = await hasColumnCached('contracts', 'event_name');

  return await db.transaction(async (trx) => {
    // Pass trx so the sequence claim joins our outer transaction —
    // SQLite deadlocks otherwise (1-connection default).
    const contractNumber = await nextContractNumber(trx);
    const row = {
      contract_number: contractNumber,
      customer_account_id: payload.customerAccountId,
      status: 'draft',
      language,
      issue_date: issueDate,
      valid_until: validUntil,
      title: payload.title || null,
      intro_text: payload.introText || null,
      outro_text: payload.outroText || null,
      // Migration 140 — standalone contract is a deal root; mint a
      // fresh UUID. The createFromQuote path (line ~1557) sets this
      // from the source quote's deal_uuid instead.
      deal_uuid: crypto.randomUUID(),
      created_by_admin_id: adminId,
      created_at: new Date(),
      updated_at: new Date(),
    };
    if (hasEventCols) {
      row.event_name = payload.eventName || null;
      row.event_date = payload.eventDate || null;
      row.event_time_start = payload.eventTimeStart || null;
      row.event_time_end = payload.eventTimeEnd || null;
    }
    // Migration 121 — optional link to a Project Overview project.
    if (payload.projectId !== undefined && await hasColumnCached('contracts', 'project_id')) {
      row.project_id = payload.projectId || null;
    }
    const inserted = await trx('contracts').insert(row).returning('id');
    if (row.project_id && row.deal_uuid) {
      await require('../projectService').linkDealToProject(row.deal_uuid, row.project_id, trx);
    }
    const contractId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];

    // Seed with every active system block, toggled on. Per-section
    // position = display_order from the source block.
    //
    // D.3 — batched insert. Previously this loop fired one INSERT per
    // block (12+ round-trips inside the transaction on a fresh contract).
    // Batched into a single `.insert(rows)` since the row count is
    // bounded (system block count) and the inserts are independent.
    const systemBlocks = await trx('contract_blocks')
      .where({ is_system: true, is_active: true })
      .orderBy(['section', 'display_order']);
    const sectionCounters = {};
    const inclusionRows = systemBlocks.map((block) => {
      sectionCounters[block.section] = (sectionCounters[block.section] || 0) + 1;
      return {
        contract_id: contractId,
        block_id: block.id,
        section: block.section,
        position: sectionCounters[block.section],
        body_text_snapshot: null,
        body_text_de_snapshot: null,
        included: true,
        created_at: new Date(),
        updated_at: new Date(),
      };
    });
    if (inclusionRows.length > 0) {
      await trx('contract_block_inclusions').insert(inclusionRows);
    }

    try {
      await logActivity('contract_created', { contractId, contractNumber, customerAccountId: payload.customerAccountId }, null, await adminActor(adminId));
    } catch (_) { /* logging is best-effort */ }

    logger.info('Contract created', { adminId, contractId, contractNumber });
    return contractId;
  });
}

/**
 * Update a draft contract. Editing a sent contract is refused — admin
 * must cancel + create a fresh one (avoids invalidating the customer's
 * signed copy).
 *
 * payload.blocks is an array of `{ blockId, included, position }`
 * tuples; the service rewrites the contract_block_inclusions rows
 * accordingly.
 */
async function updateContract(id, payload, adminId) {
  const existing = await db('contracts').where({ id }).first();
  if (!existing) throw new AppError('Contract not found', 404);
  if (existing.status !== 'draft') {
    throw new AppError(
      `Cannot edit a contract with status '${existing.status}'. Cancel and create a new contract for amendments.`,
      409,
      'CONTRACT_LOCKED',
    );
  }

  const hasEventCols = await hasColumnCached('contracts', 'event_name');

  return await db.transaction(async (trx) => {
    const updates = { updated_at: new Date() };
    const map = {
      title: 'title',
      introText: 'intro_text',
      outroText: 'outro_text',
      language: 'language',
      validUntil: 'valid_until',
      issueDate: 'issue_date',
    };
    // Event-snapshot fields only flow through when the DB has them
    // (in-place migration 130 edit). Guarded so dev installs that
    // haven't re-migrated don't crash the update.
    if (hasEventCols) {
      Object.assign(map, {
        eventName: 'event_name',
        eventDate: 'event_date',
        eventTimeStart: 'event_time_start',
        eventTimeEnd: 'event_time_end',
      });
    }
    for (const [api, col] of Object.entries(map)) {
      if (api in payload) updates[col] = payload[api] || null;
    }
    // Migration 121 — optional Project Overview link.
    if ('projectId' in payload && await hasColumnCached('contracts', 'project_id')) {
      updates.project_id = payload.projectId || null;
    }
    await trx('contracts').where({ id }).update(updates);

    // Cascade across the deal lineage (linked quote / event / invoices).
    if (updates.project_id) {
      const dealRow = await trx('contracts').where({ id }).select('deal_uuid').first();
      await require('../projectService').linkDealToProject(dealRow && dealRow.deal_uuid, updates.project_id, trx);
    }

    // Replace inclusions only when the caller sent an explicit list.
    // (Editor's "save" sends every row; an inline "toggle" save could
    // send a partial update — current frontend always sends full list.)
    if (Array.isArray(payload.blocks)) {
      await trx('contract_block_inclusions').where({ contract_id: id }).del();
      // Recompute per-section position so we don't trust caller order
      // for ordering integrity; caller controls only the section
      // sequence via the order of items in payload.blocks.
      //
      // Previously this loop did one SELECT per block to look up its
      // section. On a contract with 12 included blocks that's 12
      // round-trips inside the transaction — pure N+1. Batch the
      // lookup into a single WHERE…IN, build a Map, and read it in
      // the loop. The insert itself stays sequential because the
      // editor's payload size is bounded (<30 blocks in practice) and
      // a single batch insert would lose row-by-row insert ordering
      // guarantees we don't actually need.
      const blockIds = [
        ...new Set(payload.blocks.map((e) => e.blockId).filter((id) => Number.isFinite(id))),
      ];
      const blocksFound = blockIds.length > 0
        ? await trx('contract_blocks').whereIn('id', blockIds).select('id', 'section')
        : [];
      const sectionByBlockId = new Map(blocksFound.map((b) => [b.id, b.section]));
      const sectionCounters = {};
      for (const entry of payload.blocks) {
        const section = sectionByBlockId.get(entry.blockId);
        if (!section) continue;
        sectionCounters[section] = (sectionCounters[section] || 0) + 1;
        await trx('contract_block_inclusions').insert({
          contract_id: id,
          block_id: entry.blockId,
          section,
          position: ensureInt(entry.position) || sectionCounters[section],
          body_text_snapshot: null,
          body_text_de_snapshot: null,
          included: entry.included === false ? false : true,
          created_at: new Date(),
          updated_at: new Date(),
        });
      }
    }

    try {
      await logActivity('contract_updated', { contractId: id }, null, await adminActor(adminId));
    } catch (_) { /* logging is best-effort */ }
    return id;
  });
}

async function cancelContract(id, adminId) {
  const contract = await db('contracts').where({ id }).first();
  if (!contract) throw new AppError('Contract not found', 404);
  if (!['draft', 'sent'].includes(contract.status)) {
    throw new AppError(`Cannot cancel a contract with status '${contract.status}'`, 409);
  }
  await db('contracts').where({ id }).update({
    status: 'cancelled',
    updated_at: new Date(),
  });
  // Invalidate any outstanding tokens.
  await db('contract_action_tokens').where({ contract_id: id, used_at: null }).update({
    expires_at: new Date(),
  });
  try {
    await logActivity('contract_cancelled', { contractId: id }, null, await adminActor(adminId));
  } catch (_) { /* logging is best-effort */ }
  return { status: 'cancelled' };
}

module.exports = {
  listContracts,
  getContractById,
  createContract,
  updateContract,
  cancelContract,
};
