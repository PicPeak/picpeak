/**
 * Tenant boundary for workflow execution data.
 *
 * Workflow definitions are studio-wide, but runs, steps and approvals contain
 * event/customer payloads.  Resolve each run through its durable source row so
 * a caller cannot gain access by changing the JSON context stored on the run.
 */
const { db } = require('../../database/db');
const { canAccessEvent, seesAllEvents } = require('../../middleware/ownership');

function managesAllEvents(admin) {
  return admin?.roleName === 'super_admin' || admin?.eventScope?.manageAll === true;
}

function hasGlobalAccess(admin, mode) {
  return mode === 'manage' ? managesAllEvents(admin) : seesAllEvents(admin);
}

function eventExists(eventIdColumn, alias) {
  return db(`events as ${alias}`)
    .select(db.raw('1'))
    .whereColumn(`${alias}.id`, eventIdColumn);
}

function ownedEventExists(eventIdColumn, admin, alias) {
  return db(`events as ${alias}`)
    .select(db.raw('1'))
    .whereColumn(`${alias}.id`, eventIdColumn)
    .andWhere((q) => q.whereNull(`${alias}.created_by`).orWhere(`${alias}.created_by`, admin.id));
}

function quoteWithResolvedEventExists(quoteIdColumn, alias) {
  return db(`quotes as ${alias}`)
    .select(db.raw('1'))
    .whereColumn(`${alias}.id`, quoteIdColumn)
    .whereNotNull(`${alias}.converted_event_id`);
}

function accessibleQuoteEventExists(quoteIdColumn, admin, alias, eventAlias) {
  return quoteWithResolvedEventExists(quoteIdColumn, alias)
    .whereExists(ownedEventExists(`${alias}.converted_event_id`, admin, eventAlias));
}

function contractWithResolvedEventExists(contractIdColumn, contractAlias, quoteAlias) {
  return db(`contracts as ${contractAlias}`)
    .select(db.raw('1'))
    .whereColumn(`${contractAlias}.id`, contractIdColumn)
    .andWhere((q) => q.whereNotNull(`${contractAlias}.converted_event_id`)
      .orWhereExists(quoteWithResolvedEventExists(`${contractAlias}.source_quote_id`, quoteAlias)));
}

function accessibleContractEventExists(contractIdColumn, admin, contractAlias, quoteAlias, eventAlias) {
  return db(`contracts as ${contractAlias}`)
    .select(db.raw('1'))
    .whereColumn(`${contractAlias}.id`, contractIdColumn)
    .andWhere((q) => q
      .where((direct) => direct
        .whereNotNull(`${contractAlias}.converted_event_id`)
        .whereExists(ownedEventExists(`${contractAlias}.converted_event_id`, admin, eventAlias)))
      .orWhere((quote) => quote
        .whereNull(`${contractAlias}.converted_event_id`)
        .whereExists(accessibleQuoteEventExists(
          `${contractAlias}.source_quote_id`, admin, quoteAlias, `${eventAlias}_q`,
        ))));
}

function customerOwnedExists(customerIdColumn, admin, alias) {
  return db(`customer_accounts as ${alias}`)
    .select(db.raw('1'))
    .whereColumn(`${alias}.id`, customerIdColumn)
    .where(`${alias}.created_by_admin_id`, admin.id);
}

function accessibleInvoiceExists(invoiceIdColumn, admin) {
  const query = db('invoices as we_invoice').select(db.raw('1'))
    .whereColumn('we_invoice.id', invoiceIdColumn);
  query.andWhere((source) => {
    source.where((event) => {
      event.whereNotNull('we_invoice.event_id')
        .whereExists(ownedEventExists('we_invoice.event_id', admin, 'we_invoice_event'));
    });
    source.orWhere((contract) => {
      contract.whereNull('we_invoice.event_id')
        .whereExists(accessibleContractEventExists(
          'we_invoice.source_contract_id', admin, 'we_invoice_contract',
          'we_invoice_contract_quote', 'we_invoice_contract_event',
        ));
    });
    source.orWhere((quote) => {
      quote.whereNull('we_invoice.event_id')
        .whereNotExists(contractWithResolvedEventExists(
          'we_invoice.source_contract_id', 'we_invoice_any_contract', 'we_invoice_any_contract_quote',
        ))
        .whereExists(accessibleQuoteEventExists(
          'we_invoice.source_quote_id', admin, 'we_invoice_quote', 'we_invoice_quote_event',
        ));
    });
    source.orWhere((owner) => {
      owner.whereNull('we_invoice.event_id')
        .whereNotExists(contractWithResolvedEventExists(
          'we_invoice.source_contract_id', 'we_invoice_owner_contract', 'we_invoice_owner_contract_quote',
        ))
        .whereNotExists(quoteWithResolvedEventExists(
          'we_invoice.source_quote_id', 'we_invoice_owner_quote',
        ))
        .where('we_invoice.created_by_admin_id', admin.id);
    });
  });
  return query;
}

