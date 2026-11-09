/**
 * contractBlocksService — CRUD for the contract block library.
 *
 * The library is shared across all contracts. System blocks (12 seeded
 * by migration 130) cannot be deleted but their body text remains
 * editable so the admin's lawyer can rewrite them. Admin-authored
 * (non-system) blocks can be freely created, edited, and removed.
 *
 * Sections are validated against a fixed enum mirroring
 * contractService.SECTIONS_ORDER — keeping these in sync is the
 * "data-driven all the way down" guarantee (no orphan sections in
 * the DB that the renderer can't display).
 */

const { db, withRetry } = require('../database/db');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');
const { hasColumnCached } = require('../utils/schemaCache');

const ALLOWED_SECTIONS = ['basics', 'scope', 'privacy', 'commercial', 'nda', 'closing'];

/**
 * System blocks added to the seed AFTER migration 131 was already
 * deployed to beta. knex won't re-run an already-applied migration,
 * so the new system blocks listed here need a runtime self-heal —
 * same pattern as `ensureContractEmailTemplatesSeeded` for templates.
 *
 * Each entry must carry every column the row needs. `slug` is the
 * uniqueness key; the seeder is no-op when the row already exists.
 * EN/DE bodies only — non-EN/DE locales stay null until the admin
 * fills them in via the block library UI.
 */
