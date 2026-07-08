/**
 * Migration 107 — CRM consolidated schema + seeds.
 *
 * ---------------------------------------------------------------------------
 *
 * Single migration that brings up the entire CRM feature area:
 *
 *   - Quotes / Invoices / Contracts data layer (tables, FKs, indexes)
 *   - Payment-term templates (legacy + split: net-days + timing)
 *   - Installment plans, deal_uuid lineage across quotes / contracts /
 *     invoices, monthly billing accumulator
 *   - Customer hour-logging tables + customer-side feature flags
 *   - Admin calendar columns on events, pre-event reminder columns
 *   - Document sequence helper (gap-free atomic numbering)
 *   - Email templates seeded for all CRM lifecycle events (en + de)
 *   - RBAC permissions for the new resources (split customers.* too)
 *   - Feature flags (quotes / bills / contracts / hoursLogging / taxReport /
 *     calendar / calendarBooking / reminderEmails / crmDevelopment / messaging)
 *
 * Replaces the in-flight chain of 42 separate migrations (102..143 on
 * the `feat/crm` branch). Each table is created in its FINAL form via
 * a single createTable() — no ALTER chains. Seeds are grouped by target
 * table at the bottom.
 *
 * ---------------------------------------------------------------------------
 *
 * Sections (in order):
 *
 *   1. Issuer block — business_profile (singleton) + business_bank_accounts
 *   2. Payment-term templates — legacy + split (net-days + timing)
 *   3. Quotes — table, line items, line-item presets, action tokens
 *   4. Invoices — table, line items, payment log
 *   5. Contracts — table, blocks, block inclusions, action tokens,
 *      signatures, payments-tokens
 *   6. Event ↔ document glue — event_payment_plans
 *   7. Customer hour logging — customer_hour_entries
 *   8. Document sequences — atomic gap-free numbering helper
 *   9. ALTER existing upstream tables — events / customer_accounts /
 *      monthly_billings / app_settings / admin_users
 *  10. Seeds — payment-term templates (system rows)
 *  11. Seeds — split payment templates (net-days + timing)
 *  12. Seeds — email templates (8 from 102 + per-event-type reminders)
 *  13. Seeds — RBAC permissions (4 new + split customers.*)
 *  14. Seeds — feature flags + app_settings (CRM defaults, ToS,
 *      payment defaults, reminder defaults, locked roadmap force-off)
 *
 * ---------------------------------------------------------------------------
 *
 * Idempotency: every step is guarded by hasTable / hasColumn / row-
 * existence check. Safe to re-run; safe on a partial-state DB.
 *
 * Money is INTEGER minor units (cents/Rappen) + ISO 4217 currency code.
 * Never DECIMAL/FLOAT — avoids floating-point drift on totals.
 *
 * Cross-dialect: tested on SQLite + PostgreSQL. JSON columns use
 * `t.jsonb` where available (`t.json` falls back).
 *
 * Translations: en + de hand-translated. fr/nl/pt/ru are intentionally
 * absent on email templates; the renderer falls through to en until
 * the admin overrides them via Templates UI. Flag for native review
 * in the PR description.
 */

const crypto = require('crypto');

// ===========================================================================
// Inline seed payloads — kept at the top of the file so reviewers can scan
// the seeded data without scrolling past 1000 lines of schema. Schema first,
// then SEEDS section at the bottom of up() references these.
// ===========================================================================

// Seeded inside Section 2 createTable blocks (only fire on fresh table
// creation — no idempotency check needed). 102 + 124 source migrations.
const SYSTEM_PAYMENT_TERM_TEMPLATES = [
  {
    name: 'Komplettzahlung nach Auslieferung',
    description: 'Zahlbar nach Erhalt der Bilder, ohne Abzüge.',
    net_days: 30,
    skonto_percent: null,
    skonto_within_days: null,
    installments: [
      { label: 'Gesamtbetrag nach Auslieferung', percent: 100, trigger: 'after_delivery', offset_days: 0 },
    ],
    display_order: 10,
  },
  {
    name: 'Komplettzahlung vor Event',
    description: 'Zahlbar 7 Tage vor dem Event.',
    net_days: 30,
    skonto_percent: null,
    skonto_within_days: null,
    installments: [
      { label: 'Gesamtbetrag vor Event', percent: 100, trigger: 'before_event', offset_days: -7 },
    ],
    display_order: 20,
  },
  {
    name: 'Komplettzahlung nach Event',
    description: 'Zahlbar nach dem Event, vor Auslieferung.',
    net_days: 30,
    skonto_percent: null,
    skonto_within_days: null,
    installments: [
      { label: 'Gesamtbetrag nach Event', percent: 100, trigger: 'after_event', offset_days: 0 },
    ],
    display_order: 30,
  },
  {
    name: '3 Raten 30/30/40',
    description: '30% bei Auftragsbestätigung, 30% vor Event, 40% nach Auslieferung.',
    net_days: 30,
    skonto_percent: null,
    skonto_within_days: null,
    installments: [
      { label: 'Anzahlung bei Auftragsbestätigung', percent: 30, trigger: 'quote_accepted', offset_days: 0 },
      { label: 'Teilzahlung vor Event', percent: 30, trigger: 'before_event', offset_days: -7 },
      { label: 'Schlusszahlung nach Auslieferung', percent: 40, trigger: 'after_delivery', offset_days: 0 },
    ],
    display_order: 40,
  },
];

// Net-days side of the split (mig 124). "Sofort fällig" = net_days=0 —
// invoiced amount due on issue date.
const SYSTEM_NET_DAYS = [
  { name: 'Sofort fällig',  net_days: 0,  display_order: 5  },
  { name: 'Net 14',         net_days: 14, display_order: 10 },
  { name: 'Net 30',         net_days: 30, display_order: 20 },
  { name: 'Net 60',         net_days: 60, display_order: 30 },
  { name: 'Net 90',         net_days: 90, display_order: 40 },
];

// Timing side of the split (mig 124). Names match SYSTEM_PAYMENT_TERM_TEMPLATES
// so the old + new system rows are equivalent — the backfill on existing
// installs name-matches against this list.
const SYSTEM_TIMING = SYSTEM_PAYMENT_TERM_TEMPLATES.map((t) => ({
  name: t.name,
  description: t.description,
  installments: t.installments,
  display_order: t.display_order,
}));

