/**
 * invoiceService — lifecycle for `invoices`, line items, payment log.
 *
 * Layers on top of quoteService for the conversion path: quoteService
 * .convertToEvent() calls into scheduleInvoicesForEvent() to fan out
 * one row per installment with the right `scheduled_send_at` relative
 * to the event date.
 *
 * Statuses (`invoices.status`):
 *   scheduled  not yet sent; the scheduler picks it up when
 *              `scheduled_send_at <= now()` and flips to `sent`
 *   sent       email + PDF delivered; awaiting payment
 *   paid       fully paid (paid_amount_minor >= total_amount_minor)
 *   overdue    past due_date + reminder_first_days; reminder fired
 *   cancelled  admin cancelled; no further reminders
 *
 * Per-customer feature override (`customer_accounts.feature_bills`):
 *   when false, the service refuses to create or schedule invoices for
 *   that customer.
 */

//
// Decomposed into ./invoice/* modules (move-code refactor). This file is the
// stable public entry point: same require path, same exported names.

const helpers = require('./invoice/helpers');
const queries = require('./invoice/queries');
const drafts = require('./invoice/drafts');
const create = require('./invoice/create');
const installmentPlan = require('./invoice/installmentPlan');
const render = require('./invoice/render');
const reminders = require('./invoice/reminders');
const payments = require('./invoice/payments');
const sending = require('./invoice/sending');
const scheduler = require('./invoice/scheduler');

const {
  listInvoices, getInvoiceById,
} = queries;
const {
  getOrCreateMonthlyDraft, getMonthlyDraft, appendToMonthlyDraft, appendOneLineItemToMonthlyDraft,
} = drafts;
const { createInvoice, spawnInstallmentInvoices, scheduleInvoicesForEvent } = create;
const { updateInstallmentPlan, validateInstallmentPlanInput } = installmentPlan;
const { renderInvoicePdfBuffer, renderInvoicePdfFromPayload } = render;
const {
  sendReminder, applyReminder, resolveLateFeeNetMinor, resolveLateFeeVatRate,
  resolvePerReminderFeeMinor, resolveSkontoPercentForInvoice,
} = reminders;
const {
  markPaid, queuePaymentCheckEmail, getPaymentCheckByToken, recordPaymentCheckAction,
} = payments;
const {
  sendInvoice, cancelInvoice, releaseForDelivery, reissueInvoice, createStorno, sendStorno,
  triggerMonthlyBillNow,
} = sending;
const { runScheduledTasks } = scheduler;
const { nextInvoiceNumber } = helpers;

module.exports = {
  listInvoices,
  getInvoiceById,
  createInvoice,
  spawnInstallmentInvoices,
  scheduleInvoicesForEvent,
  updateInstallmentPlan,
  validateInstallmentPlanInput,
  sendInvoice,
  sendReminder,
  applyReminder,
  resolveLateFeeNetMinor,
  resolveLateFeeVatRate,
  resolvePerReminderFeeMinor,
  markPaid,
  cancelInvoice,
  releaseForDelivery,
  reissueInvoice,
  createStorno,
  sendStorno,
  queuePaymentCheckEmail,
  getPaymentCheckByToken,
  recordPaymentCheckAction,
  renderInvoicePdfBuffer,
  renderInvoicePdfFromPayload,
  runScheduledTasks,
  resolveSkontoPercentForInvoice,
  // Monthly billing accumulator (migration 128) — exposed so
  // customerHoursService can append hour-logged line items onto the
  // running draft without duplicating the period/totals logic.
  getOrCreateMonthlyDraft,
  getMonthlyDraft,
  appendToMonthlyDraft,
  appendOneLineItemToMonthlyDraft,
  triggerMonthlyBillNow,
  // Exposed so contractService can mint an invoice number for the
  // empty-draft path (convert-to-invoice on a contract with no
  // source quote). Stays gap-free per crm_invoices_number_format.
  nextInvoiceNumber,
};
