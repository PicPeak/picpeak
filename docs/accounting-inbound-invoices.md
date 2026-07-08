# Accounting — Incoming invoices, expenses & re-bill

> **Status:** built on `feat/accounting-inbound-invoices` (based on `upstream/beta`); not yet merged to `main`.
> **Legal:** every VAT / tax-treatment surface is an *example only* and must be reviewed with a Treuhänder before relying on it. Jurisdiction scope is **Liechtenstein-first** (Swiss/LI rails — QR-bill, LI MWST), not German DATEV/ELSTER/ITSG. See `docs/crm-disclaimers.md`.

## Why
The studio receives supplier invoices/receipts (hotels, equipment, Fremdleistungen). This feature lets an admin **capture** an incoming invoice (upload, **phone/tablet camera**, or **IMAP email intake**), confirm its fields, give it a **disposition**, mark the **supplier payable** paid, and — for client-borne costs — **re-bill it to a client** ("Weiterverrechnung"), consolidated onto the client's bill the same way billable hours are.

## Two distinct entities (split in migration 126)
Incoming invoices and internal expenses are **separate** — one document never appears in both surfaces.

- **Incoming invoices** (`inbound_documents`) — an *external* supplier document. The **row itself is the payable**: it carries the disposition, tax treatment, event booking, re-bill linkage, supplier-payment, note, and (for re-bills) the attached customer. Categorising it **updates the document** — it never derives an `expenses` row. Mark-paid lives here.
- **Expenses** (`expenses`, `inbound_document_id IS NULL`) — *internal* own-costs: `kind = amount | mileage | per_diem` (amount = quantity × rate, rate from accounting settings with per-entry override), optional proof file, booked to an event or the company. Disposition is always `eigener_aufwand`; no supplier payment.

This document covers the **incoming-invoices** surface. Expenses share the markup/re-bill helpers but are otherwise independent.

## Lifecycle
```
capture (upload / camera / email)
   → inbox row, status = unsorted, parse_status = pending
triage (confirm fields + disposition + note)
   ├─ eigener_aufwand → company expense (pick category), booked to company
   ├─ durchlaufend    → pass-through; optionally attach a client (billed at cost)
   ├─ rebill          → re-bill to a client (with markup)
   ├─ duplikat        → status = duplicate (excluded from the books)
   └─ abgelehnt       → status = declined (excluded from the books)
supplier payment (independent axis): markInboundSupplierPayment → supplier_paid
```

### Dispositions
Five: `rebill` · `durchlaufend` (Durchlaufender Posten) · `eigener_aufwand` (company expense) · `duplikat` · `abgelehnt`.

- **`rebill`** — your own supplier cost, invoiced on to a client, usually with a **markup** (percent or flat). Requires a customer.
- **`durchlaufend`** — an amount fronted on behalf of a client and passed through **at cost / VAT-neutral**. May optionally attach a client (then it is re-billed like a rebill, but **never carries a markup** — enforced in both the UI and `categorizeInbound`). With no client it is only booked to an event/company.
- **`eigener_aufwand`** — own cost, not re-billed; pick an expense category for the Erfolgsrechnung.

The triage modal shows an **inline explainer** for the selected disposition (`accounting.disposition.help.*`) and a **note** field on every disposition.

### Re-categorisation
Categorising is **re-runnable** — a categorised invoice can be changed again (e.g. pass-through → company expense), including after the supplier has been paid (supplier-payment and classification are independent axes). When the document was already re-billed, `categorizeInbound` first **unwinds** the prior re-bill line (removes the invoice line, recomputes the invoice totals) before applying the new disposition. It **refuses** (`INVOICE_LOCKED`) only when the re-bill sits on an already-issued invoice — then a Storno is required (`isInvoiceMutable` mirrors the hour-entry lock rules). The only hard lock is an *issued* invoice, never supplier-payment.

### Re-bill: cadence-aware, like hours
Re-bill/pass-through-to-a-customer consolidates onto the client's bill exactly like `customerHoursService`:

- **Monthly / manual customers** — the line is appended **immediately** onto the customer's running monthly draft (via `invoiceService.createInvoice`'s accumulator intercept). `billed_invoice_id` is set at categorise time.
- **Per-event customers** — the item stays **PENDING** in the customer's pool (`customer_account_id` set, `billed_invoice_id` null). The inbox surfaces a **"Pending re-bills"** card grouped by customer; **"Bill these"** (`billPendingRebills`) bundles all of a customer's pending items into **one** invoice (one line per document), then navigates to the bill editor so the admin can add more lines before sending. This mirrors `billUnbilledEntries`.

Markup resolution (rebill only): expense/document override → contract `Spesen-Zuschlag` clause → 0% (`resolveMarkup`). The re-bill line description is `"{supplier} (Weiterverrechnung)"` / `"… (Durchlaufende Position)"`.

## Data model (migrations 122–132)
All money is integer minor units (`*_amount_minor`). Additive, hasTable/hasColumn-guarded.