const RUNTIME_SEEDED_BLOCKS = [
  {
    slug: 'quote_line_items_table',
    section: 'scope',
    name: 'Quote line items',
    description: 'Auto-inserts the source quote\'s line items as a table. Body text appears above the table.',
    body_text: 'Service items per quote {{source_quote_number}}:',
    body_text_de: 'Leistungspositionen gemäß Angebot {{source_quote_number}}:',
    is_system: true,
    is_active: true,
  },
  {
    // Closing provisions for a business in the United States. Only a US
    // business's new contracts carry it, in place of the Swiss and German
    // ones (contract/regionalClauses).
    slug: 'closing_jurisdiction_us',
    section: 'closing',
    name: 'Closing provisions (US law)',
    description: 'EXAMPLE — have your lawyer review before sending. Governing law and venue for a business in the United States: the laws of the state where the contractor is based.',
    body_text: `**Governing law and general terms**

This contract is governed by the laws of the state in which the contractor has its principal place of business, without regard to its conflict-of-laws rules.

Any dispute arising out of or in connection with this contract shall be brought in the state or federal courts for the county in which the contractor has its principal place of business, to the extent permitted by law.

If any provision of this contract is held invalid or unenforceable, the remaining provisions remain in full force and effect.

This contract is the entire agreement between the parties on its subject. Changes must be made in writing and signed by both parties; an electronic signature counts as a signature.`,
    body_text_de: `**Anwendbares Recht und allgemeine Bestimmungen**

Dieser Vertrag unterliegt dem Recht des US-Bundesstaates, in dem der Auftragnehmer seinen Hauptgeschäftssitz hat, unter Ausschluss der Kollisionsnormen dieses Rechts.

Streitigkeiten aus oder im Zusammenhang mit diesem Vertrag werden – soweit gesetzlich zulässig – vor den einzelstaatlichen oder Bundesgerichten des County ausgetragen, in dem der Auftragnehmer seinen Hauptgeschäftssitz hat.

Sollte eine Bestimmung dieses Vertrages unwirksam oder nicht durchsetzbar sein, bleiben die übrigen Bestimmungen in vollem Umfang wirksam.

Dieser Vertrag enthält die gesamte Vereinbarung der Parteien über seinen Gegenstand. Änderungen bedürfen der Schriftform und der Unterschrift beider Parteien; eine elektronische Signatur gilt als Unterschrift.`,
    is_system: true,
    is_active: true,
  },
  // ---- United Kingdom (issue 2439) ----
  // Only a UK business's new contracts carry these, in place of the European
  // closing and data-protection clauses and the tiered cancellation fees
  // (contract/regionalClauses). Sources are listed on issue 2439; every text
  // is an example for a UK lawyer to check.
  {
    slug: 'closing_jurisdiction_gb',
    section: 'closing',
    name: 'Closing provisions (UK law)',
    description: 'EXAMPLE — have a UK lawyer review before sending. Governing law and courts of the part of the UK chosen under Settings → Business profile (England and Wales when none is chosen).',
    body_text: `**Governing law and general terms**

This contract is governed by the law of {{governing_law}}, and the courts of {{governing_law}} have jurisdiction over any dispute arising out of or in connection with it. A client who is a consumer and lives in another part of the United Kingdom may also bring proceedings in the courts of the part where they live.

If any provision of this contract is held invalid or unenforceable, the remaining provisions remain in full force and effect.

This contract is the entire agreement between the parties on its subject. Changes must be made in writing; an electronic signature counts as a signature. Nothing in this contract limits the statutory rights of a client who is a consumer.`,
    body_text_de: `**Anwendbares Recht und allgemeine Bestimmungen**

Dieser Vertrag unterliegt dem Recht von {{governing_law}}; für Streitigkeiten aus oder im Zusammenhang mit diesem Vertrag sind die Gerichte von {{governing_law}} zuständig. Ein Auftraggeber, der Verbraucher ist und in einem anderen Teil des Vereinigten Königreichs wohnt, kann auch vor den Gerichten seines Wohnsitzes klagen.

Sollte eine Bestimmung dieses Vertrages unwirksam oder nicht durchsetzbar sein, bleiben die übrigen Bestimmungen in vollem Umfang wirksam.

Dieser Vertrag enthält die gesamte Vereinbarung der Parteien über seinen Gegenstand. Änderungen bedürfen der Schriftform; eine elektronische Signatur gilt als Unterschrift. Die gesetzlichen Rechte eines Auftraggebers, der Verbraucher ist, bleiben unberührt.`,
    is_system: true,
    is_active: true,
  },
  {
    slug: 'data_protection_uk',
    section: 'privacy',
    name: 'Data protection (UK GDPR)',
    description: 'EXAMPLE — have a UK lawyer review before sending. UK GDPR and Data Protection Act 2018; the photographer is the controller. Check the transfer wording against the Data (Use and Access) Act 2025.',
    body_text: `**Data protection**

The contractor is the controller of the personal data it processes for this contract: the client's contact and order details and, where applicable, images of the client and their guests. It processes this data to perform the contract, to meet its legal obligations (such as keeping accounting records) and, where the client has agreed to it, for the portfolio use set out in this contract. Processing follows the UK General Data Protection Regulation and the Data Protection Act 2018.

Data is kept only as long as these purposes require. Where service providers process data outside the United Kingdom, the contractor puts in place the safeguards UK data protection law requires.

The client has the right to access, rectify and erase their data, to restrict or object to its processing, and to data portability, and may complain to the Information Commission. Further details are in the contractor's privacy notice.`,
    body_text_de: `**Datenschutz**

Der Auftragnehmer ist Verantwortlicher für die personenbezogenen Daten, die er für diesen Vertrag verarbeitet: Kontakt- und Auftragsdaten des Auftraggebers sowie gegebenenfalls Aufnahmen des Auftraggebers und seiner Gäste. Er verarbeitet diese Daten zur Erfüllung des Vertrages, zur Erfüllung gesetzlicher Pflichten (etwa der Aufbewahrung von Buchhaltungsunterlagen) und, soweit der Auftraggeber zugestimmt hat, für die in diesem Vertrag geregelte Portfolio-Nutzung. Die Verarbeitung erfolgt nach der UK General Data Protection Regulation und dem Data Protection Act 2018.

Daten werden nur so lange aufbewahrt, wie diese Zwecke es erfordern. Verarbeiten Dienstleister Daten ausserhalb des Vereinigten Königreichs, stellt der Auftragnehmer die nach britischem Datenschutzrecht erforderlichen Garantien sicher.

Der Auftraggeber hat das Recht auf Auskunft, Berichtigung und Löschung, auf Einschränkung der Verarbeitung, auf Widerspruch und auf Datenübertragbarkeit und kann sich bei der Information Commission beschweren. Weitere Angaben enthält die Datenschutzerklärung des Auftragnehmers.`,
    is_system: true,
    is_active: true,
  },
  {
    slug: 'moral_rights_gb',
    section: 'scope',
    name: 'Copyright and moral rights (UK)',
    description: 'EXAMPLE — have a UK lawyer review before sending. The photographer owns the copyright (CDPA 1988 s.11) and asserts the right to be identified (s.78).',
    body_text: `**Copyright and the right to be identified**

The contractor owns the copyright in the photographs and films it makes under this contract (Copyright, Designs and Patents Act 1988, section 11). The client receives the usage rights set out in this contract; the copyright itself does not pass to the client.

The contractor asserts its right to be identified as the author of the work under section 78 of the Copyright, Designs and Patents Act 1988. Where the client publishes, exhibits or shares the work, the client names the contractor as its author in a reasonable form.`,
    body_text_de: `**Urheberrecht und Recht auf Namensnennung**

Das Urheberrecht an den Fotos und Filmen, die der Auftragnehmer im Rahmen dieses Vertrages erstellt, liegt beim Auftragnehmer (Copyright, Designs and Patents Act 1988, Section 11). Der Auftraggeber erhält die in diesem Vertrag festgelegten Nutzungsrechte; das Urheberrecht selbst geht nicht auf ihn über.

Der Auftragnehmer macht sein Recht geltend, als Urheber des Werkes genannt zu werden (Section 78 Copyright, Designs and Patents Act 1988). Veröffentlicht, zeigt oder teilt der Auftraggeber das Werk, nennt er den Auftragnehmer in angemessener Form als Urheber.`,
    is_system: true,
    is_active: true,
  },
  {
    slug: 'portfolio_consent_gb',
    section: 'scope',
    name: 'Portfolio and marketing use (UK)',
    description: 'EXAMPLE — have a UK lawyer review before sending. Consent under CDPA 1988 s.85 for work commissioned for private and domestic purposes; withdrawable. Ask your lawyer whether it needs a separate signature.',
    body_text: `**Portfolio and marketing use**

Where the client commissioned the photographs or films for private and domestic purposes, such as a wedding or a family shoot, section 85 of the Copyright, Designs and Patents Act 1988 gives the client the right not to have copies issued to the public, shown in public or communicated to the public. By signing this contract, the client consents to the contractor using a selection of the work in its portfolio, on its website and social media, and in its own marketing.

The client may withdraw this consent for future use at any time by telling the contractor in writing. Printed material already in circulation stays in circulation; the contractor removes the work from its online channels within a reasonable time.`,
    body_text_de: `**Nutzung für Portfolio und Werbung**

Hat der Auftraggeber die Fotos oder Filme für private Zwecke in Auftrag gegeben, etwa für eine Hochzeit oder ein Familienshooting, hat er nach Section 85 des Copyright, Designs and Patents Act 1988 das Recht, die Verbreitung, öffentliche Vorführung und öffentliche Wiedergabe zu untersagen. Mit der Unterzeichnung dieses Vertrages willigt der Auftraggeber ein, dass der Auftragnehmer eine Auswahl der Aufnahmen in seinem Portfolio, auf seiner Website, in sozialen Medien und für eigene Werbung verwendet.

Der Auftraggeber kann diese Einwilligung jederzeit schriftlich für die Zukunft widerrufen. Bereits gedrucktes Material bleibt im Umlauf; aus seinen Online-Kanälen entfernt der Auftragnehmer die Aufnahmen innert angemessener Frist.`,
    is_system: true,
    is_active: true,
  },
  {
    slug: 'deposit_cancellation_gb',
    section: 'commercial',
    name: 'Booking deposit and cancellation (UK)',
    description: 'EXAMPLE — have a UK lawyer review before sending. Replaces the tiered cancellation fees for a UK business: a small reservation deposit, further retention limited to unavoidable loss (CMA37 para 6.62, CRA 2015 Sched. 2).',
    body_text: `**Booking deposit and cancellation**

The date is reserved for the client once the booking deposit set out in the quote has been paid. The deposit is a small part of the total price: it secures the date and covers the cost of turning away other work for it. If the client cancels, the contractor keeps the deposit.

If the client cancels, anything the contractor keeps beyond the deposit is limited to the loss it actually suffers and cannot avoid, such as costs already incurred and the profit lost on a date it can no longer rebook. Any payment above that is refunded.

If the contractor has to cancel, it refunds every payment, including the deposit.`,
    body_text_de: `**Buchungsanzahlung und Stornierung**

Der Termin ist für den Auftraggeber reserviert, sobald die im Angebot genannte Buchungsanzahlung bezahlt ist. Die Anzahlung ist ein kleiner Teil des Gesamtpreises: Sie sichert den Termin und deckt den Aufwand, für diesen Tag andere Aufträge abzulehnen. Storniert der Auftraggeber, behält der Auftragnehmer die Anzahlung.

Storniert der Auftraggeber, kann der Auftragnehmer über die Anzahlung hinaus nur den Schaden behalten, der ihm tatsächlich entsteht und den er nicht vermeiden kann, etwa bereits angefallene Kosten und den entgangenen Gewinn für einen Termin, den er nicht mehr neu vergeben kann. Darüber hinausgehende Zahlungen werden erstattet.

Muss der Auftragnehmer absagen, erstattet er alle Zahlungen einschliesslich der Anzahlung.`,
    is_system: true,
    is_active: true,
  },
  {
    slug: 'consumer_cancellation_gb',
    section: 'commercial',
    name: 'Right to cancel within 14 days (UK consumers)',
    description: 'EXAMPLE — have a UK lawyer review before sending. Consumer Contracts Regulations 2013 (regs 29–36, Sched. 3 model form). Added for consumer customers only. Open question: whether reg 28(1)(h) exempts date-bound shoots.',
    body_text: `**Your right to cancel**

If you are a consumer and this contract was made at a distance (for example online or by email) or away from the contractor's business premises, you have the right to cancel it within 14 days of the day it was made, without giving any reason (Consumer Contracts (Information, Cancellation and Additional Charges) Regulations 2013).

To cancel, tell the contractor of your decision by a clear statement, for example by email or by letter to the address in this contract. You may use the model cancellation form below, but you don't have to. It is enough to send your notice before the 14 days have passed.

If you cancel, the contractor refunds all payments it has received from you without undue delay, and no later than 14 days after it is told of your decision, using the same means of payment.

If you asked for the services to begin during the cancellation period, you pay an amount in proportion to what has been provided until you told the contractor you are cancelling. Once the services have been fully performed at your express request, and you acknowledged that you then lose the right to cancel, you can no longer cancel.

**Model cancellation form**

To {{issuer_company_name}}, {{issuer_address}}:

I/We hereby give notice that I/We cancel my/our contract for the supply of the following service: ______

Ordered on: ______

Name of consumer(s): ______

Address of consumer(s): ______

Signature of consumer(s) (only if this form is notified on paper): ______

Date: ______`,
    body_text_de: `**Ihr Widerrufsrecht**

Sind Sie Verbraucher und wurde dieser Vertrag im Fernabsatz (etwa online oder per E-Mail) oder ausserhalb der Geschäftsräume des Auftragnehmers geschlossen, können Sie ihn innerhalb von 14 Tagen ab Vertragsschluss ohne Angabe von Gründen widerrufen (Consumer Contracts (Information, Cancellation and Additional Charges) Regulations 2013).

Um zu widerrufen, teilen Sie dem Auftragnehmer Ihren Entschluss mit einer eindeutigen Erklärung mit, etwa per E-Mail oder per Brief an die Adresse in diesem Vertrag. Sie können das folgende Muster-Widerrufsformular verwenden, müssen es aber nicht. Zur Wahrung der Frist genügt es, die Erklärung vor Ablauf der 14 Tage abzusenden.

Wenn Sie widerrufen, erstattet der Auftragnehmer alle von Ihnen erhaltenen Zahlungen unverzüglich, spätestens 14 Tage nach Eingang Ihres Widerrufs, über dasselbe Zahlungsmittel.

Haben Sie verlangt, dass die Leistungen während der Widerrufsfrist beginnen, zahlen Sie einen Betrag, der dem Anteil der bis zu Ihrem Widerruf erbrachten Leistungen entspricht. Sind die Leistungen auf Ihr ausdrückliches Verlangen vollständig erbracht und haben Sie bestätigt, dass Sie damit Ihr Widerrufsrecht verlieren, können Sie nicht mehr widerrufen.

**Muster-Widerrufsformular**

An {{issuer_company_name}}, {{issuer_address}}:

Hiermit widerrufe(n) ich/wir den von mir/uns abgeschlossenen Vertrag über die Erbringung der folgenden Dienstleistung: ______

Bestellt am: ______

Name des/der Verbraucher(s): ______

Anschrift des/der Verbraucher(s): ______

Unterschrift des/der Verbraucher(s) (nur bei Mitteilung auf Papier): ______

Datum: ______`,
    is_system: true,
    is_active: true,
  },
];

