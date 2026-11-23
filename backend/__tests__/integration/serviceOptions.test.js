/**
 * Service options end to end (migration 371): a catalogue service carries
 * other services as options, and an invoice with a ticked option stores the
 * option as a sub-line that adds to the parent — net, stored line totals and
 * the flag survive the save and the read the editor reloads from.
 */

const request = require('supertest');
const { formatBoolean } = require('../../src/utils/dbCompat');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

jest.setTimeout(120000);

describe('service options', () => {
  let db;
  let cleanup;
  let adminId;
  let customerId;
  let quoteService;
  let invoiceService;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId, customerId } = await seedMinimal(db));
    quoteService = require('../../src/services/quoteService');
    invoiceService = require('../../src/services/invoiceService');
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  describe('catalogue', () => {
    let gallery;
    let euroItem;

    beforeAll(async () => {
      gallery = await quoteService.createLineItemPreset({ name: 'Online Galerie', unit_price_minor: 3000, currency: 'CHF' });
      euroItem = await quoteService.createLineItemPreset({ name: 'Album', unit_price_minor: 9000, currency: 'EUR' });
    });

    it('stores options on create and update, and lists them', async () => {
      const typeA = await quoteService.createLineItemPreset({
        name: 'Typ A', unit_price_minor: 12000, currency: 'CHF', option_preset_ids: [gallery.id],
      });
      expect(quoteService.presetOptionIds(typeA)).toEqual([gallery.id]);
      const cleared = await quoteService.updateLineItemPreset(typeA.id, { option_preset_ids: [] });
      expect(quoteService.presetOptionIds(cleared)).toEqual([]);
      // A partial edit that leaves options out keeps them.
      await quoteService.updateLineItemPreset(typeA.id, { option_preset_ids: [gallery.id] });
      const renamed = await quoteService.updateLineItemPreset(typeA.id, { name: 'Typ A neu' });
      expect(quoteService.presetOptionIds(renamed)).toEqual([gallery.id]);
    });

    it('refuses an option in another currency, and drops the service itself', async () => {
      await expect(quoteService.createLineItemPreset({
        name: 'Typ B', unit_price_minor: 18000, currency: 'CHF', option_preset_ids: [euroItem.id],
      })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('"Album"') });
      const typeC = await quoteService.createLineItemPreset({ name: 'Typ C', unit_price_minor: 22000, currency: 'CHF' });
      const self = await quoteService.updateLineItemPreset(typeC.id, { option_preset_ids: [typeC.id, gallery.id] });
      expect(quoteService.presetOptionIds(self)).toEqual([gallery.id]);
    });
  });

  it('refuses an album-product service as an option, and prunes one that gets a product', async () => {
    const plain = await quoteService.createLineItemPreset({ name: 'Galerie P', unit_price_minor: 3000, currency: 'CHF' });
    const parent = await quoteService.createLineItemPreset({
      name: 'Typ P', unit_price_minor: 12000, currency: 'CHF', option_preset_ids: [plain.id],
    });
    // Linked to a product afterwards: a tick would book it without its configuration.
    await db('quote_line_item_presets').where({ id: plain.id }).update({ product_id: 'album-1' });
    await expect(quoteService.createLineItemPreset({
      name: 'Typ Q', unit_price_minor: 12000, currency: 'CHF', option_preset_ids: [plain.id],
    })).rejects.toMatchObject({ statusCode: 400 });
    await quoteService.updateLineItemPreset(plain.id, { name: 'Galerie P2' });
    const row = await db('quote_line_item_presets').where({ id: parent.id }).first();
    expect(quoteService.presetOptionIds(row)).toEqual([]);
  });

  it('an option that stops fitting leaves the lists it was in', async () => {
    const option = await quoteService.createLineItemPreset({ name: 'Galerie 2', unit_price_minor: 3000, currency: 'CHF' });
    const other = await quoteService.createLineItemPreset({ name: 'Album 2', unit_price_minor: 5000, currency: 'CHF' });
    const parent = await quoteService.createLineItemPreset({
      name: 'Typ D', unit_price_minor: 12000, currency: 'CHF', option_preset_ids: [option.id, other.id],
    });
    // The option moves to an hourly rate: it no longer fits as a fixed add-on.
    await quoteService.updateLineItemPreset(option.id, { price_mode: 'hour' });
    let row = await db('quote_line_item_presets').where({ id: parent.id }).first();
    expect(quoteService.presetOptionIds(row)).toEqual([other.id]);
    // Archived: gone as well.
    await quoteService.deleteLineItemPreset(other.id);
    row = await db('quote_line_item_presets').where({ id: parent.id }).first();
    expect(quoteService.presetOptionIds(row)).toEqual([]);

    // The parent's own currency changes without resending its options.
    const chf = await quoteService.createLineItemPreset({ name: 'Galerie 3', unit_price_minor: 3000, currency: 'CHF' });
    const typeE = await quoteService.createLineItemPreset({
      name: 'Typ E', unit_price_minor: 12000, currency: 'CHF', option_preset_ids: [chf.id],
    });
    const moved = await quoteService.updateLineItemPreset(typeE.id, { currency: 'EUR' });
    expect(quoteService.presetOptionIds(moved)).toEqual([]);
  });

  it('a quote template keeps an option sub-line adding to its parent', async () => {
    const templates = require('../../src/services/quoteTemplateService');
    const typeB = await quoteService.createLineItemPreset({ name: 'Typ B tpl', unit_price_minor: 18000, currency: 'CHF' });
    const line = (description, unitPriceMinor, extra = {}) => ({
      description, quantity: 1, unitPriceMinor, discountPercent: 0, unit: null, priceMode: null,
      boundTo: null, rateSource: null, detailsText: null, ...extra,
    });
    const id = await templates.createTemplate({
      name: 'Next-Step', currency: 'CHF',
      draft: {
        sections: [{
          type: 'line', isOptional: false,
          line: line('Typ B', 18000),
          children: [line('Online Galerie', 3000, { addsToParent: true })],
        }],
      },
    }, adminId);
    await templates.publishTemplate(id, adminId);
    const { quoteId } = await templates.createQuoteFromTemplate(id, { customerAccountId: customerId }, adminId);
    const quote = await db('quotes').where({ id: quoteId }).first();
    expect(Number(quote.net_amount_minor)).toBe(21000);
    const lines = await db('quote_line_items').where({ quote_id: quoteId }).orderBy('position');
    expect(lines.map((l) => Boolean(Number(l.adds_to_parent)))).toEqual([false, true]);

    // Saving that quote as a template again keeps the flag on the sub-line.
    const templateId = await templates.saveQuoteAsTemplate(quoteId, { name: 'Copy' }, adminId);
    const copy = await db('quote_templates').where({ id: templateId }).first();
    const [section] = JSON.parse(copy.draft_snapshot).sections;
    expect(section.children[0].addsToParent).toBe(true);
    expect(section.line.addsToParent).toBe(false);
    // And the catalogue link, so the quote made from it offers the option again.
    const withLink = await templates.createTemplate({
      name: 'Linked', currency: 'CHF',
      draft: { sections: [{ type: 'line', isOptional: false, line: line('Typ B', 18000, { optionsFromPresetId: typeB.id }), children: [] }] },
    }, adminId);
    const stored = await db('quote_templates').where({ id: withLink }).first();
    expect(JSON.parse(stored.draft_snapshot).sections[0].line.optionsFromPresetId).toBe(typeB.id);
    // Publishing does not re-price the written line through the catalogue,
    // even when its service has since been archived.
    await quoteService.deleteLineItemPreset(typeB.id);
    const crm = require('../../src/services/albumProducts/crm');
    const prepare = jest.spyOn(crm, 'prepareLine');
    await templates.publishTemplate(withLink, adminId);
    // (An archived album-product service would make prepareLine refuse the publish.)
    expect(prepare).not.toHaveBeenCalled();
    prepare.mockRestore();
    const fromLinked = await templates.createQuoteFromTemplate(withLink, { customerAccountId: customerId }, adminId);
    const [linkedLine] = await db('quote_line_items').where({ quote_id: fromLinked.quoteId });
    expect(Number(linkedLine.catalogue_preset_id)).toBe(typeB.id);
    expect(Number(linkedLine.unit_price_minor)).toBe(18000);

    // A link to a service that doesn't exist is dropped, not stored.
    const ghost = await templates.createTemplate({
      name: 'Ghost', currency: 'CHF',
      draft: { sections: [{ type: 'line', isOptional: false, line: line('Typ X', 18000, { optionsFromPresetId: 999999 }), children: [] }] },
    }, adminId);
    await templates.publishTemplate(ghost, adminId);
    const fromGhost = await templates.createQuoteFromTemplate(ghost, { customerAccountId: customerId }, adminId);
    const [ghostLine] = await db('quote_line_items').where({ quote_id: fromGhost.quoteId });
    expect(ghostLine.catalogue_preset_id).toBeNull();
  });

  it('a monthly-billing customer\'s running draft counts the option too', async () => {
    const inserted = await db('customer_accounts').insert({
      email: 'monthly-options@example.com',
      display_name: 'Monthly customer',
      password_hash: 'unused',
      preferred_language: 'de',
      is_active: 1,
      billing_cadence: 'monthly',
      created_at: new Date().toISOString(),
    }).returning('id');
    const monthlyId = inserted[0]?.id ?? inserted[0];
    const lines = (date) => [
      { position: 1, quantity: 1, description: `${date}: Next-Step B`, unit_price_minor: 18000, discount_percent: 0 },
      { position: 2, quantity: 1, description: 'Online Galerie', unit_price_minor: 3000, discount_percent: 0, parent_position: 1, adds_to_parent: true },
    ];
    await invoiceService.createInvoice({ customerAccountId: monthlyId, currency: 'CHF', vatRate: 0, lineItems: lines('28.09.2024') }, adminId);
    await invoiceService.createInvoice({ customerAccountId: monthlyId, currency: 'CHF', vatRate: 0, lineItems: lines('12.10.2024') }, adminId);

    const draft = await db('invoices').where({ customer_account_id: monthlyId }).first();
    // Two appends of 180.00 + 30.00 each.
    expect(Number(draft.net_amount_minor)).toBe(42000);
    const parents = await db('invoice_line_items').where({ invoice_id: draft.id }).whereNull('parent_line_item_id');
    expect(parents.map((l) => Number(l.line_total_minor))).toEqual([21000, 21000]);
  });

  it('a monthly draft resolves lines already on it and honours the round-total setting', async () => {
    const settings = require('../../src/utils/appSettings');
    const inserted = await db('customer_accounts').insert({
      email: 'monthly-rounding@example.com',
      display_name: 'Monthly rounding customer',
      password_hash: 'unused',
      preferred_language: 'de',
      is_active: 1,
      billing_cadence: 'monthly',
      created_at: new Date().toISOString(),
    }).returning('id');
    const monthlyId = inserted[0]?.id ?? inserted[0];
    await invoiceService.createInvoice({
      customerAccountId: monthlyId, currency: 'CHF', vatRate: 0,
      lineItems: [{ position: 1, quantity: 1, description: 'Shoot', unit_price_minor: 10000, discount_percent: 0 }],
    }, adminId);
    const draft = await db('invoices').where({ customer_account_id: monthlyId }).first();
    const [shoot] = await db('invoice_line_items').where({ invoice_id: draft.id });
    // A priced sub-line stored under the shoot without its parent re-totalled,
    // as appends did before: the next append brings the parent in line.
    await db('invoice_line_items').insert({
      invoice_id: draft.id, position: 2, quantity: 1, description: 'Prints', unit_price_minor: 2500,
      discount_percent: 0, line_total_minor: 2500, parent_line_item_id: shoot.id,
    });
    await settings.upsertAppSetting('crm_invoice_round_total', 'true', 'crm');
    try {
      // 1.5 × 0.33 twice: each line rounds 0.495 up to 0.50, together 0.99.
      await invoiceService.createInvoice({
        customerAccountId: monthlyId, currency: 'CHF', vatRate: 0,
        lineItems: [
          { position: 1, quantity: 1.5, description: 'Add-on', unit_price_minor: 33, discount_percent: 0 },
          { position: 2, quantity: 1.5, description: 'Option', unit_price_minor: 33, discount_percent: 0, parent_position: 1, adds_to_parent: true },
        ],
      }, adminId);
    } finally {
      await settings.upsertAppSetting('crm_invoice_round_total', 'false', 'crm');
    }
    const after = await db('invoices').where({ id: draft.id }).first();
    const shootAfter = await db('invoice_line_items').where({ id: shoot.id }).first();
    expect(Number(shootAfter.line_total_minor)).toBe(2500);
    // 25.00 (the shoot, now from its priced sub-line) + 0.99 exact, not 1.00.
    expect(Number(after.net_amount_minor)).toBe(2599);
  });

  it('editing billed hours re-totals the draft by the same rule', async () => {
    const hoursService = require('../../src/services/customerHoursService');
    const inserted = await db('customer_accounts').insert({
      email: 'hours-options@example.com', display_name: 'Hours customer', password_hash: 'unused',
      preferred_language: 'de', is_active: 1, billing_cadence: 'monthly', hourly_rate_minor: 5000,
      created_at: new Date().toISOString(),
    }).returning('id');
    const hoursCustomer = inserted[0]?.id ?? inserted[0];
    const [invoiceRow] = await db('invoices').insert({
      invoice_number: `OPT-HOURS-${hoursCustomer}`, customer_account_id: hoursCustomer, currency: 'CHF',
      issue_date: '2026-09-01', due_date: '2026-09-30', status: 'scheduled', is_monthly_draft: true,
    }).returning('id');
    const invoiceId = invoiceRow?.id ?? invoiceRow;
    // A parent stored at its own price before the rule, with its option below.
    const [parentRow] = await db('invoice_line_items').insert({
      invoice_id: invoiceId, position: 1, description: 'Next-Step B', quantity: 1, unit_price_minor: 18000, line_total_minor: 18000,
    }).returning('id');
    const parentId = parentRow?.id ?? parentRow;
    await db('invoice_line_items').insert({
      invoice_id: invoiceId, position: 2, description: 'Online Galerie', quantity: 1, unit_price_minor: 3000,
      line_total_minor: 3000, parent_line_item_id: parentId, adds_to_parent: true,
    });
    const [hourRow] = await db('invoice_line_items').insert({
      invoice_id: invoiceId, position: 3, description: 'Retusche', quantity: 1, unit_price_minor: 5000, line_total_minor: 5000,
    }).returning('id');
    const hourLineId = hourRow?.id ?? hourRow;
    const [entryRow] = await db('customer_hour_entries').insert({
      customer_account_id: hoursCustomer, entry_date: '2026-09-01', start_time: '09:00', end_time: '10:00',
      duration_minutes: 60, description: 'Retusche', status: 'billed', invoice_id: invoiceId, invoice_line_item_id: hourLineId,
    }).returning('id');
    await hoursService.updateEntry(entryRow?.id ?? entryRow, { endTime: '11:00' }, adminId);
    const invoice = await db('invoices').where({ id: invoiceId }).first();
    // 180.00 + 30.00 option + 2 h at 50.00.
    expect(Number(invoice.net_amount_minor)).toBe(31000);
  });

  it('a parent whose priced sub-line went away is back at its own price', async () => {
    const { resolveUnissuedInvoiceNet } = require('../../src/services/invoice/drafts');
    const [invoiceRow] = await db('invoices').insert({
      invoice_number: `OPT-FALLBACK-${Date.now()}`, customer_account_id: customerId, currency: 'CHF',
      issue_date: '2026-09-01', due_date: '2026-09-30', status: 'scheduled', is_monthly_draft: true,
    }).returning('id');
    const invoiceId = invoiceRow?.id ?? invoiceRow;
    // Stored at 25.00 from a priced sub-line that has since been deleted;
    // an unpriced note line is all that is left under it.
    const [parentRow] = await db('invoice_line_items').insert({
      invoice_id: invoiceId, position: 1, description: 'Shoot', quantity: 1, unit_price_minor: 10000, line_total_minor: 2500,
    }).returning('id');
    const parentId = parentRow?.id ?? parentRow;
    await db('invoice_line_items').insert({
      invoice_id: invoiceId, position: 2, description: 'Note', quantity: 1, unit_price_minor: 0,
      line_total_minor: 0, parent_line_item_id: parentId,
    });
    const net = await db.transaction((trx) => resolveUnissuedInvoiceNet(trx, invoiceId, { actor: adminId, source: 'test' }));
    expect(net.netMinor).toBe(10000);
    expect(Number((await db('invoice_line_items').where({ id: parentId }).first()).line_total_minor)).toBe(10000);
  });

  it('saving an invoice in the editor follows the round-total setting too', async () => {
    const settings = require('../../src/utils/appSettings');
    await assignAdminRole(db, adminId, 'super_admin');
    const value = formatBoolean(true);
    if (!(await db('feature_flags').where({ key: 'bills' }).update({ value }))) await db('feature_flags').insert({ key: 'bills', value });
    const app = buildRouteApp('/api/admin/invoices', require('../../src/routes/adminInvoices'));
    const { invoiceIds } = await invoiceService.createInvoice({
      customerAccountId: customerId, currency: 'CHF', vatRate: 0,
      lineItems: [{ position: 1, quantity: 1, description: 'Start', unit_price_minor: 100, discount_percent: 0 }],
    }, adminId);
    await settings.upsertAppSetting('crm_invoice_round_total', 'true', 'crm');
    try {
      const res = await request(app).put(`/api/admin/invoices/${invoiceIds[0]}`)
        .set('Authorization', `Bearer ${mintAdminToken(adminId)}`)
        .send({
          lineItems: [
            { position: 1, quantity: 1.5, description: 'Add-on', unitPriceMinor: 33, discountPercent: 0 },
            { position: 2, quantity: 1.5, description: 'Option', unitPriceMinor: 33, discountPercent: 0, parentPosition: 1, addsToParent: true },
          ],
        });
      expect([res.status, res.body?.error]).toEqual([200, undefined]);
    } finally {
      await settings.upsertAppSetting('crm_invoice_round_total', 'false', 'crm');
    }
    const invoice = await db('invoices').where({ id: invoiceIds[0] }).first();
    // 0.495 + 0.495 = 0.99 exact; the rounded lines would say 1.00.
    expect(Number(invoice.net_amount_minor)).toBe(99);
  });

  it('an instalment slice counts a main line once, not its option again', async () => {
    const { replaceReconciliationLine } = require('../../src/services/invoice/installmentPlan');
    const [invoiceRow] = await db('invoices').insert({
      invoice_number: `OPT-INST-${Date.now()}`, customer_account_id: customerId, currency: 'CHF',
      issue_date: '2026-09-01', due_date: '2026-09-30', status: 'scheduled',
    }).returning('id');
    const invoiceId = invoiceRow?.id ?? invoiceRow;
    const [parentRow] = await db('invoice_line_items').insert({
      invoice_id: invoiceId, position: 1, description: 'Next-Step B', quantity: 1, unit_price_minor: 18000, line_total_minor: 21000,
    }).returning('id');
    await db('invoice_line_items').insert({
      invoice_id: invoiceId, position: 2, description: 'Online Galerie', quantity: 1, unit_price_minor: 3000,
      line_total_minor: 3000, parent_line_item_id: parentRow?.id ?? parentRow, adds_to_parent: true,
    });
    // The slice is exactly the main line's 210.00: nothing to reconcile.
    await db.transaction((trx) => replaceReconciliationLine(trx, invoiceId, {
      label: 'Anzahlung', percent: 100, index: 0, total: 2, netSlice: 21000, actor: adminId,
    }));
    const lines = await db('invoice_line_items').where({ invoice_id: invoiceId });
    expect(lines).toHaveLength(2);
  });

  it('the shared re-total refuses an invoice that is no longer open', async () => {
    const { resolveUnissuedInvoiceNet } = require('../../src/services/invoice/drafts');
    const [invoiceRow] = await db('invoices').insert({
      invoice_number: `OPT-PAID-${Date.now()}`, customer_account_id: customerId, currency: 'CHF',
      issue_date: '2026-09-01', due_date: '2026-09-30', status: 'paid',
    }).returning('id');
    await expect(db.transaction((trx) => resolveUnissuedInvoiceNet(trx, invoiceRow?.id ?? invoiceRow, {})))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it('refuses a save made from a stale option list', async () => {
    const galleryX = await quoteService.createLineItemPreset({ name: 'Galerie X', unit_price_minor: 3000, currency: 'CHF' });
    const albumX = await quoteService.createLineItemPreset({ name: 'Album X', unit_price_minor: 5000, currency: 'CHF' });
    const service = await quoteService.createLineItemPreset({
      name: 'Typ X', unit_price_minor: 12000, currency: 'CHF', option_preset_ids: [galleryX.id],
    });
    // Another admin added the album since this form loaded [gallery].
    await quoteService.updateLineItemPreset(service.id, { option_preset_ids: [galleryX.id, albumX.id] });
    await expect(quoteService.updateLineItemPreset(service.id, {
      option_preset_ids: [], expected_option_preset_ids: [galleryX.id],
    })).rejects.toMatchObject({ statusCode: 409, code: 'PRESET_OPTIONS_CHANGED' });
    const row = await db('quote_line_item_presets').where({ id: service.id }).first();
    expect(quoteService.presetOptionIds(row)).toEqual([galleryX.id, albumX.id]);
  });

  it('a negative amount is never stored as an option', async () => {
    const { normalizeLineItems: normalize, extendedLineColumns: columns } = require('../../src/utils/lineItemTotals');
    const [, sub] = normalize([
      { position: 1, quantity: 1, unit_price_minor: 1000 },
      { position: 2, quantity: 1, unit_price_minor: -500, parent_position: 1, adds_to_parent: true },
    ]);
    expect(sub.adds_to_parent).toBe(false);
    expect([false, 0]).toContain(columns({ adds_to_parent: true, parent_position: 1, unit_price_minor: -500 }, { invoice: true }).adds_to_parent);
  });

  it('the shared re-total refuses an invoice that is armed for sending', async () => {
    const { resolveUnissuedInvoiceNet } = require('../../src/services/invoice/drafts');
    const [invoiceRow] = await db('invoices').insert({
      invoice_number: `OPT-ARMED-${Date.now()}`, customer_account_id: customerId, currency: 'CHF',
      issue_date: '2026-09-01', due_date: '2026-09-30', status: 'scheduled', scheduled_send_at: new Date(Date.now() - 60000).toISOString(),
    }).returning('id');
    await expect(db.transaction((trx) => resolveUnissuedInvoiceNet(trx, invoiceRow?.id ?? invoiceRow, {})))
      .rejects.toMatchObject({ statusCode: 409 });
    // A send time that can't be read counts as armed too. Only SQLite can
    // hold one; PostgreSQL's timestamptz refuses it at insert.
    if (db.client.config.client !== 'pg') {
      const [garbled] = await db('invoices').insert({
        invoice_number: `OPT-GARBLED-${Date.now()}`, customer_account_id: customerId, currency: 'CHF',
        issue_date: '2026-09-01', due_date: '2026-09-30', status: 'scheduled', scheduled_send_at: 'not a date',
      }).returning('id');
      await expect(db.transaction((trx) => resolveUnissuedInvoiceNet(trx, garbled?.id ?? garbled, {})))
        .rejects.toMatchObject({ statusCode: 409 });
    }
  });

  it('a new instalment sibling keeps option sub-lines under their main line', async () => {
    const { updateInstallmentPlan } = require('../../src/services/invoice/installmentPlan');
    await assignAdminRole(db, adminId, 'super_admin');
    const value = formatBoolean(true);
    if (!(await db('feature_flags').where({ key: 'bills' }).update({ value }))) await db('feature_flags').insert({ key: 'bills', value });
    db.client.pool.acquireTimeoutMillis = 2000;
    const app = buildRouteApp('/api/admin/invoices', require('../../src/routes/adminInvoices'));
    const res = await request(app).post('/api/admin/invoices').set('Authorization', `Bearer ${mintAdminToken(adminId)}`).send({
      customerAccountId: customerId, currency: 'CHF', vatRate: 0,
      lineItems: [
        { position: 1, quantity: 1, description: 'Next-Step B', unitPriceMinor: 18000, discountPercent: 0 },
        { position: 2, quantity: 1, description: 'Online Galerie', unitPriceMinor: 3000, discountPercent: 0, parentPosition: 1, addsToParent: true },
      ],
      installments: [
        { label: 'Anzahlung', percent: 50, trigger: 'quote_accepted', offset_days: 0 },
        { label: 'Rest', percent: 50, trigger: 'after_event', offset_days: 7 },
      ],
    });
    expect([res.status, res.body?.error]).toEqual([201, undefined]);
    const [first] = res.body.invoiceIds.map(Number);
    const { deal_uuid: dealUuid } = await db('invoices').where({ id: first }).first();
    // A third instalment: the new sibling is cloned from the first one.
    await db.transaction((trx) => updateInstallmentPlan({
      trx, dealUuid, adminId,
      installments: [
        { label: 'Anzahlung', percent: 40, trigger: 'quote_accepted', offset_days: 0 },
        { label: 'Zwischen', percent: 30, trigger: 'after_event', offset_days: 7 },
        { label: 'Rest', percent: 30, trigger: 'after_delivery', offset_days: 0 },
      ],
    }));
    const siblings = await db('invoices').where({ deal_uuid: dealUuid }).orderBy('id');
    const newest = siblings[siblings.length - 1];
    const lines = await db('invoice_line_items').where({ invoice_id: newest.id });
    const option = lines.find((l) => l.description === 'Online Galerie');
    expect(option.parent_line_item_id).not.toBeNull();
    expect(Boolean(Number(option.adds_to_parent))).toBe(true);
  });

  it('an option survives quote → invoice, and a reissue (Storno + replacement) of that invoice', async () => {
    const { quoteId } = await (async () => {
      const id = await quoteService.createQuote({
        customerAccountId: customerId, currency: 'CHF', vatRate: 0,
        lineItems: [
          { position: 1, quantity: 1, description: 'Next-Step B', unit_price_minor: 18000, discount_percent: 0 },
          { position: 2, quantity: 1, description: 'Online Galerie', unit_price_minor: 3000, discount_percent: 0, parent_position: 1, adds_to_parent: true },
        ],
      }, adminId);
      return { quoteId: typeof id === 'object' ? (id.id ?? id.quoteId) : id };
    })();
    await db('quotes').where({ id: quoteId }).update({ status: 'accepted' });
    await db('customer_accounts').where({ id: customerId }).update({ feature_bills: formatBoolean(true) }).catch(() => {});
    await quoteService.convertToInvoiceOnly(quoteId, adminId);
    const invoice = await db('invoices').where({ source_quote_id: quoteId }).first();
    expect(Number(invoice.net_amount_minor)).toBe(21000);
    const lines = async (id) => db('invoice_line_items').where({ invoice_id: id }).orderBy('position');
    const optionOf = (rows) => rows.find((l) => l.description === 'Online Galerie');
    expect(Boolean(Number(optionOf(await lines(invoice.id)).adds_to_parent))).toBe(true);

    // Issued, then reissued: a Storno that is its exact negative, and a replacement.
    await db('invoices').where({ id: invoice.id }).update({ status: 'sent' });
    const { replacementId } = await (async () => {
      const result = await invoiceService.reissueInvoice(invoice.id, adminId);
      return { replacementId: result.replacementId ?? result.id ?? result.invoiceId };
    })();
    const storno = await db('invoices').where({ cancels_invoice_id: invoice.id }).first();
    expect(Number(storno.net_amount_minor)).toBe(-21000);
    expect(Boolean(Number(optionOf(await lines(storno.id)).adds_to_parent))).toBe(true);
    const replacement = await db('invoices').where({ replaces_invoice_id: invoice.id }).first();
    expect(replacement.id).toBe(replacementId ?? replacement.id);
    expect(Number(replacement.net_amount_minor)).toBe(21000);
    const replacementOption = optionOf(await lines(replacement.id));
    expect(Boolean(Number(replacementOption.adds_to_parent))).toBe(true);
    expect(replacementOption.parent_line_item_id).not.toBeNull();
  });

  it('an invoice with a ticked option totals parent + option', async () => {
    const { invoiceIds } = await invoiceService.createInvoice({
      customerAccountId: customerId,
      currency: 'CHF',
      vatRate: 0,
      lineItems: [
        { position: 1, quantity: 1, description: '28.09.2024: 10. Next-Step B', unit_price_minor: 18000, discount_percent: 0 },
        {
          position: 2, quantity: 1, description: 'Online Galerie', unit_price_minor: 3000, discount_percent: 0,
          parent_position: 1, adds_to_parent: true, details_text: 'https://photos.example.com/gallery/x',
        },
        { position: 3, quantity: 1, description: '29.09.2024: Portrait A', unit_price_minor: 12000, discount_percent: 0 },
      ],
    }, adminId);

    const invoice = await db('invoices').where({ id: invoiceIds[0] }).first();
    expect(Number(invoice.net_amount_minor)).toBe(33000);
    const lines = await db('invoice_line_items').where({ invoice_id: invoice.id }).orderBy('position');
    expect(lines.map((l) => Number(l.line_total_minor))).toEqual([21000, 3000, 12000]);
    expect(lines.map((l) => Boolean(Number(l.adds_to_parent)))).toEqual([false, true, false]);
  });
});