- **122** — seed `accounting` master flag (default OFF; preserve-visuals auto-enable where `taxReport` was on).
- **123** — `accounting.view` / `accounting.manage` permissions.
- **124** — `inbound_documents`, `expenses`, `expense_categories` (+ seed categories).
- **125** — contract `expense_markup_type|_percent|_flat_minor` (Spesen-Zuschlag clause).
- **126** — split incoming vs expenses: disposition/tax_treatment/event_id/category_id, re-bill markup + `billed_invoice_id`/`billed_invoice_line_item_id`, supplier-payment columns on `inbound_documents`; `kind`/`quantity`/`rate_minor` on `expenses`.
- **127** — separate `expenses` sub-flag + accounting `app_settings` (km/per-diem rate, require-proof). *(NB: `app_settings` has no `created_at/updated_at` — seed `setting_key/value/type` only.)*
- **128** — incoming mail (IMAP): `incomingMail` flag + `email_configs.imap_*` + `received_emails`.
- **129** — `ledger_accounts` + `vat_codes` (Swiss/LI KMU seed) + category→account mapping.
- **130** — `vat_code` snapshot column on quotes + invoices.
- **132** — `inbound_documents.note` + `inbound_documents.customer_account_id` (the attached re-bill client; loose link, indexed for the pending-pool lookup).

`inbound_documents` key columns: parsed fields (`supplier_name`, `invoice_date`, `total/net/vat_amount_minor`, `iban`, `payment_reference`) + separate untrusted `qr_amount_minor` (tamper cross-check — the authoritative total is the text value); `status` (unsorted/categorized/declined/duplicate); `disposition`; `tax_treatment`; `event_id` (NULL = company); `category_id`; `customer_account_id`; `markup_type/_percent/_flat_minor`; `billed_invoice_id` + `_line_item_id`; `supplier_paid` + `_at/_method/_ref`; `note`.

## API (`/api/admin/expenses`, gated by `incomingInvoices` + `accounting.*`)
- `POST /inbound` (multipart) — capture (upload/camera). Deduped by SHA-256.
- `GET  /inbound` — list (joins the attached customer name/email).
- `GET  /inbound/pending-summary` — per-customer pending re-bills (registered before `/inbound/:id`).
- `POST /inbound/bill-pending` — bundle one customer's pending re-bills into one invoice.
- `GET  /inbound/:id` · `PATCH /inbound/:id` (edit/confirm fields incl. `note`).
- `GET  /inbound/:id/page/:n` — rasterised PNG of a page. `GET /inbound/:id/file` — original (PDFs as attachment only, never inline).
- `POST /inbound/:id/categorize` — set disposition (re-runnable; unwinds prior re-bill).
- `POST /inbound/:id/rebill` — explicit "re-bill this one now" (forces an immediate single-doc bill).
- `POST /inbound/:id/supplier-payment` — toggle supplier paid + method/date/reference.
- Expenses: `GET/POST /`, `GET/PATCH /:id`, `POST /:id/invoice`, `POST /:id/paid`, `GET /:id/proof`.
- Categories: `GET/POST/PATCH/DELETE /categories` (accounting master).

## Document preview = server-side rasterised images
Raw PDFs are **never** served inline. `rasterizeService` shells out to poppler `pdftoppm` (OS package in the Docker image — not a Node PDF lib, runs no JS, no egress). Pages cached under `storage/business-docs/inbound/rendered/<id>/page-<n>.png`, served with `Content-Security-Policy: default-src 'none'` + `nosniff`. Page count capped at 200. The triage preview defaults to the last page (the Swiss QR-bill usually sits at the bottom).

## Reporting & export
- **Tax report** (`taxReportService`) — full Einnahmen-Ausgaben: incoming invoices + expenses feed the `costs` side, grouped Company vs Event; re-billed costs are kept (the matching re-bill revenue is also counted, so it nets). `vatPayable` = output VAT − reclaimable input VAT (excludes `foreign_vat_non_reclaimable`); zero when not VAT-registered. Gated on `accounting` + `taxReport` (no longer `bills`).
- **Treuhänder export** (`ledgerService`) — accrual Buchungssätze → generic/Banana/bexio CSV. Accrual basis only; bank/payment postings are Layer B (deferred). See `project_banana_treuhaender_export_format`.
- VAT config (codes, rate→code + treatment→code maps, registration & reclaim countries, chart of accounts) lives under **Settings → Accounting**; invoices snapshot the chosen `vat_code`.

## Flag model
`accounting` is an explicit top-level **master** flag with sub-toggles: `incomingInvoices` (this surface), `expenses` (internal expenses), `taxReport` (moved permanently out of CRM, now independent of `bills`). `incomingMail` (IMAP) is a separate flag, not under accounting. `accounting` off forces `taxReport` + `incomingInvoices` off.

## Conventions followed
Idempotent migrations; new flags default OFF; flag reads tolerate `true|1|'1'`; money as integer `*_minor`; `requirePermission` guards; camelCase API ↔ snake_case service; multer + `safePath` containment at every file boundary; localized dates via `useLocalizedDate`; money via `utils/money`; every tax/legal surface carries a "verify with your Treuhänder" disclaimer.

## Deferred
- **OCR / auto-extract** — `extractionService` is a no-op stub (Tesseract + Swiss-QR decode); admin reads the slip and types the fields.
- **Capture-time VAT reclaim default** — `accounting_vat_reclaim_countries` is stored but not yet consumed; needs a `supplier_country` column to default `tax_treatment`.
- **Bank reconciliation** — match incoming payments to open invoices / confirm supplier invoices paid (LLB DataFeed / camt.053 / EBICS). Phased, Swiss/LI rails.
- **Native double-entry (Layer B)** — picpeak stays a feeder/export tool below the CHF 500k threshold; full Erfolgsrechnung/Bilanz is out of scope.