// Module-scope flag so the seed check runs once per process. The
// underlying queries are still idempotent — this just saves the round
// trip on every listBlocks / createContract call.
let _systemBlocksSeeded = false;

/**
 * Self-heal: insert any RUNTIME_SEEDED_BLOCKS entries that don't yet
 * exist in contract_blocks. Called from listBlocks + createContract
 * paths so new system blocks appear automatically on installs that
 * applied an earlier version of migration 131. Idempotent.
 */
async function ensureSystemBlocksSeeded() {
  if (_systemBlocksSeeded) return [];
  if (!(await db.schema.hasTable('contract_blocks'))) return [];
  const newlyInserted = [];
  for (const def of RUNTIME_SEEDED_BLOCKS) {
    try {
      const existing = await db('contract_blocks').where({ slug: def.slug }).first();
      if (existing) continue;
      // display_order = current MAX in the target section + 1 so the
      // new block sorts to the end. Matches the migration's behaviour.
      const maxOrderRow = await db('contract_blocks')
        .where({ section: def.section })
        .max('display_order as max').first();
      const nextOrder = (maxOrderRow?.max || 0) + 1;
      await db('contract_blocks').insert({
        ...def,
        display_order: nextOrder,
        created_at: new Date(),
        updated_at: new Date(),
      });
      newlyInserted.push(def.slug);
      logger.info(`Self-healed missing system contract block at runtime: ${def.slug}`);
    } catch (err) {
      logger.error(`Failed to seed system contract block ${def.slug}`, { message: err.message });
      // Keep _systemBlocksSeeded=false so the next call retries.
      return newlyInserted;
    }
  }
  _systemBlocksSeeded = true;
  return newlyInserted;
}

