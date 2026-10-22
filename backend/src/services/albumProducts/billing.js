'use strict';
const { AppError } = require('../../utils/errors');
const {
  isTruthyFlag,
  extendedLineColumns,
} = require('../../utils/lineItemTotals');
const {
  auditedInsert,
  auditedUpdate,
  auditedDelete,
} = require('../accountingHistory');
const CRM = require('./crm');
const G = require('./library');
const V = require('./validation');
const { retain } = require('./retention');
function scoped(query) {
  const actor = require('../../database/crmAccess').currentCrmActor();
  return actor && actor.roleName !== 'super_admin'
    ? query.where('created_by_admin_id', actor.id)
    : query;
}
async function enabled(tx) {
  return isTruthyFlag(
    (await tx('feature_flags').where({ key: 'bills' }).first())?.value,
  );
}
async function price(tx, offer, snapshot) {
  const preset = await tx('quote_line_item_presets')
    .where({ id: offer.catalogue_preset_id, product_id: offer.product_id })
    .first();
  if (
    !preset ||
    !isTruthyFlag(preset.is_active) ||
    preset.price_mode !== 'fixed'
  )
    throw new AppError(
      'Link an active fixed-price CRM catalogue item before locking this choice',
      409,
      'PRODUCT_PRICE_REQUIRED',
    );
  if (!preset.vat_code)
    throw new AppError(
      'Choose an output VAT code on the CRM catalogue item',
      409,
      'PRODUCT_VAT_REQUIRED',
    );
  if (
    !Number.isSafeInteger(Number(preset.unit_price_minor)) ||
    Number(preset.unit_price_minor) < 0
  )
    throw new AppError(
      'The product base price must be a non-negative amount in minor units',
      409,
      'PRODUCT_PRICE_REQUIRED',
    );
  const vat = await tx('vat_codes')
    .where({ code: preset.vat_code, direction: 'output' })
    .first();
  if (!vat || !isTruthyFlag(vat.active))
    throw new AppError(
      'Choose an active output VAT code on the CRM catalogue item',
      409,
      'PRODUCT_VAT_REQUIRED',
    );
  const base = await CRM.prepareLine(tx, {
    position: 1,
    description: preset.name,
    quantity: 1,
    catalogue_preset_id: preset.id,
  });
  const definition = V.parse(base.configuration_definition);
  const line = CRM.configureLines(
    [base],
    [
      {
        position: 1,
        definitionVersion: definition.version,
        values: G.valuesOf(snapshot),
      },
    ],
  )[0];
  return { preset, vat, line };
}
async function information(tx, offer) {
  if (!offer.show_prices || !offer.catalogue_preset_id || !(await enabled(tx)))
    return null;
  const preset = await tx('quote_line_item_presets')
    .where({ id: offer.catalogue_preset_id, product_id: offer.product_id })
    .first();
  if (!preset || !isTruthyFlag(preset.is_active)) return null;
  return {
    currency: preset.currency,
    baseUnitPriceMinor: Number(preset.unit_price_minor),
    surcharges: V.parse(preset.product_surcharges) || [],
  };
}
async function unlock(tx, offer) {
  const items = await tx('product_billable_items')
    .where({ offer_id: offer.id })
    .forUpdate();
  for (const item of items) {
    if (item.invoice_id) {
      const invoice = await tx('invoices')
        .where({ id: item.invoice_id })
        .first();
      // Native cancellation/Storno is the explicit correction boundary. We
      // never rewrite an invoice line to reflect a later gallery choice.
      if (!invoice || invoice.status !== 'cancelled')
        throw new AppError(
          'This choice has been billed. Cancel/correct its invoice through the normal invoice workflow before changing it.',
          409,
          'PRODUCT_ALREADY_BILLED',
        );
      let previous = invoice;
      const seen = new Set();
      while (previous && !seen.has(previous.id)) {
        seen.add(previous.id);
        const replacements = await tx('invoices').where({
          replaces_invoice_id: previous.id,
        });
        if (replacements.some((row) => row.status !== 'cancelled'))
          throw new AppError(
            'A replacement invoice still bills this product. Correct it before changing the choice.',
            409,
            'PRODUCT_ALREADY_BILLED',
          );
        previous = replacements[0];
      }
    } else
      await auditedDelete(
        tx,
        'product_billable_items',
        { id: item.id },
        { source: 'product.unlock' },
      );
  }
}
async function lock(tx, offer, eventId, adminId) {
  if (!(await enabled(tx))) return;
  // Re-read the association: a request must not supply the financial owner.
  const event = await tx('events').where({ id: eventId }).first();
  const assignments = await tx('event_customer_assignments').where({
    event_id: eventId,
  });
  const customerId =
    offer.billing_customer_id ||
    (assignments.length === 1 ? assignments[0].customer_account_id : null);
  if (
    !customerId ||
    !assignments.some(
      (a) => Number(a.customer_account_id) === Number(customerId),
    )
  )
    throw new AppError(
      'Choose an assigned CRM customer for this gallery product before locking it',
      409,
      'PRODUCT_CUSTOMER_REQUIRED',
    );
  const customer = await tx('customer_accounts')
    .where({ id: customerId })
    .first();
  require('../invoice/helpers').ensureCustomerCanBill(customer);
  if (event.project_id) {
    const project = await tx('projects')
      .where({ id: event.project_id })
      .first();
    if (
      !project ||
      (project.customer_account_id != null &&
        Number(project.customer_account_id) !== Number(customer.id))
    )
      throw new AppError('Gallery project and customer do not match', 409);
  }
  const { preset, vat, line } = await price(
    tx,
    offer,
    V.parse(offer.selection),
  );
  const item = {
    offer_id: offer.id,
    offer_revision: offer.revision,
    customer_account_id: customer.id,
    project_id: event.project_id || null,
    event_id: event.id,
    currency: preset.currency,
    vat_code: vat.code,
    vat_rate: Number(vat.rate),
    line_item: JSON.stringify(line),
    created_by_admin_id: adminId,
  };
  const inserted = await auditedInsert(tx, 'product_billable_items', item, {
    actor: adminId,
    source: 'product.lock',
  });
  item.id = inserted[0]?.id ?? inserted[0];
  // Only an unarmed, unissued invoice is safe to extend automatically. More
  // than one candidate needs the photographer to choose explicitly.
  if (event.project_id) {
    const candidates = await tx('invoices')
      .where({
        customer_account_id: customer.id,
        project_id: event.project_id,
        status: 'scheduled',
        currency: item.currency,
        vat_code: item.vat_code,
        vat_rate: item.vat_rate,
      })
      .whereNull('sent_at')
      .whereNull('scheduled_send_at')
      .whereNull('cancels_invoice_id')
      .forUpdate();
    if (candidates.length === 1)
      await append(tx, candidates[0], [item], adminId);
  }
}
async function append(tx, invoice, items, adminId) {
  if (
    invoice.status !== 'scheduled' ||
    invoice.sent_at ||
    invoice.scheduled_send_at ||
    invoice.cancels_invoice_id
  )
    throw new AppError(
      'Only an unissued, unarmed invoice can receive product items',
      409,
      'INVOICE_ALREADY_ISSUED',
    );
  if (
    items.some(
      (i) =>
        Number(i.customer_account_id) !== Number(invoice.customer_account_id) ||
        i.currency !== invoice.currency ||
        i.vat_code !== invoice.vat_code ||
        Number(i.vat_rate) !== Number(invoice.vat_rate),
    )
  )
    throw new AppError(
      'Customer, currency and VAT must match the target invoice',
      409,
    );
  const history = { actor: adminId, source: 'product.bill' };
  const last = await tx('invoice_line_items')
    .where({ invoice_id: invoice.id })
    .max('position as position')
    .first();
  let position = Number(last?.position || 0),
    net = Number(invoice.net_amount_minor);
  for (const item of items) {
    const line = V.parse(item.line_item);
    const total = Number(line.unit_price_minor);
    const inserted = await auditedInsert(
      tx,
      'invoice_line_items',
      {
        invoice_id: invoice.id,
        position: ++position,
        quantity: 1,
        description: line.description,
        unit_price_minor: total,
        discount_percent: 0,
        line_total_minor: total,
        details_text: line.details_text,
        ...extendedLineColumns(line, { invoice: true }),
      },
      history,
    );
    const id = inserted[0]?.id ?? inserted[0];
    await auditedUpdate(
      tx,
      'product_billable_items',
      (q) => q.where({ id: item.id }).whereNull('invoice_id'),
      { invoice_id: invoice.id, invoice_line_item_id: id },
      history,
    );
    await retain(tx, 'billable', item.id, [line]);
    await retain(tx, 'invoice', invoice.id, [line]);
    net += total;
  }
  const vat = Math.round((net * Number(invoice.vat_rate)) / 100);
  const changed = await auditedUpdate(
    tx,
    'invoices',
    { id: invoice.id, status: 'scheduled' },
    {
      net_amount_minor: net,
      product_items_revision: Number(invoice.product_items_revision || 0) + 1,
      vat_amount_minor: vat,
      total_amount_minor:
        net + vat + Number(invoice.shipping_amount_minor || 0),
      pdf_path: null,
      updated_at: new Date(),
    },
    history,
  );
  if (!changed) throw new AppError('The invoice changed while adding product items; reload before billing', 409, 'INVOICE_ALREADY_ISSUED');
  return invoice.id;
}
async function billEvent(
  db,
  eventId,
  adminId,
  invoiceId = null,
  customerId = null,
  itemIds = null,
) {
  if (!(await enabled(db))) throw new AppError('CRM billing is disabled', 403);
  // Pre-warm native drift checks before taking SQLite's only connection.
  const { hasColumnCached } = require('../../utils/schemaCache');
  await hasColumnCached('invoices', 'vat_code');
  await hasColumnCached('invoices', 'project_id');
  return db.transaction(async (tx) => {
    const event = eventId
      ? await tx('events').where({ id: eventId }).forUpdate().first()
      : null;
    if (eventId && !event) throw new AppError('Gallery not found', 404);
    if (!eventId && !customerId)
      throw new AppError('A customer or gallery is required', 400);
    const query = scoped(tx('product_billable_items'))
      .whereNull('invoice_id')
      .orderBy('created_at')
      .forUpdate();
    if (eventId) query.where({ event_id: eventId });
    if (customerId) query.where({ customer_account_id: customerId });
    if (itemIds != null) {
      if (
        !Array.isArray(itemIds) ||
        !itemIds.length ||
        itemIds.length > 200 ||
        new Set(itemIds).size !== itemIds.length
      )
        throw new AppError('Invalid product item selection', 400);
      if (itemIds.some((id) => !Number.isSafeInteger(id) || id < 1))
        throw new AppError('Invalid product item selection', 400);
      query.whereIn('id', itemIds);
    }
    const items = await query;
    if (itemIds && items.length !== itemIds.length)
      throw new AppError(
        'Some product items changed or are unavailable; reload before billing',
        409,
      );
    if (!items.length)
      throw new AppError(
        'There are no open product items to bill',
        409,
        'NO_OPEN_ITEMS',
      );
    if (
      items.some(
        (i) =>
          i.customer_account_id !== items[0].customer_account_id ||
          i.currency !== items[0].currency ||
          i.vat_code !== items[0].vat_code ||
          Number(i.vat_rate) !== Number(items[0].vat_rate),
      )
    )
      throw new AppError(
        'Bill products with different customers, currencies or VAT codes separately',
        409,
      );
    let id;
    if (invoiceId) {
      const invoice = await tx('invoices')
        .where({
          id: invoiceId,
          customer_account_id: items[0].customer_account_id,
        })
        .forUpdate()
        .first();
      if (
        !invoice ||
        items.some((i) =>
          i.project_id
            ? Number(invoice.project_id) !== Number(i.project_id)
            : i.event_id && Number(invoice.event_id) !== Number(i.event_id),
        )
      )
        throw new AppError(
          'Invoice does not belong to this gallery/project',
          404,
        );
      id = await append(tx, invoice, items, adminId);
    } else {
      const lineItems = items.map((i, n) => ({
        ...V.parse(i.line_item),
        position: n + 1,
      }));
      const projectIds = new Set(items.map((i) => i.project_id));
      const created = await require('../invoiceService').createInvoice(
        {
          customerAccountId: items[0].customer_account_id,
          eventId,
          projectId: projectIds.size === 1 ? items[0].project_id : null,
          currency: items[0].currency,
          vatCode: items[0].vat_code,
          vatRate: Number(items[0].vat_rate),
          lineItems,
          _skipMonthlyRouting: true,
        },
        adminId,
        tx,
      );
      id = created.invoiceIds[0];
      const lines = await tx('invoice_line_items')
        .where({ invoice_id: id })
        .orderBy('position');
      for (let n = 0; n < items.length; n++) {
        await auditedUpdate(
          tx,
          'product_billable_items',
          (q) => q.where({ id: items[n].id }).whereNull('invoice_id'),
          { invoice_id: id, invoice_line_item_id: lines[n].id },
          { actor: adminId, source: 'product.bill' },
        );
        await retain(tx, 'billable', items[n].id, [lineItems[n]]);
      }
    }
    return { invoiceId: id, itemsBilled: items.length };
  });
}
module.exports = { enabled, information, lock, unlock, billEvent, scoped };