// Contract block library system seeds (mig 130 + 131). Twelve
// EXAMPLES-ONLY blocks across six sections — every body carries the
// "have your lawyer review before sending" disclaimer in its
// description. The quote_line_items_table block (mig 131) is a
// special render-time inclusion: contractService injects a real PDF
// table of the source quote's line items below the body when this
// block is included on a contract that has a source quote.
const SYSTEM_BLOCKS = [
  // ---- BASICS ----
  {
    slug: 'basics_service',
    section: 'basics',
    name: 'Vertragsgegenstand (Foto-/Videoauftrag)',
    description: 'EXAMPLE — have your lawyer review before sending. Beschreibt Art und Umfang der zu erbringenden fotografischen / filmischen Leistungen.',
    display_order: 10,
    body_text_de: `**Vertragsgegenstand**

Der Auftraggeber ({{customer_name}}) beauftragt den Auftragnehmer ({{issuer_company_name}}) mit der Erbringung der nachfolgend beschriebenen fotografischen und/oder filmischen Leistungen im Rahmen der Veranstaltung „{{event_name}}" am {{event_date}}.

Die konkrete Leistungsbeschreibung (Anzahl Stunden, Locations, Lieferumfang) ergibt sich aus dem zugrundeliegenden Angebot bzw. aus der Auftragsbestätigung.`,
    body_text: `**Subject of contract**

The client ({{customer_name}}) commissions the contractor ({{issuer_company_name}}) to provide the photographic and/or filming services described below in connection with the event "{{event_name}}" on {{event_date}}.

The specific scope of work (hours, locations, deliverables) is set out in the underlying quote or in the order confirmation.`,
  },

  // ---- SCOPE ----
  {
    slug: 'image_rights_private',
    section: 'scope',
    name: 'Bildrechte – privater Gebrauch',
    description: 'EXAMPLE — have your lawyer review before sending. Standardklausel für private Endkunden (Hochzeit, Familie, Portrait). Kein kommerzieller Gebrauch.',
    display_order: 10,
    body_text_de: `**Bildrechte – privater Gebrauch**

Der Auftraggeber erhält ein einfaches, zeitlich und örtlich unbeschränktes Nutzungsrecht an den gelieferten Bildern für ausschliesslich private Zwecke (Familienalbum, Druck, Versand an Freunde und Verwandte, Social-Media-Beiträge im persönlichen Kontext).

Eine kommerzielle Nutzung – insbesondere Werbung, Verkauf, Lizenzierung an Dritte sowie redaktionelle Veröffentlichung – ist ausdrücklich nicht eingeschlossen und bedarf einer separaten schriftlichen Vereinbarung.

Das Urheberrecht verbleibt vollständig beim Auftragnehmer.`,
    body_text: `**Image rights — private use**

The client receives a simple, time- and location-unlimited usage right to the delivered images for strictly private purposes (family album, prints, sharing with friends and relatives, social-media posts in a personal context).

Commercial use — in particular advertising, resale, licensing to third parties, and editorial publication — is expressly NOT included and requires a separate written agreement.

Copyright remains entirely with the contractor.`,
  },
  {
    slug: 'image_rights_commercial',
    section: 'scope',
    name: 'Bildrechte – kommerzielle Nutzung',
    description: 'EXAMPLE — have your lawyer review before sending. Erweiterte Klausel für Geschäftskunden, Agenturen, Marken. Lizenzumfang muss im Auftrag konkretisiert werden.',
    display_order: 20,
    body_text_de: `**Bildrechte – kommerzielle Nutzung**

Der Auftraggeber erhält ein einfaches, nicht-ausschliessliches Nutzungsrecht an den gelieferten Bildern für die im Auftrag bezeichneten kommerziellen Zwecke (Werbung, Online-Marketing, Printmedien, Social-Media-Kommunikation des Auftraggebers).

Der räumliche und zeitliche Lizenzumfang sowie zulässige Bearbeitungen sind im Hauptauftrag bzw. im Angebot zu konkretisieren. Eine Übertragung der Nutzungsrechte an Dritte (z. B. Agenturen, Konzerngesellschaften, Vertragspartner) sowie eine Sublizenzierung sind nur nach vorheriger schriftlicher Zustimmung des Auftragnehmers zulässig.

Der Auftragnehmer hat das Recht, ihn als Urheber gemäss § 13 UrhG bzw. den jeweils anwendbaren urheberrechtlichen Vorschriften zu nennen. Verstösse gegen die Nennungspflicht berechtigen den Auftragnehmer zu einem Aufschlag von 100 % auf die ursprüngliche Lizenzgebühr.

Das Urheberrecht verbleibt beim Auftragnehmer.`,
    body_text: `**Image rights — commercial use**

The client receives a simple, non-exclusive usage right to the delivered images for the commercial purposes specified in the order (advertising, online marketing, print media, the client's social-media communication).

The territorial and temporal scope of the licence and permitted edits are to be set out in the main order or in the quote. A transfer of usage rights to third parties (e.g. agencies, group companies, contractual partners) or sublicensing is only permitted with the contractor's prior written consent.

The contractor is entitled to be named as author in accordance with the applicable copyright law (§ 13 German Copyright Act / equivalent). Breaches of the attribution obligation entitle the contractor to a surcharge of 100 % on the original licence fee.

Copyright remains with the contractor.`,
  },

  // ---- PRIVACY ----
  {
    slug: 'model_release_private',
    section: 'privacy',
    name: 'Modelvertrag / Persönlichkeitsrecht – privat',
    description: 'EXAMPLE — have your lawyer review before sending. Einwilligung zur Anfertigung der Bilder für private Aufträge.',
    display_order: 10,
    body_text_de: `**Einwilligung zur Aufnahme**

Der Auftraggeber bestätigt, alle von ihm benannten und auf den Aufnahmen erkennbaren Personen vorab darüber informiert zu haben, dass im Rahmen der Veranstaltung Foto- und/oder Filmaufnahmen entstehen.

Die Aufnahmen werden ausschliesslich zu den im Vertrag vereinbarten privaten Zwecken erstellt. Eine Veröffentlichung durch den Auftragnehmer – etwa im Portfolio oder auf Social Media – findet nur statt, wenn der Auftraggeber dem ausdrücklich (z. B. über die separat angebotene Portfolio-Freigabe) zustimmt.

Bestehende Persönlichkeitsrechte abgebildeter Personen sind vom Auftraggeber zu wahren.`,
    body_text: `**Consent to photography**

The client confirms having informed in advance all persons identified by them and recognisable in the recordings that photographs and/or video will be taken during the event.

The recordings are produced exclusively for the private purposes agreed in the contract. Publication by the contractor — for example in a portfolio or on social media — only takes place if the client expressly consents (e.g. via the separately offered portfolio release).

The client is responsible for safeguarding the personality rights of the persons depicted.`,
  },
  {
    slug: 'model_release_commercial',
    section: 'privacy',
    name: 'Modelvertrag – kommerziell',
    description: 'EXAMPLE — have your lawyer review before sending. Modelvertragsklausel für kommerzielle Shootings; setzt unterschriebene Model-Releases der abgebildeten Personen voraus.',
    display_order: 20,
    body_text_de: `**Persönlichkeitsrechte / Model-Release**

Der Auftraggeber sichert zu, von allen auf den Aufnahmen erkennbaren Personen vor Beginn der Aufnahme eine schriftliche Einwilligungserklärung (Model-Release) einzuholen, die mindestens den im Auftrag definierten Nutzungsumfang abdeckt.

Auf Anforderung des Auftragnehmers übergibt der Auftraggeber Kopien der Releases. Bei minderjährigen Personen ist zusätzlich die Einwilligung beider Erziehungsberechtigter erforderlich.

Der Auftraggeber stellt den Auftragnehmer von allen Ansprüchen Dritter wegen Verletzung von Persönlichkeitsrechten frei, sofern diese aus einer unvollständigen oder fehlerhaften Einwilligung resultieren, die nicht vom Auftragnehmer eingeholt wurde.`,
    body_text: `**Personality rights / model release**

The client warrants that, prior to the start of recording, a written consent (model release) covering at least the scope of use defined in the order has been obtained from every person recognisable in the recordings.

Upon the contractor's request, the client provides copies of the releases. For minors, the consent of both legal guardians is additionally required.

The client indemnifies the contractor against all third-party claims for infringement of personality rights insofar as such claims arise from an incomplete or defective consent that was not obtained by the contractor.`,
  },
  {
    slug: 'model_release_minors',
    section: 'privacy',
    name: 'Aufnahmen von Minderjährigen',
    description: 'EXAMPLE — have your lawyer review before sending. Zusätzliche Klausel, wenn Kinder fotografiert werden. Sollte zusammen mit einem der Model-Release-Blöcke aktiviert werden.',
    display_order: 30,
    body_text_de: `**Aufnahmen von Minderjährigen**

Werden Personen unter 18 Jahren abgebildet, sichert der Auftraggeber zu, vorab die schriftliche Einwilligung sämtlicher Erziehungsberechtigter eingeholt zu haben. Bei getrennt lebenden Erziehungsberechtigten ist die Zustimmung beider Berechtigten erforderlich.

Auf Verlangen der oder des Erziehungsberechtigten sind Aufnahmen einzelner Kinder unverzüglich und ohne Erstattung von der Auslieferung auszunehmen sowie auf Wunsch dauerhaft zu löschen. Bereits ausgelieferte Bilder bleiben hiervon unberührt.`,
    body_text: `**Recordings of minors**

If persons under the age of 18 are depicted, the client warrants having obtained, in advance, the written consent of all legal guardians. Where guardians live separately, the consent of both is required.

At the request of a guardian, recordings of an individual child are to be excluded from delivery without refund and, on request, permanently deleted. Images already delivered are not affected.`,
  },
  {
    slug: 'dsgvo_data_protection',
    section: 'privacy',
    name: 'Datenschutz (DSGVO)',
    description: 'EXAMPLE — have your lawyer review before sending. Hinweis auf Verarbeitung personenbezogener Daten gemäss DSGVO / nDSG.',
    display_order: 40,
    body_text_de: `**Datenschutz**

Der Auftragnehmer verarbeitet personenbezogene Daten des Auftraggebers (Kontaktdaten, Auftragsdaten, gegebenenfalls Bildmaterial) ausschliesslich zur Vertragserfüllung und im Rahmen der gesetzlichen Aufbewahrungspflichten.

Die Verarbeitung erfolgt nach Massgabe der jeweils anwendbaren Datenschutzgesetze (DSGVO, nDSG/CH-DSG). Detaillierte Informationen zu Art, Umfang, Zweck und Speicherdauer sowie zu den Rechten der betroffenen Personen sind der Datenschutzerklärung des Auftragnehmers zu entnehmen.

Bildmaterial, das identifizierbare Personen zeigt, wird ausschliesslich auf gesicherten Systemen verarbeitet und an Dritte nur im Rahmen des im Vertrag definierten Nutzungsumfangs weitergegeben.`,
    body_text: `**Data protection**

The contractor processes the client's personal data (contact details, order data, image material where applicable) exclusively for the purpose of fulfilling the contract and within the scope of statutory retention obligations.

Processing is carried out in accordance with the applicable data-protection laws (GDPR, Swiss FADP). Detailed information on the type, scope, purpose and storage duration as well as on the rights of data subjects can be found in the contractor's privacy notice.

Image material identifying individual persons is processed exclusively on secured systems and shared with third parties only within the scope of use defined in the contract.`,
  },

  // ---- COMMERCIAL ----
  {
    slug: 'payment_terms_reference',
    section: 'commercial',
    name: 'Zahlungsbedingungen (Verweis)',
    description: 'EXAMPLE — have your lawyer review before sending. Verweist auf die im Auftrag / Angebot definierten Zahlungsbedingungen. Die konkreten Zahlen werden über Platzhalter eingefügt.',
    display_order: 10,
    body_text_de: `**Zahlungsbedingungen**

Die Vergütung ergibt sich aus dem zugrundeliegenden Angebot. Sofern dort nicht anders geregelt, ist die Rechnung innerhalb von {{net_days}} Tagen nach Rechnungsdatum ohne Abzug zur Zahlung fällig.

Bei Zahlung innerhalb von {{skonto_within_days}} Tagen nach Rechnungsdatum wird ein Skonto von {{skonto_percent}} % gewährt.

Der Auftraggeber gerät ohne weitere Mahnung in Verzug, wenn er die Rechnung nicht innerhalb der genannten Frist begleicht. Es gelten die gesetzlichen Verzugszinsen.`,
    body_text: `**Payment terms**

The remuneration is set out in the underlying quote. Unless otherwise specified there, the invoice is payable within {{net_days}} days of the invoice date, with no deductions.

For payment within {{skonto_within_days}} days of the invoice date a discount of {{skonto_percent}} % is granted.

The client is in default without further reminder if the invoice is not settled within the stated period. Statutory interest on overdue payments applies.`,
  },
  {
    slug: 'cancellation_tiered',
    section: 'commercial',
    name: 'Stornierungsregelung (gestaffelt)',
    description: 'EXAMPLE — have your lawyer review before sending. Gestaffelte Stornogebühren je nach Vorlaufzeit zum Event. Beträge im Auftrag konkretisierbar.',
    display_order: 20,
    body_text_de: `**Stornierung und Rücktritt**

Bei einer Stornierung durch den Auftraggeber gelten folgende Pauschalen, sofern keine günstigere Vereinbarung erzielt wird:

- bei Stornierung mehr als 60 Tage vor dem Veranstaltungstermin: {{cancellation_30d_percent}} % der vereinbarten Gesamtvergütung
- bei Stornierung 30 bis 60 Tage vor dem Veranstaltungstermin: 50 % der vereinbarten Gesamtvergütung
- bei Stornierung weniger als 30 Tage vor dem Veranstaltungstermin: 75 % der vereinbarten Gesamtvergütung
- bei Stornierung weniger als 7 Tage vor dem Veranstaltungstermin: 100 % der vereinbarten Gesamtvergütung

Bereits geleistete Anzahlungen werden auf die Stornogebühr angerechnet. Dem Auftraggeber bleibt der Nachweis eines geringeren Schadens vorbehalten.

Höhere Gewalt (Krankheit mit ärztlichem Attest, behördliche Anordnungen, Naturkatastrophen) berechtigt beide Parteien zur kostenfreien Verschiebung des Termins.`,
    body_text: `**Cancellation and withdrawal**

If the client cancels, the following flat-rate fees apply unless a more favourable arrangement is reached:

- cancellation more than 60 days before the event: {{cancellation_30d_percent}} % of the agreed total remuneration
- cancellation 30 to 60 days before the event: 50 % of the agreed total remuneration
- cancellation less than 30 days before the event: 75 % of the agreed total remuneration
- cancellation less than 7 days before the event: 100 % of the agreed total remuneration

Down-payments already made are credited against the cancellation fee. The client reserves the right to prove that a lower loss occurred.

Force majeure (illness with medical certificate, government orders, natural disasters) entitles both parties to reschedule the appointment free of charge.`,
  },

  // ---- NDA ----
  {
    slug: 'nda_mutual',
    section: 'nda',
    name: 'Vertraulichkeit (beidseitig)',
    description: 'EXAMPLE — have your lawyer review before sending. Gegenseitige Geheimhaltungsverpflichtung. Geeignet, wenn der Auftrag vertrauliche Inhalte umfasst (Hochzeit prominenter Personen, Corporate-Event, NDA-pflichtige Inhalte).',
    display_order: 10,
    body_text_de: `**Vertraulichkeit**

Beide Parteien verpflichten sich, sämtliche im Zusammenhang mit diesem Vertrag erlangten vertraulichen Informationen der jeweils anderen Partei – darunter Geschäftsgeheimnisse, persönliche Daten, Inhalte des Auftrags sowie die Identität der abgebildeten Personen – streng vertraulich zu behandeln und nicht an Dritte weiterzugeben.

Die Vertraulichkeitsverpflichtung gilt während der Vertragslaufzeit und für die Dauer von drei (3) Jahren nach deren Beendigung. Sie gilt nicht für Informationen, die nachweislich öffentlich bekannt sind, ohne Vertraulichkeitspflicht von Dritten erlangt wurden oder aufgrund gesetzlicher Verpflichtung offengelegt werden müssen.

Verstösse gegen die Vertraulichkeitspflicht können Schadensersatzansprüche der jeweils anderen Partei nach sich ziehen.`,
    body_text: `**Confidentiality**

Both parties undertake to treat all confidential information of the other party obtained in connection with this contract — including trade secrets, personal data, the subject matter of the order, and the identity of the persons depicted — as strictly confidential and not to disclose it to third parties.

The confidentiality obligation applies during the term of the contract and for three (3) years after its termination. It does not apply to information that is demonstrably publicly known, obtained from third parties without a confidentiality obligation, or required to be disclosed by law.

Breaches of the confidentiality obligation may give rise to claims for damages by the respective other party.`,
  },

  // ---- CLOSING ----
  {
    slug: 'closing_jurisdiction_ch',
    section: 'closing',
    name: 'Schlussbestimmungen (Schweizer Recht)',
    description: 'EXAMPLE — have your lawyer review before sending. Gerichtsstand und anwendbares Recht für Schweizer Auftragnehmer.',
    display_order: 10,
    body_text_de: `**Schlussbestimmungen**

Auf diesen Vertrag findet ausschliesslich schweizerisches Recht unter Ausschluss des UN-Kaufrechts Anwendung.

Ausschliesslicher Gerichtsstand für sämtliche Streitigkeiten aus oder im Zusammenhang mit diesem Vertrag ist – soweit gesetzlich zulässig – der Sitz des Auftragnehmers.

Sollten einzelne Bestimmungen dieses Vertrags ganz oder teilweise unwirksam sein oder werden, bleibt die Wirksamkeit der übrigen Bestimmungen davon unberührt. An die Stelle der unwirksamen Bestimmung tritt eine wirksame Regelung, die dem wirtschaftlichen Zweck der unwirksamen am nächsten kommt.

Änderungen und Ergänzungen dieses Vertrags bedürfen der Schriftform. Dies gilt auch für die Aufhebung dieses Schriftformerfordernisses.`,
    body_text: `**Closing provisions**

This contract is governed exclusively by Swiss law, to the exclusion of the UN Convention on Contracts for the International Sale of Goods.

The exclusive place of jurisdiction for all disputes arising out of or in connection with this contract is — to the extent permitted by law — the registered office of the contractor.

Should individual provisions of this contract be or become wholly or partly invalid, the validity of the remaining provisions shall not be affected. The invalid provision shall be replaced by a valid one which comes closest to its economic purpose.

Amendments and supplements to this contract must be made in writing. This also applies to any waiver of this written-form requirement.`,
  },
  {
    slug: 'closing_jurisdiction_de',
    section: 'closing',
    name: 'Schlussbestimmungen (Deutsches Recht)',
    description: 'EXAMPLE — have your lawyer review before sending. Gerichtsstand und anwendbares Recht für deutsche Auftragnehmer.',
    display_order: 20,
    body_text_de: `**Schlussbestimmungen**

Auf diesen Vertrag findet ausschliesslich das Recht der Bundesrepublik Deutschland unter Ausschluss des UN-Kaufrechts Anwendung.

Ausschliesslicher Gerichtsstand für sämtliche Streitigkeiten aus oder im Zusammenhang mit diesem Vertrag ist – soweit gesetzlich zulässig – der Geschäftssitz des Auftragnehmers.

Sollten einzelne Bestimmungen dieses Vertrags ganz oder teilweise unwirksam sein oder werden, bleibt die Wirksamkeit der übrigen Bestimmungen davon unberührt. An die Stelle der unwirksamen Bestimmung tritt eine wirksame Regelung, die dem wirtschaftlichen Zweck der unwirksamen am nächsten kommt.

Änderungen und Ergänzungen dieses Vertrags bedürfen der Schriftform. Dies gilt auch für die Aufhebung dieses Schriftformerfordernisses.`,
    body_text: `**Closing provisions**

This contract is governed exclusively by the law of the Federal Republic of Germany, to the exclusion of the UN Convention on Contracts for the International Sale of Goods.

The exclusive place of jurisdiction for all disputes arising out of or in connection with this contract is — to the extent permitted by law — the place of business of the contractor.

Should individual provisions of this contract be or become wholly or partly invalid, the validity of the remaining provisions shall not be affected. The invalid provision shall be replaced by a valid one which comes closest to its economic purpose.

Amendments and supplements to this contract must be made in writing. This also applies to any waiver of this written-form requirement.`,
  },
  // ---- Added by migration 131 — scope section, after image-rights blocks.
  // Auto-inserts a table of the source quote's line items below the body.
  {
    slug: 'quote_line_items_table',
    section: 'scope',
    name: 'Quote line items',
    description: 'Auto-inserts the source quote\'s line items as a table. Body text appears above the table.',
    display_order: 99,
    body_text_de: 'Leistungspositionen gemäß Angebot {{source_quote_number}}:',
    body_text: 'Service items per quote {{source_quote_number}}:',
  },
];