/**
 * Apply the workflow entity boundary to a query whose FROM/JOIN set includes
 * workflow_runs under `alias`.  Unknown and ownerless non-event entities fail
 * closed; ownerless events retain the established legacy-event rule.
 * A legacy run with no initiator and no resolvable entity matches no branch
 * and stays visible to super_admin only.
 */
function scopeWorkflowRunsQuery(query, admin, { alias = 'workflow_runs', mode = 'view' } = {}) {
  if (admin?.roleName === 'super_admin') return query;

  return query.andWhere((allowed) => {
    // Test runs have an explicit initiator.  Automatic runs leave this NULL
    // and are resolved from their source entity below.
    allowed.where(`${alias}.initiated_by_admin_id`, admin.id);
    allowed.orWhere((branch) => {
      branch.where(`${alias}.entity_type`, 'event');
      if (hasGlobalAccess(admin, mode)) {
        branch.whereExists(eventExists(`${alias}.entity_id`, 'we_event'));
      } else {
        branch.whereExists(ownedEventExists(`${alias}.entity_id`, admin, 'we_event'));
      }
    })
      .orWhere((branch) => branch
        .where(`${alias}.entity_type`, 'invoice')
        .whereExists(accessibleInvoiceExists(`${alias}.entity_id`, admin)))
      .orWhere((branch) => branch
        .where(`${alias}.entity_type`, 'quote')
        .whereExists(db('quotes as we_quote').select(db.raw('1'))
          .whereColumn('we_quote.id', `${alias}.entity_id`)
          .andWhere((source) => source
            .where((event) => event.whereNotNull('we_quote.converted_event_id')
              .whereExists(ownedEventExists('we_quote.converted_event_id', admin, 'we_quote_event')))
            .orWhere((owner) => owner.whereNull('we_quote.converted_event_id')
              .where('we_quote.created_by_admin_id', admin.id)))))
      .orWhere((branch) => branch
        .where(`${alias}.entity_type`, 'contract')
        .whereExists(db('contracts as we_contract').select(db.raw('1'))
          .whereColumn('we_contract.id', `${alias}.entity_id`)
          .andWhere((source) => source
            .where((event) => event.whereNotNull('we_contract.converted_event_id')
              .whereExists(ownedEventExists('we_contract.converted_event_id', admin, 'we_contract_event')))
            .orWhere((quote) => quote.whereNull('we_contract.converted_event_id')
              .whereExists(accessibleQuoteEventExists(
                'we_contract.source_quote_id', admin, 'we_contract_quote', 'we_contract_quote_event',
              )))
            .orWhere((owner) => owner.whereNull('we_contract.converted_event_id')
              .whereNotExists(quoteWithResolvedEventExists('we_contract.source_quote_id', 'we_contract_any_quote'))
              .where('we_contract.created_by_admin_id', admin.id)))))
      .orWhere((branch) => branch
        .where(`${alias}.entity_type`, 'customer')
        .whereExists(customerOwnedExists(`${alias}.entity_id`, admin, 'we_customer')));
  });
}

async function resolveEventAccess(admin, eventId, mode) {
  const event = await db('events').where({ id: eventId }).first('id', 'created_by');
  if (!event) return false;
  return mode === 'view' ? (seesAllEvents(admin) || canAccessEvent(admin, event)) : canAccessEvent(admin, event);
}

async function resolveCrmEventAccess(admin, eventId) {
  const event = await db('events').where({ id: eventId }).first('id', 'created_by');
  return Boolean(event && (event.created_by == null || Number(event.created_by) === Number(admin.id)));
}

async function resolveContractEvent(contract) {
  if (contract.converted_event_id != null) return contract.converted_event_id;
  if (contract.source_quote_id == null) return null;
  const quote = await db('quotes').where({ id: contract.source_quote_id }).first('converted_event_id');
  return quote?.converted_event_id ?? null;
}