function ensureSection(section) {
  if (!ALLOWED_SECTIONS.includes(section)) {
    throw new AppError(
      `Invalid section '${section}'. Must be one of: ${ALLOWED_SECTIONS.join(', ')}`,
      400,
      'INVALID_SECTION',
    );
  }
}

function slugify(name) {
  const base = String(name || 'block')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  // Append a 6-hex suffix so admin-authored blocks don't collide with
  // each other or with seeded slugs.
  const suffix = require('crypto').randomBytes(3).toString('hex');
  return `${base || 'block'}_${suffix}`;
}

async function listBlocks({ section, includeInactive = false, forNewContract = false } = {}) {
  // Self-heal before reading so the new system block (added to the
  // already-deployed migration 131 in feat/crm) appears in the
  // library UI immediately on first GET, without needing a fresh
  // install. Safe to call repeatedly — guarded by _systemBlocksSeeded.
  await ensureSystemBlocksSeeded();
  const blocks = await withRetry(async () => {
    let q = db('contract_blocks').select('*');
    if (section) q = q.where({ section });
    if (!includeInactive) q = q.where({ is_active: true });
    q = q.orderBy('section', 'asc').orderBy('display_order', 'asc').orderBy('id', 'asc');
    return await q;
  });
  if (!forNewContract) return blocks;
  // What a new contract starts from: the clauses for the business's legal
  // system. The library and the template editor still list them all.
  const { profile } = await require('./businessProfileService').getProfile();
  return require('./contract/regionalClauses').systemBlocksFor(blocks, profile?.country_code);
}