// ---- Permissions seeded in Section 13 -------------------------------------
// Mig 102 (4 quotes + bills perms) + mig 130 (2 contracts perms). Granted
// to super_admin + admin on insert. Editor/viewer roles locked out by
// default (matches customers.* pattern from mig 090).
const NEW_PERMISSIONS = [
  { name: 'quotes.view',      display_name: 'View Quotes',      category: 'quotes',    description: 'View quotes and their line items' },
  { name: 'quotes.manage',    display_name: 'Manage Quotes',    category: 'quotes',    description: 'Create, edit, send, duplicate, and convert quotes' },
  { name: 'bills.view',       display_name: 'View Invoices',    category: 'billing',   description: 'View invoices and their payment status' },
  { name: 'bills.manage',     display_name: 'Manage Invoices',  category: 'billing',   description: 'Create, edit, send invoices, mark them paid, and send reminders' },
  { name: 'contracts.view',   display_name: 'View Contracts',   category: 'contracts', description: 'View contracts and their signing status' },
  { name: 'contracts.manage', display_name: 'Manage Contracts', category: 'contracts', description: 'Create, edit, send and counter-sign contracts and manage the block library' },
];

// Split-permission projection from mig 134 — every role that holds
// `customers.create` gains the two new narrower perms so no role loses
// capability on upgrade. The split itself lets admin opt into a finer
// grant later via the Role editor.
const CUSTOMERS_SPLIT_PERMISSIONS = [
  { name: 'customers.edit',   display_name: 'Edit Customers',           category: 'customers', description: 'Edit customer records, manage hour-logging entries, trigger password resets, and fire admin-override monthly bills.' },
  { name: 'customers.events', display_name: 'Assign Customers to Events', category: 'customers', description: 'Add or remove the events a customer is linked to. Does not grant the ability to edit the customer record.' },
];

// ---- Feature flags seeded in Section 14 -----------------------------------
// All default OFF on a fresh install — admin opts in via Settings →
// Features. The clients-section parent is DERIVED from these in the
// frontend FeatureFlagsContext (any one of them being on flips the
// parent on); the backend treats them as independent.
const NEW_FEATURE_FLAGS = [
  'quotes', 'bills', 'contracts', 'taxReport', 'hoursLogging',
  'calendar', 'calendarBooking', 'reminderEmails', 'crmDevelopment',
  'messaging',
];

// ---- app_settings seeded in Section 14 ------------------------------------
// CRM behaviour toggles — mig 102. Defaults ON so the feature works
// out of the box once an admin enables the master flag; admin can
// then opt out of Skonto / reminders / late fees / QR-bill in
// Settings → CRM-Settings → CRM behaviour.
const CRM_SUB_SETTINGS = [
  // Quote behaviour
  { setting_key: 'crm_quotes_pdf_attachment_enabled',     setting_value: true,  setting_type: 'crm' },
  { setting_key: 'crm_quotes_skonto_enabled',             setting_value: true,  setting_type: 'crm' },
  { setting_key: 'crm_quotes_accept_window_minutes',      setting_value: 15,    setting_type: 'crm' },
  { setting_key: 'crm_quotes_default_valid_days',         setting_value: 30,    setting_type: 'crm' },
  // Invoice behaviour
  { setting_key: 'crm_invoices_qr_enabled',               setting_value: true,  setting_type: 'crm' },
  { setting_key: 'crm_invoices_reminders_enabled',        setting_value: true,  setting_type: 'crm' },
  { setting_key: 'crm_invoices_reminder_first_days',      setting_value: 14,    setting_type: 'crm' },
  { setting_key: 'crm_invoices_reminder_second_days',     setting_value: 30,    setting_type: 'crm' },
  { setting_key: 'crm_invoices_late_fee_enabled',         setting_value: true,  setting_type: 'crm' },
  { setting_key: 'crm_invoices_late_fee_minor',           setting_value: 2500,  setting_type: 'crm' },
  { setting_key: 'crm_invoices_late_fee_label',           setting_value: 'Mahngebühr', setting_type: 'crm' },
  { setting_key: 'crm_invoices_skonto_business_days',     setting_value: 5,     setting_type: 'crm' },
  { setting_key: 'crm_invoices_skonto_percent_default',   setting_value: 2,     setting_type: 'crm' },
  // Numbering
  { setting_key: 'crm_quotes_number_format',              setting_value: 'Q-{YEAR}-{SEQ:04d}', setting_type: 'crm' },
  { setting_key: 'crm_invoices_number_format',            setting_value: 'R-{YEAR}-{SEQ:04d}', setting_type: 'crm' },
  // Mig 104 — Terms-of-Service step on quote acceptance.
  { setting_key: 'crm_quotes_tos_required',               setting_value: false, setting_type: 'crm' },
  { setting_key: 'crm_quotes_tos_text',                   setting_value: '',    setting_type: 'crm' },
  { setting_key: 'crm_quotes_tos_url',                    setting_value: '',    setting_type: 'crm' },
  // Mig 130 — contracts behaviour. store_ip default ON (GDPR opt-out
  // for operators with strict data-minimisation requirements).
  { setting_key: 'crm_contracts_number_format',           setting_value: 'C-{YEAR}-{SEQ:04d}', setting_type: 'crm' },
  { setting_key: 'crm_contracts_default_valid_days',      setting_value: 30,    setting_type: 'crm' },
  { setting_key: 'crm_contracts_pdf_attachment_enabled',  setting_value: true,  setting_type: 'crm' },
  { setting_key: 'crm_contracts_require_drawn_signature', setting_value: false, setting_type: 'crm' },
  { setting_key: 'crm_contracts_allow_pdf_upload',        setting_value: true,  setting_type: 'crm' },
  { setting_key: 'crm_contracts_store_ip',                setting_value: true,  setting_type: 'crm' },
  // Mig 141 — installment-row defaults (pre-fill for new ad-hoc rows
  // in the Quote/Invoice editors).
  { setting_key: 'crm_invoices_installment_trigger_first',     setting_value: 'quote_accepted', setting_type: 'crm' },
  { setting_key: 'crm_invoices_installment_days_before_event', setting_value: 14, setting_type: 'crm' },
  { setting_key: 'crm_invoices_installment_days_after_event',  setting_value: 14, setting_type: 'crm' },
  // Mig 143 — pre-event customer reminder global toggles.
  { setting_key: 'crm_event_reminders_enabled',           setting_value: false, setting_type: 'crm' },
  { setting_key: 'crm_event_reminders_days_before',       setting_value: 2,     setting_type: 'crm' },
];

// Customer-surface feature defaults — mig 109. These globally enable
// the Quotes / Bills tabs on the customer portal so admin doesn't have
// to flip the toggle per customer. Stored as `customer_surface` type.
const CUSTOMER_FEATURE_SETTINGS = [
  { setting_key: 'customer_feature_quotes_enabled', setting_value: true, setting_type: 'customer_surface' },
  { setting_key: 'customer_feature_bills_enabled',  setting_value: true, setting_type: 'customer_surface' },
];