async function resolveInvoiceEvent(invoice) {
  if (invoice.event_id != null) return invoice.event_id;
  if (invoice.source_contract_id != null) {
    const contract = await db('contracts').where({ id: invoice.source_contract_id })
      .first('converted_event_id', 'source_quote_id');
    const eventId = contract ? await resolveContractEvent(contract) : null;
    if (eventId != null) return eventId;
  }
  if (invoice.source_quote_id != null) {
    const quote = await db('quotes').where({ id: invoice.source_quote_id }).first('converted_event_id');
    if (quote?.converted_event_id != null) return quote.converted_event_id;
  }
  return null;
}

/** Point check used before an admin test-run can bind to an entity. */
async function canAccessWorkflowEntity(admin, entityType, entityId, { mode = 'view' } = {}) {
  if (admin?.roleName === 'super_admin') return true;
  if (!admin || entityId == null) return false;

  if (entityType === 'event') return resolveEventAccess(admin, entityId, mode);
  if (entityType === 'invoice') {
    const row = await db('invoices').where({ id: entityId })
      .first('event_id', 'source_contract_id', 'source_quote_id', 'created_by_admin_id');
    if (!row) return false;
    const eventId = await resolveInvoiceEvent(row);
    return eventId != null
      ? resolveCrmEventAccess(admin, eventId)
      : Number(row.created_by_admin_id) === Number(admin.id);
  }
  if (entityType === 'quote') {
    const row = await db('quotes').where({ id: entityId }).first('converted_event_id', 'created_by_admin_id');
    if (!row) return false;
    return row.converted_event_id != null
      ? resolveCrmEventAccess(admin, row.converted_event_id)
      : Number(row.created_by_admin_id) === Number(admin.id);
  }
  if (entityType === 'contract') {
    const row = await db('contracts').where({ id: entityId })
      .first('converted_event_id', 'source_quote_id', 'created_by_admin_id');
    if (!row) return false;
    const eventId = await resolveContractEvent(row);
    return eventId != null
      ? resolveCrmEventAccess(admin, eventId)
      : Number(row.created_by_admin_id) === Number(admin.id);
  }
  if (entityType === 'customer') {
    const row = await db('customer_accounts').where({ id: entityId }).first('created_by_admin_id');
    return Number(row?.created_by_admin_id) === Number(admin.id);
  }
  return false;
}

async function canAccessWorkflowRun(admin, runId, { mode = 'view' } = {}) {
  const query = db('workflow_runs as workflow_access_run')
    .where('workflow_access_run.id', runId)
    .select('workflow_access_run.id');
  scopeWorkflowRunsQuery(query, admin, { alias: 'workflow_access_run', mode });
  return Boolean(await query.first());
}

// Run vars that open a gallery on their own: galleryLink is the share URL,
// which embeds the share token (gallery.published / expiring / completed).
const RUN_BEARER_SECRET_VARS = ['galleryLink'];

/**
 * Run or approval rows without the gallery link in `row[field].vars` when the
 * run belongs to an event the admin reads but cannot act on, the rule
 * withoutForeignEventSecrets applies to the event itself. `field` must already
 * be parsed. One events lookup for the whole page.
 */
async function withoutForeignRunSecrets(rows, admin, field) {
  if (admin?.roleName === 'super_admin') return rows;
  const eventIds = [...new Set(rows
    .filter((row) => row.entity_type === 'event' && row.entity_id != null)
    .map((row) => Number(row.entity_id)))];
  if (!eventIds.length) return rows;
  const events = await db('events').whereIn('id', eventIds).select('id', 'created_by');
  const actionable = new Set(events
    .filter((event) => canAccessEvent(admin, event)).map((event) => Number(event.id)));
  return rows.map((row) => {
    if (row.entity_type !== 'event' || actionable.has(Number(row.entity_id))) return row;
    const vars = row[field]?.vars;
    if (!vars || typeof vars !== 'object') return row;
    const copy = { ...vars };
    for (const key of RUN_BEARER_SECRET_VARS) delete copy[key];
    return { ...row, [field]: { ...row[field], vars: copy } };
  });
}

module.exports = {
  canAccessWorkflowEntity,
  canAccessWorkflowRun,
  scopeWorkflowRunsQuery,
  withoutForeignRunSecrets,
};