async function getBlockById(id) {
  return await db('contract_blocks').where({ id }).first();
}

async function createBlock(payload) {
  if (!payload.name || !String(payload.name).trim()) {
    throw new AppError('Block name is required', 400);
  }
  ensureSection(payload.section);
  if (!payload.bodyText || !String(payload.bodyText).trim()) {
    throw new AppError('Block body (EN) is required', 400);
  }

  const slug = payload.slug && /^[a-z0-9_]+$/.test(payload.slug)
    ? payload.slug
    : slugify(payload.name);

  // Ensure slug uniqueness (regenerate on the rare collision).
  let finalSlug = slug;
  let attempt = 0;
  while (await db('contract_blocks').where({ slug: finalSlug }).first()) {
    attempt += 1;
    finalSlug = slugify(payload.name);
    if (attempt > 5) {
      throw new AppError('Could not generate a unique block slug', 500);
    }
  }

  const row = {
    slug: finalSlug,
    section: payload.section,
    name: String(payload.name).trim().slice(0, 128),
    description: payload.description ? String(payload.description).slice(0, 255) : null,
    body_text: String(payload.bodyText),
    body_text_de: payload.bodyTextDe ? String(payload.bodyTextDe) : null,
    is_system: false,
    is_active: payload.isActive !== false,
    display_order: Number.isFinite(payload.displayOrder) ? Number(payload.displayOrder) : 100,
    created_at: new Date(),
    updated_at: new Date(),
  };
  // Schema-drift guard — migration 131 adds these columns. On installs
  // that haven't migrated yet, only EN+DE bodies persist; the other
  // four fields are accepted from the payload but silently dropped.
  for (const [field, payloadKey] of [
    ['body_text_ru', 'bodyTextRu'],
    ['body_text_pt', 'bodyTextPt'],
    ['body_text_nl', 'bodyTextNl'],
    ['body_text_fr', 'bodyTextFr'],
  ]) {
    if (payload[payloadKey] != null
        && await hasColumnCached('contract_blocks', field)) {
      row[field] = payload[payloadKey] ? String(payload[payloadKey]) : null;
    }
  }

  const inserted = await db('contract_blocks').insert(row).returning('id');
  const id = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];
  return await getBlockById(id);
}