// ===========================================================================
// up()
// ===========================================================================

exports.up = async function (knex) {
  // -------------------------------------------------------------------------
  // SECTION 1 — Issuer block (business_profile + business_bank_accounts)
  // -------------------------------------------------------------------------
  // Source migrations: 102 (base + bank accounts), 103 (pdf_font_ttf_path),
  // 106 (pdf_show_logo / _company_name), 107 (country_name), 108 (folding
  // marks / logo height / company-name inline), 121 (pdf_font_family),
  // 139 (tax_id for Steuernummer / §14 UStG).
  if (!(await knex.schema.hasTable('business_profile'))) {
    await knex.schema.createTable('business_profile', (table) => {
      table.increments('id').primary();
      // Issuer block printed top-right on every PDF. All nullable so the
      // singleton row can be seeded empty and filled in via Settings.
      table.string('company_name', 255);
      table.string('address_line1', 255);
      table.string('address_line2', 255);
      table.string('postal_code', 20);
      table.string('city', 120);
      table.string('state', 120);
      table.string('country_code', 2); // ISO 3166-1 alpha-2
      table.string('country_name', 120); // free-text override (mig 107)
      table.string('phone', 64);
      table.string('mobile', 64);
      table.string('email', 255);
      table.string('website', 255);
      // §14 UStG requires EITHER a VAT-ID (USt-IdNr.) OR a Steuernummer
      // on every invoice; Kleinunternehmer (§19) typically only have the
      // latter. Both columns nullable; admin populates whichever applies.
      table.string('vat_id', 64);
      table.string('tax_id', 64); // Steuernummer — mig 139
      table.string('vat_label', 64).defaultTo('MwSt.');
      // Stored as DECIMAL string to match app_settings percent values
      // elsewhere; rendered as-is on PDFs.
      table.decimal('vat_rate_default', 5, 2).defaultTo(0);
      table.string('default_currency', 3).defaultTo('CHF');
      table.string('default_locale', 8).defaultTo('de');
      // 'swiss' | 'epc' | 'none' — drives QR rendering on invoice PDFs.
      table.string('default_qr_format', 16).defaultTo('none');
      table.string('footer_line', 255);
      // Relative path under storage/ — uploads via adminBranding.js.
      table.string('logo_path', 512);
      // PDF-font choice (priority order):
      //   1. pdf_font_ttf_path — absolute / storage-relative TTF/OTF path
      //      (mig 103). Used when admin uploads a custom font.
      //   2. pdf_font_family   — bundled-fonts directory name like
      //      "Inter" / "Playfair-Display" (mig 121). Resolves to
      //      backend/assets/fonts/<family>/400.ttf + 700.ttf.
      //   3. Fallback: PDFKit's built-in Helvetica.
      table.string('pdf_font_ttf_path', 512);
      table.string('pdf_font_family', 128).nullable();
      // PDF layout knobs (mig 106 + 108 + 110). Defaults preserve
      // historical visual state per the "preserve existing visuals"
      // rule — except pdf_quote_show_net_days / pdf_quote_show_skonto
      // (mig 110) which default false: the historical default was to
      // NOT show those blocks until the admin explicitly opts in.
      table.boolean('pdf_show_logo').notNullable().defaultTo(true);
      table.boolean('pdf_show_company_name').notNullable().defaultTo(true);
      table.string('pdf_folding_marks', 16).notNullable().defaultTo('none');
      table.integer('pdf_logo_height').notNullable().defaultTo(56);
      table.boolean('pdf_company_name_inline').notNullable().defaultTo(false);
      table.boolean('pdf_quote_show_net_days').notNullable().defaultTo(false);
      table.boolean('pdf_quote_show_skonto').notNullable().defaultTo(false);
      // IANA timezone for date/time rendering on PDFs + admin calendar
      // (mig 137). Nullable; frontend falls back to browser Intl TZ
      // when blank. Admin-only setting.
      table.string('timezone', 64);
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());
    });

    // Seed the singleton row so getProfile() always returns something.
    await knex('business_profile').insert({ id: 1 });
  }

  if (!(await knex.schema.hasTable('business_bank_accounts'))) {
    await knex.schema.createTable('business_bank_accounts', (table) => {
      table.increments('id').primary();
      table.integer('business_profile_id').unsigned().notNullable().defaultTo(1)
        .references('id').inTable('business_profile').onDelete('CASCADE');
      table.string('label', 128); // e.g. "Hauptkonto" / "EUR-Konto"
      table.string('account_holder', 255);
      table.string('iban', 64).notNullable();
      table.string('bic', 16);
      table.string('currency', 3);
      table.boolean('is_default').notNullable().defaultTo(false);
      table.integer('display_order').notNullable().defaultTo(0);
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());

      table.index(['business_profile_id']);
      table.index(['currency']);
    });
  }

  // -------------------------------------------------------------------------
  // SECTION 2 — Payment-term templates (legacy + split)
  // -------------------------------------------------------------------------
  // The legacy `payment_term_templates` (mig 102) mashed "Net days" and
  // "installment plan" together. Migration 124 split them into two
  // orthogonal pickers — `payment_net_days_templates` (Net 14/30/60/90)
  // and `payment_timing_templates` (Komplettzahlung / 3 Raten). Both
  // tables coexist: the legacy table stays referenced by historical
  // quote/invoice rows; the editor reads/writes the new split FKs.
  //
  // Seeds embedded in the createTable blocks (fresh creation only ⇒
  // no idempotency check on the inserts needed).
  if (!(await knex.schema.hasTable('payment_term_templates'))) {
    await knex.schema.createTable('payment_term_templates', (table) => {
      table.increments('id').primary();
      table.string('name', 128).notNullable();
      table.string('description', 255);
      // Net payment window in days (30/60/90 etc.) used when no
      // explicit due_date is set.
      table.integer('net_days').notNullable().defaultTo(30);
      // Skonto (early-payment discount) — both nullable when not offered.
      table.decimal('skonto_percent', 5, 2);
      table.integer('skonto_within_days');
      // JSON installments array. SQLite stores TEXT; Postgres JSONB.
      // knex .json() picks the right native type per dialect.
      table.json('installments').notNullable();
      table.boolean('is_system').notNullable().defaultTo(false);
      table.boolean('is_active').notNullable().defaultTo(true);
      table.integer('display_order').notNullable().defaultTo(0);
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());

      table.index(['is_active']);
      table.index(['is_system']);
    });

    for (const tpl of SYSTEM_PAYMENT_TERM_TEMPLATES) {
      await knex('payment_term_templates').insert({
        name: tpl.name,
        description: tpl.description,
        net_days: tpl.net_days,
        skonto_percent: tpl.skonto_percent,
        skonto_within_days: tpl.skonto_within_days,
        installments: JSON.stringify(tpl.installments),
        is_system: true,
        is_active: true,
        display_order: tpl.display_order,
      });
    }
  }

  if (!(await knex.schema.hasTable('payment_net_days_templates'))) {
    await knex.schema.createTable('payment_net_days_templates', (table) => {
      table.increments('id').primary();
      table.string('name', 128).notNullable();
      table.string('description', 255);
      table.integer('net_days').notNullable().defaultTo(30);
      // Skonto lives on the net-days side because it modifies the
      // payment window, not the installment timing.
      table.decimal('skonto_percent', 5, 2);
      table.integer('skonto_within_days');
      table.boolean('is_system').notNullable().defaultTo(false);
      table.boolean('is_active').notNullable().defaultTo(true);
      table.integer('display_order').notNullable().defaultTo(0);
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());

      table.index(['is_active']);
      table.index(['is_system']);
    });

    for (const tpl of SYSTEM_NET_DAYS) {
      await knex('payment_net_days_templates').insert({
        name: tpl.name,
        net_days: tpl.net_days,
        is_system: true,
        is_active: true,
        display_order: tpl.display_order,
      });
    }
  }

  if (!(await knex.schema.hasTable('payment_timing_templates'))) {
    await knex.schema.createTable('payment_timing_templates', (table) => {
      table.increments('id').primary();
      table.string('name', 128).notNullable();
      table.string('description', 255);
      // Installments JSON — same shape the renderer + scheduler consume
      // from payment_term_snapshot: [{label, percent, trigger, offset_days}, ...]
      table.json('installments').notNullable();
      table.boolean('is_system').notNullable().defaultTo(false);
      table.boolean('is_active').notNullable().defaultTo(true);
      table.integer('display_order').notNullable().defaultTo(0);
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());

      table.index(['is_active']);
      table.index(['is_system']);
    });

    for (const tpl of SYSTEM_TIMING) {
      await knex('payment_timing_templates').insert({
        name: tpl.name,
        description: tpl.description,
        installments: JSON.stringify(tpl.installments),
        is_system: true,
        is_active: true,
        display_order: tpl.display_order,
      });
    }
  }

  // -------------------------------------------------------------------------
  // SECTION 3 — Quotes (table + line items + presets + action tokens)
  // -------------------------------------------------------------------------
  // Source migrations: 102 (base), 104 (ToS), 119 (line-item hierarchy +
  // details_text), 124 (split payment-term FKs), 140 (deal_uuid),
  // 142 (per-quote installments_override). Note mig 110 adds
  // pdf_quote_show_* to business_profile, NOT quotes — handled in §1.

  if (!(await knex.schema.hasTable('quote_line_item_presets'))) {
    await knex.schema.createTable('quote_line_item_presets', (table) => {
      table.increments('id').primary();
      table.string('name', 128).notNullable();
      table.text('description');
      // Minor units (cents/Rappen) to avoid float drift. bigInteger
      // keeps room for big-ticket items; SQLite silently promotes to
      // INTEGER which fits 2^53-1.
      table.bigInteger('unit_price_minor').notNullable().defaultTo(0);
      table.string('currency', 3).notNullable().defaultTo('CHF');
      table.decimal('quantity_default', 10, 2).notNullable().defaultTo(1);
      table.integer('display_order').notNullable().defaultTo(0);
      table.boolean('is_active').notNullable().defaultTo(true);
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());

      table.index(['is_active']);
    });
  }

  if (!(await knex.schema.hasTable('quotes'))) {
    await knex.schema.createTable('quotes', (table) => {
      table.increments('id').primary();
      table.string('quote_number', 32).unique().notNullable();
      table.integer('customer_account_id').unsigned().notNullable()
        .references('id').inTable('customer_accounts').onDelete('RESTRICT');

      // draft | sent | accepted | declined | expired | converted
      table.string('status', 16).notNullable().defaultTo('draft');
      table.string('language', 8).defaultTo('de');
      table.string('currency', 3).notNullable().defaultTo('CHF');

      table.date('issue_date').notNullable();
      table.date('valid_until');

      // Event-data snapshot — not a FK because the event might not
      // exist yet (it's created on quote acceptance).
      table.string('event_name', 255);
      table.date('event_date');
      table.string('event_time_start', 8);   // "HH:MM"
      table.string('event_time_end', 8);
      table.decimal('expected_duration_hours', 4, 2);

      // Payment terms — legacy FK + snapshot from mig 102, plus the
      // split FKs from mig 124 (the forward path). New quote/invoice
      // writes populate the split FKs; historical rows referenced via
      // legacy stay editable through the snapshot.
      table.integer('payment_term_template_id').unsigned()
        .references('id').inTable('payment_term_templates').onDelete('RESTRICT');
      table.integer('payment_net_days_template_id').unsigned()
        .references('id').inTable('payment_net_days_templates').onDelete('SET NULL');
      table.integer('payment_timing_template_id').unsigned()
        .references('id').inTable('payment_timing_templates').onDelete('SET NULL');
      table.json('payment_term_snapshot'); // copied at send time
      // Per-quote ad-hoc installments override (mig 142). When NULL,
      // the chosen timing template's installments are used as-is.
      table.json('payment_term_installments_override');

      // Totals (server-computed, never trust client).
      table.bigInteger('net_amount_minor').notNullable().defaultTo(0);
      table.decimal('vat_rate', 5, 2).defaultTo(0);
      table.bigInteger('vat_amount_minor').notNullable().defaultTo(0);
      table.bigInteger('shipping_amount_minor').notNullable().defaultTo(0);
      table.bigInteger('total_amount_minor').notNullable().defaultTo(0);

      table.text('intro_text');
      table.text('outro_text');
      table.text('internal_notes');
      table.string('cc_pdf_email', 255);

      // Lifecycle timestamps.
      table.timestamp('sent_at');
      table.timestamp('responded_at');       // first accept/decline action
      table.timestamp('response_locked_at'); // responded_at + 15min
      table.timestamp('accepted_at');
      table.timestamp('declined_at');

      // Terms-of-Service step on quote acceptance (mig 104).
      // tos_accepted_at = when the customer ticked the box; snapshot
      // of the text they accepted lives in tos_text_snapshot for audit.
      table.timestamp('tos_accepted_at');
      table.text('tos_text_snapshot');

      // Cross-document lineage (mig 140). Every quote/contract/invoice
      // tied to one customer engagement shares this uuid — the lineage
      // card reads everything via WHERE deal_uuid=? in one query.
      table.uuid('deal_uuid').nullable();

      // Set when the quote converts to an event. Nullable, ON DELETE
      // SET NULL so deleting the event preserves the audit trail.
      table.integer('converted_event_id').unsigned()
        .references('id').inTable('events').onDelete('SET NULL');
      // Back-pointer to the contract this quote spawned (mig 131).
      // Quote detail page deep-links to the contract; service refuses
      // double conversion to event/invoice when this is set.
      // FK added below after contracts table exists (forward ref).
      table.integer('converted_contract_id').unsigned();

      table.string('pdf_path', 512);
      table.integer('business_bank_account_id').unsigned()
        .references('id').inTable('business_bank_accounts').onDelete('SET NULL');
      table.integer('created_by_admin_id').unsigned()
        .references('id').inTable('admin_users').onDelete('SET NULL');
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());

      table.index(['customer_account_id']);
      table.index(['status']);
      table.index(['issue_date']);
      table.index(['converted_contract_id']);
      table.index('deal_uuid', 'quotes_deal_uuid_idx');
    });
  }

  if (!(await knex.schema.hasTable('quote_line_items'))) {
    await knex.schema.createTable('quote_line_items', (table) => {
      table.increments('id').primary();
      table.integer('quote_id').unsigned().notNullable()
        .references('id').inTable('quotes').onDelete('CASCADE');
      table.integer('position').notNullable().defaultTo(0); // 1-based display
      table.decimal('quantity', 10, 2).notNullable().defaultTo(1);
      table.text('description').notNullable();
      table.bigInteger('unit_price_minor').notNullable().defaultTo(0);
      table.decimal('discount_percent', 5, 2).notNullable().defaultTo(0);
      // Server-computed: round((qty * unit) * (1 - discount/100))
      table.bigInteger('line_total_minor').notNullable().defaultTo(0);
      // Hierarchy (mig 119). parent_line_item_id NULL = top-level
      // (rolls into net); SET = sub-item (display-only itemisation).
      // ON DELETE CASCADE matches "remove the line, remove its
      // sub-items" mental model. One level deep only — service
      // validators reject grandchildren.
      table.integer('parent_line_item_id').unsigned()
        .references('id').inTable('quote_line_items').onDelete('CASCADE');
      // Free-form notes under the description on PDFs + customer view
      // (smaller, italic, indented). Good for fine print.
      table.text('details_text');
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());

      table.index(['quote_id']);
      table.index('parent_line_item_id', 'quote_line_items_parent_idx');
    });
  }

  if (!(await knex.schema.hasTable('quote_action_tokens'))) {
    await knex.schema.createTable('quote_action_tokens', (table) => {
      table.increments('id').primary();
      table.integer('quote_id').unsigned().notNullable()
        .references('id').inTable('quotes').onDelete('CASCADE');
      // 64 hex chars = 32 bytes = 256 bits — same entropy as share tokens.
      table.string('token', 64).unique().notNullable();
      table.timestamp('expires_at').notNullable();
      table.timestamp('used_at');
      table.string('used_action', 16); // 'accepted' | 'declined' | null
      table.string('used_ip', 45);
      table.timestamp('created_at').defaultTo(knex.fn.now());

      table.index(['quote_id']);
      table.index(['expires_at']);
    });
  }

  // -------------------------------------------------------------------------
  // SECTION 4 — Invoices (table + line items + payment log + payment-check tokens)
  // -------------------------------------------------------------------------
  // Source migrations on `invoices`: 102 (base), 111 (imported_pdf),
  // 113 (payment-term FK + snapshot), 114 (kind/Storno discriminator +
  // cancels/replaces/cancellation_storno + invoices_kind_status_idx),
  // 115 (last_payment_check_at + token table), 123 (event snapshot),
  // 124 (split payment-term FKs), 126 (skonto_disabled), 128 (monthly
  // draft cols + invoices_monthly_draft_idx), 133 (partial-unique
  // single-draft-per-customer index), 140 (deal_uuid).
  // `invoice_line_items` gets parent_line_item_id + details_text (119).
  // `invoice_payment_log` gets skonto_applied + skonto_amount_minor (126).

  if (!(await knex.schema.hasTable('invoices'))) {
    await knex.schema.createTable('invoices', (table) => {
      table.increments('id').primary();
      table.string('invoice_number', 32).unique().notNullable();
      table.integer('customer_account_id').unsigned().notNullable()
        .references('id').inTable('customer_accounts').onDelete('RESTRICT');

      // 'invoice' | 'storno' discriminator (mig 114). The renderer
      // branches on this; list-view filters always pair it with status.
      table.string('kind', 16).notNullable().defaultTo('invoice');

      // Lineage FKs.
      table.integer('source_quote_id').unsigned()
        .references('id').inTable('quotes').onDelete('SET NULL');
      // Back-pointer to the source contract (mig 131) when the invoice
      // was created from a signed contract rather than a quote.
      // FK added below after contracts table exists (forward ref).
      table.integer('source_contract_id').unsigned();
      table.integer('event_id').unsigned()
        .references('id').inTable('events').onDelete('SET NULL');
      // Storno + reissue self-refs (mig 114). ON DELETE SET NULL so
      // purging an original leaves the Storno's link dangling NULL
      // instead of cascading.
      table.integer('cancels_invoice_id').unsigned()
        .references('id').inTable('invoices').onDelete('SET NULL');
      table.integer('replaces_invoice_id').unsigned()
        .references('id').inTable('invoices').onDelete('SET NULL');
      table.integer('cancellation_storno_id').unsigned()
        .references('id').inTable('invoices').onDelete('SET NULL');

      table.string('language', 8).defaultTo('de');
      table.string('currency', 3).notNullable().defaultTo('CHF');

      table.date('issue_date').notNullable();
      table.date('due_date').notNullable();

      // Event snapshot (mig 123). Inline so the renderer doesn't have
      // to JOIN events on every fetch; the event reference itself can
      // be deleted without orphaning the invoice's audit display.
      table.string('event_name', 255);
      table.date('event_date');
      table.string('event_time_start', 8);   // "HH:MM"
      table.string('event_time_end', 8);

      // Split-payment series metadata. Solo invoices = index 0, total 1.
      table.integer('installment_index').notNullable().defaultTo(0);
      table.integer('installment_total').notNullable().defaultTo(1);
      table.string('installment_label', 128);
      // quote_accepted | before_event | after_event | after_delivery | fixed_date
      table.string('installment_trigger', 32);

      // scheduled | sent | paid | overdue | cancelled | pending_delivery
      table.string('status', 16).notNullable().defaultTo('scheduled');
      table.timestamp('scheduled_send_at'); // NULL = send now on create
      table.timestamp('sent_at');

      // Totals (server-computed, never trust client).
      table.bigInteger('net_amount_minor').notNullable().defaultTo(0);
      table.decimal('vat_rate', 5, 2).defaultTo(0);
      table.bigInteger('vat_amount_minor').notNullable().defaultTo(0);
      table.bigInteger('shipping_amount_minor').notNullable().defaultTo(0);
      table.bigInteger('total_amount_minor').notNullable().defaultTo(0);
      table.bigInteger('paid_amount_minor').notNullable().defaultTo(0);
      table.timestamp('paid_at');
      table.string('payment_method', 64);
      table.string('payment_reference', 128);

      // Payment terms — legacy FK (mig 113) + split FKs (mig 124).
      // Snapshot is the legal record; the FKs are convenience.
      table.integer('payment_term_template_id').unsigned()
        .references('id').inTable('payment_term_templates').onDelete('SET NULL');
      table.integer('payment_net_days_template_id').unsigned()
        .references('id').inTable('payment_net_days_templates').onDelete('SET NULL');
      table.integer('payment_timing_template_id').unsigned()
        .references('id').inTable('payment_timing_templates').onDelete('SET NULL');
      table.json('payment_term_snapshot');
      // Skonto opt-out (mig 126). When true, admin actively suppressed
      // the Skonto offer for this invoice — overrides the template.
      table.boolean('skonto_disabled').notNullable().defaultTo(false);

      // 0 = none, 1 = first reminder, 2 = second (with fee).
      table.integer('reminder_level').notNullable().defaultTo(0);
      table.timestamp('last_reminder_sent_at');
      table.bigInteger('late_fee_amount_minor').notNullable().defaultTo(0);

      // Throttle for the payment-check email (mig 115) — don't queue
      // another within 24h of the previous one for the same invoice.
      table.timestamp('last_payment_check_at');

      // Monthly billing accumulator (mig 128). is_monthly_draft=true
      // rows are the running per-customer draft that accumulates
      // line items across the period; the scheduler arms it on the
      // cycle day and flips it to status='scheduled' for normal send.
      table.boolean('is_monthly_draft').notNullable().defaultTo(false);
      table.date('monthly_period_start');
      table.date('monthly_period_end');

      // Imported PDF path (mig 111) — admin uploaded a finished invoice
      // PDF (rare; usually we render); store the source for re-download.
      table.string('imported_pdf_path', 512);

      // Cross-document lineage (mig 140).
      table.uuid('deal_uuid').nullable();

      table.string('cc_pdf_email', 255);
      table.string('pdf_path', 512);
      table.integer('business_bank_account_id').unsigned()
        .references('id').inTable('business_bank_accounts').onDelete('SET NULL');
      // 'swiss' | 'epc' | 'none' — overrides business_profile.default_qr_format
      // when set per-invoice.
      table.string('qr_format', 16);

      table.integer('created_by_admin_id').unsigned()
        .references('id').inTable('admin_users').onDelete('SET NULL');
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());

      table.index(['customer_account_id']);
      table.index(['status']);
      table.index(['due_date']);
      table.index(['scheduled_send_at']);
      table.index(['source_contract_id']);
      table.index('deal_uuid', 'invoices_deal_uuid_idx');
    });

    // Composite index for list-view "kind=invoice AND status IN (…)"
    // — used in nearly every query. Raw CREATE INDEX since knex
    // doesn't expose IF-NOT-EXISTS for indexes portably.
    await knex.raw('CREATE INDEX IF NOT EXISTS invoices_kind_status_idx ON invoices (kind, status)');

    // Partial index for the scheduler's monthly-pass lookup (mig 128).
    // Postgres + SQLite 3.8+ support `CREATE INDEX … WHERE`. Falls
    // back to a regular index on ancient SQLite.
    try {
      await knex.raw(
        'CREATE INDEX IF NOT EXISTS invoices_monthly_draft_idx '
        + 'ON invoices (customer_account_id, monthly_period_end) '
        + 'WHERE is_monthly_draft = true',
      );
    } catch (_) {
      await knex.raw(
        'CREATE INDEX IF NOT EXISTS invoices_monthly_draft_idx '
        + 'ON invoices (customer_account_id, monthly_period_end)',
      );
    }

    // Partial UNIQUE index — one open monthly draft per customer (mig 133).
    // Cross-dialect: Postgres uses TRUE, SQLite uses 1.
    {
      const client = knex.client.config.client;
      const name = 'invoices_one_monthly_draft_per_customer';
      if (client === 'pg' || client === 'postgresql') {
        await knex.raw(
          `CREATE UNIQUE INDEX IF NOT EXISTS ${name} `
          + `ON invoices (customer_account_id) WHERE is_monthly_draft = TRUE`,
        );
      } else if (client === 'sqlite3' || client === 'sqlite') {
        await knex.raw(
          `CREATE UNIQUE INDEX IF NOT EXISTS ${name} `
          + `ON invoices (customer_account_id) WHERE is_monthly_draft = 1`,
        );
      }
    }
  }

  if (!(await knex.schema.hasTable('invoice_line_items'))) {
    await knex.schema.createTable('invoice_line_items', (table) => {
      table.increments('id').primary();
      table.integer('invoice_id').unsigned().notNullable()
        .references('id').inTable('invoices').onDelete('CASCADE');
      table.integer('position').notNullable().defaultTo(0);
      table.decimal('quantity', 10, 2).notNullable().defaultTo(1);
      table.text('description').notNullable();
      table.bigInteger('unit_price_minor').notNullable().defaultTo(0);
      table.decimal('discount_percent', 5, 2).notNullable().defaultTo(0);
      table.bigInteger('line_total_minor').notNullable().defaultTo(0);
      // Hierarchy (mig 119). NULL = top-level; SET = sub-item
      // (display-only itemisation). One level deep — service
      // validators reject grandchildren.
      table.integer('parent_line_item_id').unsigned()
        .references('id').inTable('invoice_line_items').onDelete('CASCADE');
      table.text('details_text');
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());

      table.index(['invoice_id']);
      table.index('parent_line_item_id', 'invoice_line_items_parent_idx');
    });
  }

  if (!(await knex.schema.hasTable('invoice_payment_log'))) {
    await knex.schema.createTable('invoice_payment_log', (table) => {
      table.increments('id').primary();
      table.integer('invoice_id').unsigned().notNullable()
        .references('id').inTable('invoices').onDelete('CASCADE');
      table.bigInteger('amount_minor').notNullable();
      table.timestamp('paid_at').notNullable();
      table.string('payment_method', 64);
      table.string('reference', 128);
      table.text('notes');
      // Skonto bookkeeping (mig 126). skonto_applied flags the row as
      // "this is a discounted payment"; skonto_amount_minor tracks the
      // discount that was given so the tax report can reverse it out.
      table.boolean('skonto_applied').notNullable().defaultTo(false);
      table.bigInteger('skonto_amount_minor');
      table.integer('recorded_by_admin_id').unsigned()
        .references('id').inTable('admin_users').onDelete('SET NULL');
      table.timestamp('created_at').defaultTo(knex.fn.now());

      table.index(['invoice_id']);
    });
  }

  // Payment-check signed tokens (mig 115). One-shot tokens embedded
  // in reminder emails — admin clicks "Paid in full" / "Partial" /
  // "Not paid" → the page exchanges the token for invoice context
  // without requiring a login. Token consumed on use.
  if (!(await knex.schema.hasTable('invoice_payment_check_tokens'))) {
    await knex.schema.createTable('invoice_payment_check_tokens', (table) => {
      table.increments('id').primary();
      table.integer('invoice_id').unsigned().notNullable()
        .references('id').inTable('invoices').onDelete('CASCADE');
      // 64-char hex — same shape as quote_action_tokens so rate-limit
      // / format checks can be re-used.
      table.string('token', 64).notNullable().unique();
      table.timestamp('expires_at').notNullable();
      table.timestamp('used_at');
      table.string('used_action', 16); // 'paid_full' | 'partial' | 'unpaid'
      table.bigInteger('used_amount_minor'); // for partial payments
      table.string('used_ip', 64);
      table.timestamp('created_at').defaultTo(knex.fn.now());

      table.index(['invoice_id']);
      table.index(['used_at']);
    });
  }

  // -------------------------------------------------------------------------
  // SECTION 5 — Contracts (block library + contracts + inclusions + tokens)
  // -------------------------------------------------------------------------
  // Source migrations: 130 (4 tables + 12 system blocks + perms +
  // settings + feature flag + emails), 131 (event snapshot fields,
  // SHA-256 hashes, lineage FKs in/out, 4 extra locales on blocks,
  // 1 extra system block "quote_line_items_table"), 135 (wet-upload
  // flag), 136 (render-failure markers), 140 (deal_uuid).

  if (!(await knex.schema.hasTable('contract_blocks'))) {
    await knex.schema.createTable('contract_blocks', (table) => {
      table.increments('id').primary();
      // Stable slug — system blocks have hand-written slugs; admin
      // blocks generate from name. Unique across both.
      table.string('slug', 64).unique().notNullable();
      // 'basics' | 'scope' | 'privacy' | 'commercial' | 'nda' | 'closing'
      table.string('section', 32).notNullable();
      table.string('name', 128).notNullable();
      table.string('description', 255);
      // EN body (canonical). Other locales nullable — admin blocks
      // may be EN-only; renderer falls back to EN.
      table.text('body_text').notNullable();
      table.text('body_text_de');
      // Four additional user-fluent locales (mig 131).
      table.text('body_text_ru');
      table.text('body_text_pt');
      table.text('body_text_nl');
      table.text('body_text_fr');
      // is_system blocks: admin can edit bodies (lawyer review pass)
      // but can't delete — only deactivate.
      table.boolean('is_system').notNullable().defaultTo(false);
      table.boolean('is_active').notNullable().defaultTo(true);
      table.integer('display_order').notNullable().defaultTo(0);
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());

      table.index(['section', 'display_order']);
      table.index(['is_active']);
      table.index(['is_system']);
    });

    for (const block of SYSTEM_BLOCKS) {
      await knex('contract_blocks').insert({
        slug: block.slug,
        section: block.section,
        name: block.name,
        description: block.description,
        body_text: block.body_text,
        body_text_de: block.body_text_de,
        is_system: true,
        is_active: true,
        display_order: block.display_order,
      });
    }
  }

  if (!(await knex.schema.hasTable('contracts'))) {
    await knex.schema.createTable('contracts', (table) => {
      table.increments('id').primary();
      table.string('contract_number', 32).unique().notNullable();
      table.integer('customer_account_id').unsigned().notNullable()
        .references('id').inTable('customer_accounts').onDelete('RESTRICT');

      table.string('language', 8).defaultTo('de');
      // draft | sent | signed_by_customer | signed_by_admin |
      // fully_signed | cancelled
      table.string('status', 24).notNullable().defaultTo('draft');

      table.date('issue_date').notNullable();
      // Soft deadline (surfaced in email + on public page).
      table.date('valid_until');

      table.string('title', 255);
      table.text('intro_text');
      table.text('outro_text');

      // Event snapshot (mig 131). Inline so the renderer doesn't have
      // to JOIN events on every fetch; reference can disappear without
      // orphaning the contract's audit display.
      table.string('event_name', 255);
      table.date('event_date');
      table.string('event_time_start', 8);
      table.string('event_time_end', 8);

      // System-generated PDF (no signature, or stamped with the
      // customer's drawn signature). Wet-signed PDF takes precedence
      // when set — see signed_pdf_is_wet_upload below (mig 135).
      table.string('pdf_path', 512);
      table.string('signed_pdf_path', 512);
      // SHA-256 of each PDF on disk (mig 131) — used by the
      // integrity-check service to detect tampering.
      table.string('pdf_sha256', 64);
      table.string('signed_pdf_sha256', 64);
      // Wet-upload discriminator (mig 135). TRUE = signed_pdf_path
      // points at customer-uploaded wet-signed PDF that must NEVER
      // be overwritten by automatic re-stamps.
      table.boolean('signed_pdf_is_wet_upload').notNullable().defaultTo(false);
      // Render-failure markers (mig 136). When the post-sign PDF
      // stamp throws, the catch block writes these so the admin
      // detail page can show a "PDF stamp failed — click to retry"
      // banner. Both cleared on a successful re-stamp.
      table.timestamp('signed_pdf_render_failed_at').nullable().defaultTo(null);
      table.text('signed_pdf_render_error');

      table.timestamp('sent_at');
      table.timestamp('signed_by_customer_at');
      table.timestamp('signed_by_admin_at');

      // Customer in-browser signature evidence.
      table.string('signed_customer_name', 255);
      table.string('signed_customer_ip', 45);
      table.string('signed_customer_signature_path', 512);
      // Admin counter-signature evidence.
      table.string('signed_admin_name', 255);
      table.string('signed_admin_ip', 45);
      table.string('signed_admin_signature_path', 512);

      // Lineage (mig 131 + 140).
      table.integer('source_quote_id').unsigned()
        .references('id').inTable('quotes').onDelete('SET NULL');
      table.integer('converted_event_id').unsigned()
        .references('id').inTable('events').onDelete('SET NULL');
      table.uuid('deal_uuid').nullable();

      table.integer('created_by_admin_id').unsigned()
        .references('id').inTable('admin_users').onDelete('SET NULL');
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());

      table.index(['customer_account_id']);
      table.index(['status']);
      table.index(['issue_date']);
      table.index(['source_quote_id']);
      table.index('deal_uuid', 'contracts_deal_uuid_idx');
    });
  }

  // Deferred FKs: quotes.converted_contract_id + invoices.source_contract_id
  // both reference contracts(id), but the contracts table is created after
  // quotes/invoices in this migration (lineage flows quote → contract →
  // invoice, but the back-pointers were added in later originals — see
  // migs 131 + 141). Add the constraints now that contracts exists.
  // Wrapped in try/catch so a re-run on a DB that already has them is a
  // no-op (matches the events.hero_photo_id pattern in db.js).
  for (const [parent, column] of [
    ['quotes', 'converted_contract_id'],
    ['invoices', 'source_contract_id'],
  ]) {
    try {
      await knex.schema.alterTable(parent, (table) => {
        table.foreign(column)
          .references('id').inTable('contracts')
          .onDelete('SET NULL');
      });
    } catch (err) {
      const msg = err?.message || '';
      if (!/already exists|duplicate|exists/i.test(msg)) {
        throw err;
      }
    }
  }

  if (!(await knex.schema.hasTable('contract_block_inclusions'))) {
    await knex.schema.createTable('contract_block_inclusions', (table) => {
      table.increments('id').primary();
      table.integer('contract_id').unsigned().notNullable()
        .references('id').inTable('contracts').onDelete('CASCADE');
      table.integer('block_id').unsigned().notNullable()
        .references('id').inTable('contract_blocks').onDelete('RESTRICT');

      // Denormalised from contract_blocks.section so renaming a
      // block's section later doesn't reshuffle already-issued
      // contracts.
      table.string('section', 32).notNullable();
      // 1-based order within this section on THIS contract.
      table.integer('position').notNullable().defaultTo(0);

      // Frozen body snapshots captured at sendContract() time. Future
      // edits to the source block don't mutate already-sent contracts.
      table.text('body_text_snapshot');
      table.text('body_text_de_snapshot');

      // Soft toggle. included=false leaves the row for history but
      // omits it from the PDF + public view.
      table.boolean('included').notNullable().defaultTo(true);

      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());

      table.index(['contract_id', 'section', 'position']);
      table.index(['block_id']);
    });
  }

  if (!(await knex.schema.hasTable('contract_action_tokens'))) {
    await knex.schema.createTable('contract_action_tokens', (table) => {
      table.increments('id').primary();
      table.integer('contract_id').unsigned().notNullable()
        .references('id').inTable('contracts').onDelete('CASCADE');
      table.string('token', 64).unique().notNullable();
      table.timestamp('expires_at').notNullable();
      table.timestamp('used_at');
      // 'signed_by_customer' | 'uploaded_signed_pdf'
      table.string('used_action', 32);
      table.string('used_ip', 45);
      table.timestamp('created_at').defaultTo(knex.fn.now());

      table.index(['contract_id']);
      table.index(['expires_at']);
    });
  }

  // -------------------------------------------------------------------------
  // SECTION 6 — Event ↔ quote glue (event_payment_plans)
  // -------------------------------------------------------------------------
  // Created on quote acceptance: snapshots the payment plan so future
  // edits to the quote's template don't retroactively mutate what was
  // committed for the event. Source: mig 102.
  if (!(await knex.schema.hasTable('event_payment_plans'))) {
    await knex.schema.createTable('event_payment_plans', (table) => {
      table.increments('id').primary();
      table.integer('event_id').unsigned().notNullable()
        .references('id').inTable('events').onDelete('CASCADE');
      table.integer('quote_id').unsigned()
        .references('id').inTable('quotes').onDelete('SET NULL');
      table.json('payment_term_snapshot').notNullable();
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());

      table.index(['event_id']);
      table.index(['quote_id']);
    });
  }

  // -------------------------------------------------------------------------
  // SECTION 7 — Customer hour logging
  // -------------------------------------------------------------------------
  // Source: mig 129. customer_accounts.feature_hours_logging +
  // hourly_rate_minor land in Section 9; the per-entry table is here.
  if (!(await knex.schema.hasTable('customer_hour_entries'))) {
    await knex.schema.createTable('customer_hour_entries', (table) => {
      table.increments('id').primary();
      table.integer('customer_account_id').unsigned().notNullable()
        .references('id').inTable('customer_accounts').onDelete('CASCADE');

      table.date('entry_date').notNullable();
      // "HH:MM" — varchar so the editor's <input type="time">
      // round-trips without timezone interpretation. duration_minutes
      // is computed server-side on save so aggregate queries don't
      // re-parse every row.
      table.string('start_time', 5).notNullable();
      table.string('end_time', 5).notNullable();
      table.integer('duration_minutes').notNullable();

      // null = inherit customer.hourly_rate_minor.
      table.bigInteger('hourly_rate_minor_override');

      table.text('description');

      // 'unbilled' → 'billed' (folded into an invoice line).
      // 'cancelled' reserved for a future soft-delete-after-billing
      // workflow; deletes are hard for now.
      table.string('status', 16).notNullable().defaultTo('unbilled');

      // Backlink to the resulting invoice + specific line item.
      // ON DELETE SET NULL so purging an invoice keeps the audit
      // trail (admin can still see entry duration + description).
      table.integer('invoice_id').unsigned()
        .references('id').inTable('invoices').onDelete('SET NULL');
      table.integer('invoice_line_item_id').unsigned()
        .references('id').inTable('invoice_line_items').onDelete('SET NULL');
      table.timestamp('billed_at');

      table.integer('recorded_by_admin_id').unsigned()
        .references('id').inTable('admin_users').onDelete('SET NULL');
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());

      table.index(['customer_account_id', 'status']);
      table.index(['invoice_id']);
    });
  }

  // -------------------------------------------------------------------------
  // SECTION 8 — Document sequences (atomic gap-free numbering)
  // -------------------------------------------------------------------------
  // Source: mig 132. One row per (kind, year). Atomic INCREMENT on
  // claim — serialises concurrent admin creates on the row lock
  // (Postgres) or transaction lock (SQLite). Replaces the racy
  // SELECT MAX + INSERT pattern; §14 UStG requires gap-free
  // single-sequence-per-year for invoice numbering.
  //
  // NO backfill loop here — on a fresh install there are no
  // pre-existing invoice/quote/contract rows to read MAX() from.
  // Year rows are created on demand via UPSERT in
  // backend/src/utils/documentSequences.js.
  if (!(await knex.schema.hasTable('document_sequences'))) {
    await knex.schema.createTable('document_sequences', (table) => {
      table.increments('id').primary();
      // Discriminator: 'invoice' | 'quote' | 'contract'. Open
      // string so future doc types (storno, proforma…) reuse the
      // table without a schema change.
      table.string('kind', 32).notNullable();
      table.integer('year').notNullable();
      table.integer('current_value').notNullable().defaultTo(0);
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());

      // One sequence row per (kind, year). Lookups + atomic
      // increments both go through this index.
      table.unique(['kind', 'year']);
    });
  }

  // -------------------------------------------------------------------------
  // SECTION 9 — ALTER upstream tables (events, customer_accounts)
  // -------------------------------------------------------------------------
  // The tables here pre-date the CRM feature work and live on
  // upstream/beta. Every ALTER is hasColumn-guarded so a re-run is a
  // no-op. Each column references the source migration that added it.

  // ---- events --------------------------------------------------------
  if (await knex.schema.hasTable('events')) {
    // 102 — events.quote_id FK to quotes. Nullable, ON DELETE SET
    // NULL so deleting a converted quote keeps the event's audit
    // trail intact.
    if (!(await knex.schema.hasColumn('events', 'quote_id'))) {
      await knex.schema.alterTable('events', (t) => {
        t.integer('quote_id').unsigned()
          .references('id').inTable('quotes').onDelete('SET NULL');
        t.index(['quote_id']);
      });
    }

    // 137 — admin calendar columns. is_full_day NOT NULL DEFAULT true
    // so existing rows backfill cleanly to the historical default
    // (everything was a full-day event before).
    if (!(await knex.schema.hasColumn('events', 'event_time_start'))) {
      await knex.schema.alterTable('events', (t) => {
        t.string('event_time_start', 5); // "HH:MM"
      });
    }
    if (!(await knex.schema.hasColumn('events', 'event_time_end'))) {
      await knex.schema.alterTable('events', (t) => {
        t.string('event_time_end', 5);
      });
    }
    if (!(await knex.schema.hasColumn('events', 'is_full_day'))) {
      await knex.schema.alterTable('events', (t) => {
        t.boolean('is_full_day').notNullable().defaultTo(true);
      });
    }
    // Defensive backfill — handles any rows that landed via an older
    // partial state without the default.
    await knex('events').whereNull('is_full_day').update({ is_full_day: true });

    // 143 — pre-event customer reminder columns.
    if (!(await knex.schema.hasColumn('events', 'event_reminder_disabled'))) {
      await knex.schema.alterTable('events', (t) => {
        t.boolean('event_reminder_disabled').notNullable().defaultTo(false);
      });
    }
    if (!(await knex.schema.hasColumn('events', 'event_reminder_offset_days'))) {
      await knex.schema.alterTable('events', (t) => {
        t.integer('event_reminder_offset_days'); // null = inherit global
      });
    }
    if (!(await knex.schema.hasColumn('events', 'event_reminder_body_override'))) {
      await knex.schema.alterTable('events', (t) => {
        t.text('event_reminder_body_override');
      });
    }
    if (!(await knex.schema.hasColumn('events', 'event_reminder_sent_at'))) {
      await knex.schema.alterTable('events', (t) => {
        t.timestamp('event_reminder_sent_at');
        t.index('event_reminder_sent_at', 'events_event_reminder_sent_at_idx');
      });
    }
  }

  // ---- customer_accounts ---------------------------------------------
  if (await knex.schema.hasTable('customer_accounts')) {
    // 102 — billing_cadence + cycle_day. per_event default = "every
    // invoice is sent on its own schedule" (the historical behaviour);
    // monthly / quarterly snap to the cycle day instead.
    if (!(await knex.schema.hasColumn('customer_accounts', 'billing_cadence'))) {
      await knex.schema.alterTable('customer_accounts', (t) => {
        t.string('billing_cadence', 16).notNullable().defaultTo('per_event');
        t.integer('billing_cycle_day').notNullable().defaultTo(1);
      });
    }

    // 107 — free-text country override (mirrors business_profile column).
    if (!(await knex.schema.hasColumn('customer_accounts', 'country_name'))) {
      await knex.schema.alterTable('customer_accounts', (t) => {
        t.string('country_name', 120);
      });
    }

    // 129 — per-customer hour-logging toggle + default hourly rate.
    // hourly_rate_minor nullable = "admin must enter a per-entry
    // override or the entry save fails."
    if (!(await knex.schema.hasColumn('customer_accounts', 'feature_hours_logging'))) {
      await knex.schema.alterTable('customer_accounts', (t) => {
        t.boolean('feature_hours_logging').notNullable().defaultTo(false);
      });
    }
    if (!(await knex.schema.hasColumn('customer_accounts', 'hourly_rate_minor'))) {
      await knex.schema.alterTable('customer_accounts', (t) => {
        t.bigInteger('hourly_rate_minor');
      });
    }
  }

  // (Sections 10 + 11 from the scaffold — system payment-term seeds —
  // landed inline inside Section 2's createTable blocks. The "Net 14/
  // 30/60/90 / Sofort fällig" rows ARE the seed; no separate seed pass
  // needed. The legacy `payment_term_templates` seed also embedded
  // there. Note: source migration 120 ALSO inserted Net 30/60/90 rows
  // into the LEGACY `payment_term_templates` table — those rows are
  // intentionally NOT duplicated here. The new split table is the
  // intended forward path; the legacy "Net 30/60/90 on legacy table"
  // rows from 120 were a stopgap before 124 split the concepts. Fresh
  // installs jump straight to the split-table world.)

  // -------------------------------------------------------------------------
  // SECTION 12 — Email templates (content owned by self-heal services)
  // -------------------------------------------------------------------------
  // This migration owns SCHEMA only — no template_key rows are
  // inserted here. CRM email-template content + skeleton rows are
  // managed by three runtime self-heal services that idempotently
  // create missing rows + backfill empty translations on first
  // access (boot / first GET /admin/email/templates / first cron):
  //
  //   - backend/src/services/contractEmailTemplates.js  (mig 130/131
  //     equivalents: contract_sent, contract_fully_signed,
  //     contract_signed_admin_notification)
  //   - backend/src/services/eventReminderTemplates.js  (mig 143
  //     equivalent: event_reminder_default + per-event-type variants)
  //   - backend/src/services/crmEmailTemplates.js       (NEW — covers
  //     quote_sent, quote_accepted_*, quote_declined_admin,
  //     invoice_sent, invoice_reminder_first, invoice_reminder_second,
  //     invoice_paid_receipt, invoice_cancelled, invoice_payment_check,
  //     invoice_paid_admin_notification, storno_issued — equivalents
  //     of source mig 102 + 112 + 116 + 122 + 127.)
  //
  // The self-heal pattern (vs in-migration inserts) keeps legal/
  // marketing prose out of the schema diff, lets admin edits land
  // immediately without a migration round-trip, and matches the
  // feedback_migration_no_compensation rule when copy changes after
  // beta deploy. Pattern lifted from contractEmailTemplates.js.

  // -------------------------------------------------------------------------
  // SECTION 13 — Seed RBAC permissions + role grants
  // -------------------------------------------------------------------------
  // Source migrations: 102 (quotes/bills perms), 130 (contracts perms),
  // 134 (split customers.create into customers.edit + customers.events).
  // All idempotent via existing-name checks; grants project forward
  // from existing roles so nobody loses capability on upgrade.

  if (await knex.schema.hasTable('permissions') && await knex.schema.hasTable('role_permissions')) {
    // 1. Insert the 6 net-new CRM permissions (skip those already present).
    {
      const existing = await knex('permissions')
        .whereIn('name', NEW_PERMISSIONS.map((p) => p.name))
        .select('name');
      const existingSet = new Set(existing.map((r) => r.name));
      const toInsert = NEW_PERMISSIONS.filter((p) => !existingSet.has(p.name));
      if (toInsert.length > 0) {
        await knex('permissions').insert(toInsert);
      }

      // Grant to super_admin + admin (the CRM resource-managing roles).
      const roles = await knex('roles')
        .whereIn('name', ['super_admin', 'admin']).select('id');
      const perms = await knex('permissions')
        .whereIn('name', NEW_PERMISSIONS.map((p) => p.name)).select('id');
      if (roles.length > 0 && perms.length > 0) {
        const grants = await knex('role_permissions').select('role_id', 'permission_id');
        const grantSet = new Set(grants.map((g) => `${g.role_id}-${g.permission_id}`));
        const inserts = [];
        for (const role of roles) {
          for (const perm of perms) {
            const key = `${role.id}-${perm.id}`;
            if (!grantSet.has(key)) inserts.push({ role_id: role.id, permission_id: perm.id });
          }
        }
        if (inserts.length > 0) await knex('role_permissions').insert(inserts);
      }
    }

    // 2. Split customers.create → customers.edit + customers.events
    //    (mig 134). Insert the two new permission rows + project the
    //    grants forward from every role that currently holds
    //    customers.create. See feedback_permission_split_compat memory.
    {
      const existing = await knex('permissions')
        .whereIn('name', CUSTOMERS_SPLIT_PERMISSIONS.map((p) => p.name))
        .select('name');
      const existingSet = new Set(existing.map((r) => r.name));
      const toInsert = CUSTOMERS_SPLIT_PERMISSIONS.filter((p) => !existingSet.has(p.name));
      if (toInsert.length > 0) {
        await knex('permissions').insert(toInsert);
      }

      const createPerm = await knex('permissions').where({ name: 'customers.create' }).first();
      if (createPerm) {
        const newPerms = await knex('permissions')
          .whereIn('name', CUSTOMERS_SPLIT_PERMISSIONS.map((p) => p.name)).select('id', 'name');
        const rolesWithCreate = await knex('role_permissions')
          .where({ permission_id: createPerm.id }).select('role_id');
        if (rolesWithCreate.length > 0 && newPerms.length > 0) {
          const existingGrants = await knex('role_permissions')
            .whereIn('permission_id', newPerms.map((p) => p.id))
            .select('role_id', 'permission_id');
          const grantSet = new Set(existingGrants.map((g) => `${g.role_id}-${g.permission_id}`));
          const inserts = [];
          for (const { role_id } of rolesWithCreate) {
            for (const perm of newPerms) {
              const key = `${role_id}-${perm.id}`;
              if (!grantSet.has(key)) inserts.push({ role_id, permission_id: perm.id });
            }
          }
          if (inserts.length > 0) await knex('role_permissions').insert(inserts);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // SECTION 14 — Feature flags + app_settings
  // -------------------------------------------------------------------------
  // Source migrations: 102 (quotes/bills flags + 16 CRM_SUB_SETTINGS +
  // 4 ToS settings via 104), 109 (customer_feature_* toggles enabled),
  // 125 (default payment-term-template IDs — derived from the seeded
  // template rows), 130 (contracts flag + 6 settings), 138 (force-off
  // locked roadmap flags — pre-existing reminderEmails/calendarBooking/
  // messaging rows get clamped to false), 141 (3 installment defaults),
  // 143 (2 event reminder settings).

  // Feature flags — insert any missing CRM flags as OFF.
  if (await knex.schema.hasTable('feature_flags')) {
    for (const key of NEW_FEATURE_FLAGS) {
      const existing = await knex('feature_flags').where({ key }).first();
      if (!existing) {
        await knex('feature_flags').insert({ key, value: false });
      }
    }
    // Mig 138 — force locked roadmap flags OFF on installs that might
    // have them pre-seeded ON from an older codepath. No-op on a
    // fresh install where the rows don't pre-exist.
    const lockedRoadmapFlags = ['reminderEmails', 'calendarBooking', 'messaging'];
    await knex('feature_flags')
      .whereIn('key', lockedRoadmapFlags)
      .andWhere(function () {
        this.where('value', 1).orWhere('value', true).orWhere('value', '1');
      })
      .update({ value: 0 });
  }

  // App settings — CRM behaviour + ToS + customer surface + installment
  // defaults + event reminder defaults. Idempotent skip-on-exists so
  // re-runs never clobber admin customisation.
  if (await knex.schema.hasTable('app_settings')) {
    const allSettings = [...CRM_SUB_SETTINGS, ...CUSTOMER_FEATURE_SETTINGS];
    for (const row of allSettings) {
      const existing = await knex('app_settings').where('setting_key', row.setting_key).first();
      if (!existing) {
        await knex('app_settings').insert({
          setting_key: row.setting_key,
          setting_value: JSON.stringify(row.setting_value),
          setting_type: row.setting_type,
        });
      }
    }

    // Mig 125 — default payment-term template IDs. Looked up by name
    // / net_days against the system rows seeded in Section 2 so the
    // setting points at the right row even if admin later renames it.
    if (await knex.schema.hasTable('payment_net_days_templates')
        && await knex.schema.hasTable('payment_timing_templates')) {
      const netDays30 = await knex('payment_net_days_templates')
        .where({ is_system: true, net_days: 30 }).first();
      const timingDelivery = await knex('payment_timing_templates')
        .where({ is_system: true, name: 'Komplettzahlung nach Auslieferung' }).first();

      const paymentDefaults = [];
      if (netDays30) paymentDefaults.push({
        setting_key: 'crm_invoices_default_payment_net_days_template_id',
        setting_value: netDays30.id,
        setting_type: 'crm',
      });
      if (timingDelivery) paymentDefaults.push({
        setting_key: 'crm_invoices_default_payment_timing_template_id',
        setting_value: timingDelivery.id,
        setting_type: 'crm',
      });
      for (const row of paymentDefaults) {
        const existing = await knex('app_settings').where('setting_key', row.setting_key).first();
        if (!existing) {
          await knex('app_settings').insert({
            setting_key: row.setting_key,
            setting_value: JSON.stringify(row.setting_value),
            setting_type: row.setting_type,
          });
        }
      }
    }
  }
};

// ===========================================================================
// down()
// ===========================================================================

exports.down = async function (knex) {
  // Down policy:
  //   - DROP all CRM tables in reverse FK dependency order.
  //   - DROP ALTER columns on upstream tables (events, customer_accounts).
  //   - LEAVE seeded permissions, feature_flags, and app_settings in place.
  //     Admins may have customised values; rolling back a seed shouldn't
  //     clobber them. Matches the policy in source migrations 105/125/141.
  //   - Reverse drop_index calls aren't strictly needed — dropTable
  //     reaps indexes — but we drop named raw indexes explicitly for
  //     consistency with the up() raw CREATE INDEX calls.

  // Some FKs point INTO CRM tables from quotes/invoices (e.g.
  // quotes.converted_contract_id → contracts, invoices.source_contract_id
  // → contracts). dropTable on the referenced table handles these on
  // Postgres + SQLite (knex's dropTable cascades the FK definitions),
  // but we drop the referencing tables first regardless so the order is
  // explicit and dialect-tolerant.

  // ---- raw-CREATE indexes on invoices (must drop before dropping table) ----
  if (await knex.schema.hasTable('invoices')) {
    await knex.raw('DROP INDEX IF EXISTS invoices_one_monthly_draft_per_customer').catch(() => {});
    await knex.raw('DROP INDEX IF EXISTS invoices_monthly_draft_idx').catch(() => {});
    await knex.raw('DROP INDEX IF EXISTS invoices_kind_status_idx').catch(() => {});
  }

  // ---- CRM tables in reverse FK dependency order ---------------------------
  // Drop child tables before parents. customer_hour_entries depends on
  // invoices + invoice_line_items + customer_accounts. event_payment_plans
  // depends on events + quotes. Contract tables depend on contracts +
  // contract_blocks + customer_accounts. Invoice tables depend on invoices.
  // Quote tables depend on quotes.
  const tablesInDropOrder = [
    'invoice_payment_check_tokens',
    'customer_hour_entries',
    'event_payment_plans',
    'contract_action_tokens',
    'contract_block_inclusions',
    'contracts',
    'contract_blocks',
    'document_sequences',
    'invoice_payment_log',
    'invoice_line_items',
    'invoices',
    'quote_action_tokens',
    'quote_line_items',
    'quote_line_item_presets',
    'quotes',
    'payment_timing_templates',
    'payment_net_days_templates',
    'payment_term_templates',
    'business_bank_accounts',
    'business_profile',
  ];
  for (const t of tablesInDropOrder) {
    await knex.schema.dropTableIfExists(t);
  }

  // ---- Reverse ALTER columns on upstream tables ---------------------------
  if (await knex.schema.hasTable('events')) {
    // Drop the reminder index explicitly first — Postgres tolerates
    // dropping a column with attached index, but SQLite older versions
    // emit a noisy warning. The `.catch` keeps the down tolerant.
    await knex.raw('DROP INDEX IF EXISTS events_event_reminder_sent_at_idx').catch(() => {});
    for (const col of [
      'event_reminder_sent_at',
      'event_reminder_body_override',
      'event_reminder_offset_days',
      'event_reminder_disabled',
      'is_full_day',
      'event_time_end',
      'event_time_start',
      'quote_id',
    ]) {
      if (await knex.schema.hasColumn('events', col)) {
        await knex.schema.alterTable('events', (t) => t.dropColumn(col));
      }
    }
  }

  if (await knex.schema.hasTable('customer_accounts')) {
    for (const col of [
      'hourly_rate_minor',
      'feature_hours_logging',
      'country_name',
      'billing_cycle_day',
      'billing_cadence',
    ]) {
      if (await knex.schema.hasColumn('customer_accounts', col)) {
        await knex.schema.alterTable('customer_accounts', (t) => t.dropColumn(col));
      }
    }
  }

  // Seeded permissions / feature_flags / app_settings: intentionally
  // left in place — admin may have customised values, and seed-on-
  // existing-key is a no-op for forward re-runs. Operators wanting a
  // truly clean revert delete those rows manually.
};
