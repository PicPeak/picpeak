# CRM disclaimers — important reading for every picpeak operator

The CRM module ships defaults that touch two regulated areas: **legally
binding contracts** and **payment instruments (QR-bills, IBAN/BIC)**.
The text and data picpeak renders are mechanically correct, but the
**substance is the operator's responsibility**.

> [!IMPORTANT]
> Whatever picpeak ships in these two areas is an **EXAMPLE ONLY**. It is
> every operator's own duty to have the content reviewed by their lawyer
> (for contracts) and verified with their bank (for QR-bills / SEPA EPC
> payloads) before sending it to a customer. Picpeak does not provide
> legal advice and cannot validate banking data — only the operator can.

## 1. Contract block library

The contract feature (`feat/crm`, migration `130_add_contracts.js`) seeds
twelve "system" blocks across six sections:

- Basics — contract subject / scope-of-work header
- Scope — image-rights clauses (private + commercial variants)
- Privacy — model-release clauses (private / commercial / minors), DSGVO notice
- Commercial — payment-terms reference, tiered cancellation schedule
- NDA — mutual confidentiality
- Closing — jurisdiction (CH + DE variants)

All bodies are hand-written by the picpeak maintainer (DE first, EN
translated). **None of them have been reviewed by a lawyer.** They are
intended as starting points — every operator must:

1. Read each system block they intend to send.
2. Adjust the body text to match their own jurisdiction, business
   structure, and risk profile, in consultation with their lawyer.
3. Where appropriate, replace a system block entirely with admin-authored
   blocks under their lawyer's guidance.

The admin UI surfaces this disclaimer:
- as a persistent banner on the Block Library page,
- as a persistent banner on the Contract Editor,
- as a "system block" badge plus an "Examples only — have your lawyer
  review" line on every seeded block's description.

System blocks **cannot be deleted** (the seed migration would re-create
them on re-run); operators who reject a seeded block toggle
`is_active=false` on it so it stops appearing in new contracts. The body
text of a system block is fully editable — when an operator's lawyer
delivers a reviewed version, the operator pastes it into the system
block and the new body is what gets snapshotted onto every subsequent
contract.

## 2. QR-bill / SEPA EPC payment payloads

Picpeak is an open-source project. The invoice feature renders Swiss
QR-bills and SEPA EPC QR codes from the data you typed (IBAN, BIC,
account holder, amount, reference) — that's it. We don't have a way to
tell whether the code actually scans correctly in your bank's app, so
**please test that yourself before sending real invoices**.

Before going live:

1. Print one test invoice with the QR code.
2. Scan it with the e-banking app of your own bank.
3. If you expect customers on other banks (UBS, PostFinance, Raiffeisen,
   Migros Bank for Swiss QR; any major SEPA bank for EPC QR), scan with
   those too.
4. If it doesn't scan or the prefilled fields look wrong, fix your
   bank-account data in picpeak and try again.

**We are not responsible for any mistakes** in the rendered QR codes,
payment data, or anything that flows from sending an invoice with bad
data on it. That's why picpeak is MIT-licensed — use it freely, but
the verification is on you.

The admin UI surfaces this same note as a banner on the Business
Profile → Bank Accounts and QR-format settings pages.

## 3. Signature type — picpeak provides SES, not QES

The contract signing flow (typed name + acceptance checkbox + canvas
signature image + IP address + timestamp + SHA-256 audit page) is a
**Simple Electronic Signature (SES)** under the EU eIDAS regulation
and the Swiss ZertES. SES is the same legal tier as DocuSign's basic
plan, HelloSign's free tier, or Adobe Acrobat Sign without a
qualified-certificate add-on.

### What SES is legally sufficient for

In DACH (CH, DE, AT, FL), SES is valid and routinely upheld in civil
court for contracts that **don't** legally require a specific form:

- Photography service agreements
- Image-rights / model-release clauses
- Cancellation policies
- NDAs between private parties
- Most commercial service contracts
- Most B2B agreements

For these, picpeak's evidence chain (frozen block bodies + signature
images + names + IPs + timestamps + content hashes + immutable
audit-log timeline) is comparable to what an SES provider charging
€10–30/month delivers. The audit page appended to the signed PDF
makes the evidence self-contained — the customer can re-hash their
copy and prove integrity without trusting picpeak's database.

### What SES is NOT sufficient for

Certain documents **legally require Schriftform** (handwritten
signature on paper) OR a **Qualified Electronic Signature (QES)**
backed by a certificate from an accredited Trust Service Provider
(Swisscom Sign, D-Trust, A-Trust, Bundesdruckerei, etc.). The most
common categories in DACH:

| Jurisdiction | Document type | Statute |
|---|---|---|
| DE | Bürgschaft (guaranty) | § 766 BGB |
| DE | Verbraucherdarlehensvertrag (consumer loan) | § 492 BGB |
| DE | Befristete Arbeitsverträge (fixed-term employment) | § 14 Abs. 4 TzBfG |
| DE | Kündigung Arbeitsverhältnis (employment termination) | § 623 BGB |
| DE | Aufhebungsvertrag (employment cancellation agreement) | § 623 BGB |
| CH | Bürgschaft above CHF 2'000 | Art. 493 OR |
| CH | Eheverträge (matrimonial property agreements) | Art. 184 ZGB |
| AT | Bürgschaftserklärung (guaranty declaration) | § 1346 ABGB |

If you send any of these via picpeak's signing flow, the signature
is **legally invalid** and the contract may be unenforceable. Use a
QES provider for these documents.

If you're unsure which category your contract falls into, ask your
lawyer. The cost of asking is hours; the cost of getting it wrong
is years.

### What picpeak does NOT provide

- **Identity verification.** Anyone who receives the signing email
  can sign. There's no second factor (SMS, video ident, ID upload).
- **Qualified-certificate-based signatures (QES).** Requires a
  separate service.
- **External / third-party timestamp.** All timestamps are
  server-side; an RFC 3161 Trust Service Provider timestamp would
  close the clock-manipulation defence but isn't currently part of
  the audit page.
- **WORM / immutable storage.** Signed PDFs live on the regular
  filesystem path under `storage/business-docs/contract/<year>/`.
  Hardening this for high-stakes contracts is an infrastructure-
  level decision (S3 Object Lock, etc.) outside picpeak's code.

The signing flow is fine for routine photographer-customer
contracts. For anything with significant economic value or
Schriftform-bound documents, layer a QES provider on top of
picpeak's contract management.

## Why this matters

- **Liability.** Sending an unreviewed contract or a malformed QR-bill
  is the operator's liability — not picpeak's. The MIT licence
  explicitly disclaims warranty.
- **Jurisdictional variance.** Even the most carefully drafted clause
  is wrong somewhere. The CH-jurisdiction closing block won't help a
  photographer in Bavaria. The cancellation schedule that's standard
  in Zurich would be challenged in Berlin.

If you are unsure: don't send. Pause, read this file again, and run
your seeded contract content past your lawyer (or scan one test QR-bill
yourself) before turning the feature on for live customers.