/**
 * Update a block. System blocks: every field is editable so the
 * admin's lawyer can rewrite the body text in place. The only
 * protection on system blocks is that they can't be hard-deleted —
 * an admin who wants to retire one toggles `is_active=false`.
 */
async function updateBlock(id, payload) {
  const existing = await getBlockById(id);
  if (!existing) throw new AppError('Block not found', 404);

  const updates = { updated_at: new Date() };
  if ('section' in payload) {
    ensureSection(payload.section);
    updates.section = payload.section;
  }
  if ('name' in payload) {
    if (!payload.name || !String(payload.name).trim()) {
      throw new AppError('Block name is required', 400);
    }
    updates.name = String(payload.name).trim().slice(0, 128);
  }
  if ('description' in payload) {
    updates.description = payload.description ? String(payload.description).slice(0, 255) : null;
  }
  if ('bodyText' in payload) {
    if (!payload.bodyText || !String(payload.bodyText).trim()) {
      throw new AppError('Block body (EN) is required', 400);
    }
    updates.body_text = String(payload.bodyText);
  }
  if ('bodyTextDe' in payload) {
    updates.body_text_de = payload.bodyTextDe ? String(payload.bodyTextDe) : null;
  }
  // Same schema-drift guard as createBlock — accept ru/pt/nl/fr only
  // when the column actually exists, so beta installs running this
  // service against a not-yet-migrated DB don't throw.
  for (const [field, payloadKey] of [
    ['body_text_ru', 'bodyTextRu'],
    ['body_text_pt', 'bodyTextPt'],
    ['body_text_nl', 'bodyTextNl'],
    ['body_text_fr', 'bodyTextFr'],
  ]) {
    if (payloadKey in payload
        && await hasColumnCached('contract_blocks', field)) {
      updates[field] = payload[payloadKey] ? String(payload[payloadKey]) : null;
    }
  }
  if ('isActive' in payload) {
    updates.is_active = payload.isActive !== false;
  }
  if ('displayOrder' in payload && Number.isFinite(payload.displayOrder)) {
    updates.display_order = Number(payload.displayOrder);
  }

  await db('contract_blocks').where({ id }).update(updates);
  return await getBlockById(id);
}

/**
 * Hard-delete an admin-authored block. System blocks refuse delete —
 * the admin must `deactivate` (toggle `is_active=false`) instead.
 *
 * Active inclusions on existing contracts are protected by the FK
 * ON DELETE RESTRICT — deleting a block that's still referenced will
 * raise a DB error which we catch and surface as a clean 409.
 */
async function deleteBlock(id) {
  const existing = await getBlockById(id);
  if (!existing) throw new AppError('Block not found', 404);
  if (existing.is_system) {
    throw new AppError(
      'System blocks cannot be deleted. Toggle them inactive instead so they remain available for audit on old contracts.',
      409,
      'SYSTEM_BLOCK_PROTECTED',
    );
  }
  try {
    await db('contract_blocks').where({ id }).del();
  } catch (err) {
    if (/foreign key|FOREIGN KEY|RESTRICT/i.test(err.message)) {
      throw new AppError(
        'This block is referenced by one or more contracts. Toggle it inactive instead of deleting.',
        409,
        'BLOCK_IN_USE',
      );
    }
    throw err;
  }
  return { id };
}

module.exports = {
  listBlocks,
  getBlockById,
  createBlock,
  updateBlock,
  deleteBlock,
  ensureSystemBlocksSeeded,
  ALLOWED_SECTIONS,
};
