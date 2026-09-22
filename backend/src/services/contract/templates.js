'use strict';

/**
 * Contract templates (#1445).
 *
 * A template has at most one editable draft version and any number of
 * immutable published ones — the newest is `current_version`, earlier ones
 * are `superseded`. A version is an ordered list of clauses (a library block
 * with an optional per-template override, or a free-text section) plus a
 * title, intro and outro. Publishing freezes the blocks' bodies into the
 * version (`body_snapshot`) and records a sha256 of the resolved content, so
 * later edits to the clause library or the template never change what a
 * published version — or a contract made from it — says.
 *
 * Every write that changes a template's content takes the `lockVersion` the
 * editor loaded. A stale one is refused (409 TEMPLATE_CONFLICT) instead of
 * silently overwriting another admin's edit. System templates are copied,
 * not edited.
 */

const { db, logActivity } = require('../../database/db');
const { AppError } = require('../../utils/errors');
const { auditedInsert, deleteWithAccountingHistory } = require('../accountingHistory');
const { ensureInt } = require('../../utils/numericHelpers');
const { upsertAppSetting } = require('../../utils/appSettings');
const { unknownPlaceholders, conditionalProblems, CONTRACT_PLACEHOLDERS } = require('../../utils/placeholders');
const { canonicalSha256 } = require('../../utils/canonicalJson');
const { ALLOWED_SECTIONS } = require('../contractBlocksService');
const { DEFAULT_SETTING, ensureDefaultTemplate, getDefaultTemplateId } = require('./defaultTemplate');
const content = require('./content');
const attachments = require('./attachments');
const { insertBeforeLastPage } = require('../pdf/merge');
const crypto = require('crypto');

const MAX_ITEMS = 200;
const MAX_DESCRIPTION = 2000;

const insertedId = (rows) => (typeof rows[0] === 'object' ? rows[0].id : rows[0]);
const truthy = (v) => v === true || v === 1 || v === '1';

function invalid(message) {
  return new AppError(message, 400, 'TEMPLATE_INVALID');
}

function notFound() {
  return new AppError('Template not found', 404, 'TEMPLATE_NOT_FOUND');
}

function conflict() {
  return new AppError('Someone else changed this template. Reload it to see their changes.', 409, 'TEMPLATE_CONFLICT');
}

async function audit(type, meta, adminId) {
  try {
    await logActivity(type, meta, null, `admin:${adminId}`);
  } catch (_) { /* non-fatal */ }
}

// ---------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------

function loadItems(versionId, conn = db) {
  return conn('contract_template_version_items as it')
    .leftJoin('contract_blocks as blk', 'blk.id', 'it.block_id')
    .where('it.version_id', versionId)
    .orderBy('it.position', 'asc')
    .select(
      'it.*',
      'blk.slug as block_slug',
      'blk.name as block_name',
      'blk.is_active as block_is_active',
      'blk.body_text as block_body_text',
      'blk.body_text_de as block_body_text_de',
      'blk.body_text_ru as block_body_text_ru',
      'blk.body_text_pt as block_body_text_pt',
      'blk.body_text_nl as block_body_text_nl',
      'blk.body_text_fr as block_body_text_fr',
    );
}

function itemToApi(row) {
  const isBlock = row.kind === 'block';
  return {
    id: row.id,
    position: row.position,
    section: row.section,
    kind: row.kind,
    blockId: row.block_id || null,
    block: isBlock ? {
      slug: row.block_slug || null,
      name: row.block_name || null,
      isActive: truthy(row.block_is_active),
      bodies: content.blockBodies(row, 'block_'),
    } : null,
    heading: row.heading || null,
    // A block's per-template override, or a free-text section's body.
    body: content.parseLocaleMap(row.body_override),
    // The block's bodies as frozen at publish (published versions only).
    snapshot: content.parseLocaleMap(row.body_snapshot),
  };
}

function versionToApi(version, items, attachmentRows) {
  return {
    id: version.id,
    version: ensureInt(version.version_number),
    status: version.status,
    title: version.title || '',
    introText: content.parseLocaleMap(version.intro_text),
    outroText: content.parseLocaleMap(version.outro_text),
    contentSha256: version.content_sha256 || null,
    publishedAt: version.published_at || null,
    createdAt: version.created_at || null,
    // Who published it (#1445 version history). Null for the seeded system
    // version, and for a publisher whose account is gone.
    publishedBy: version.published_by_admin_id && version.publisher_username
      ? { id: version.published_by_admin_id, username: version.publisher_username }
      : null,
    ...(items ? { items: items.map(itemToApi) } : {}),
    ...(attachmentRows ? { attachments: attachmentRows.map(attachments.inclusionToApi) } : {}),
  };
}

function templateToApi(template, defaultId) {
  return {
    id: template.id,
    name: template.name,
    description: template.description || null,
    useCase: template.use_case || null,
    isSystem: truthy(template.is_system),
    status: template.status,
    currentVersion: template.current_version == null ? null : ensureInt(template.current_version),
    lockVersion: ensureInt(template.lock_version),
    isDefault: defaultId != null && Number(defaultId) === Number(template.id),
    createdAt: template.created_at,
    updatedAt: template.updated_at,
  };
}

/** Every template, archived ones included (admin authoring lists show everything). */
async function listTemplates() {
  await ensureDefaultTemplate();
  const defaultId = await getDefaultTemplateId();
  const rows = await db('contract_templates')
    .orderBy('is_system', 'desc')
    .orderBy('name', 'asc');
  const versions = await db('contract_template_versions')
    .whereIn('status', ['draft', 'published'])
    .select('id', 'template_id', 'status');
  const withDraft = new Set(versions.filter((v) => v.status === 'draft').map((v) => Number(v.template_id)));
  const publishedId = new Map(versions.filter((v) => v.status === 'published').map((v) => [Number(v.template_id), v.id]));
  return rows.map((t) => ({
    ...templateToApi(t, defaultId),
    hasDraft: withDraft.has(Number(t.id)),
    // What a new contract from this template is made from.
    currentVersionId: publishedId.get(Number(t.id)) || null,
  }));
}

/** A template's versions with their publisher's username. */
function versionsWithPublisher(conn = db) {
  return conn('contract_template_versions as v')
    .leftJoin('admin_users as pub', 'pub.id', 'v.published_by_admin_id')
    .select('v.*', 'pub.username as publisher_username');
}

async function getTemplate(id) {
  const template = await db('contract_templates').where({ id }).first();
  if (!template) throw notFound();
  const versions = await versionsWithPublisher().where('v.template_id', id).orderBy('v.version_number', 'desc');
  const draftRow = versions.find((v) => v.status === 'draft') || null;
  const publishedRow = versions.find((v) => v.status === 'published') || null;
  return {
    template: templateToApi(template, await getDefaultTemplateId()),
    draft: draftRow
      ? versionToApi(draftRow, await loadItems(draftRow.id), await attachments.loadVersionAttachments(draftRow.id))
      : null,
    published: publishedRow
      ? versionToApi(publishedRow, await loadItems(publishedRow.id), await attachments.loadVersionAttachments(publishedRow.id))
      : null,
    versions: versions.filter((v) => v.status !== 'draft').map((v) => versionToApi(v)),
  };
}

async function getVersion(templateId, versionNumber) {
  const version = await versionsWithPublisher()
    .where({ 'v.template_id': templateId, 'v.version_number': versionNumber })
    .first();
  if (!version) throw new AppError('Template version not found', 404, 'TEMPLATE_VERSION_NOT_FOUND');
  return versionToApi(version, await loadItems(version.id), await attachments.loadVersionAttachments(version.id));
}

// ---------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------

function sanitizeMeta(payload, { requireName = false } = {}) {
  const out = {};
  if (payload.name !== undefined || requireName) {
    const name = String(payload.name || '').trim();
    if (!name || name.length > 128) throw invalid('A template needs a name of up to 128 characters');
    out.name = name;
  }
  if (payload.description !== undefined) {
    const description = payload.description == null ? '' : String(payload.description).trim();
    if (description.length > MAX_DESCRIPTION) throw invalid(`The description is limited to ${MAX_DESCRIPTION} characters`);
    out.description = description || null;
  }
  if (payload.useCase !== undefined) {
    out.use_case = payload.useCase == null ? null : (String(payload.useCase).trim().slice(0, 64) || null);
  }
  return out;
}

/** Validate the editor's clause list into version-item rows (positions 1..n). */
async function sanitizeItems(items, conn) {
  if (!Array.isArray(items)) throw invalid('items must be a list');
  if (items.length > MAX_ITEMS) throw invalid(`A template has at most ${MAX_ITEMS} clauses`);
  const blockIds = [...new Set(items
    .filter((item) => item && item.kind === 'block')
    .map((item) => ensureInt(item.blockId))
    .filter(Boolean))];
  const blocks = blockIds.length ? await conn('contract_blocks').whereIn('id', blockIds).select('id', 'section') : [];
  const sectionByBlock = new Map(blocks.map((b) => [Number(b.id), b.section]));

  return items.map((item, index) => {
    const label = `Clause ${index + 1}`;
    if (!item || !['block', 'text'].includes(item.kind)) throw invalid(`${label}: unknown kind`);
    if (item.kind === 'block') {
      const blockId = ensureInt(item.blockId);
      const section = sectionByBlock.get(blockId);
      if (!section) throw invalid(`${label}: unknown clause-library block`);
      // A block keeps its library section, like on contracts.
      return {
        position: index + 1, section, kind: 'block', block_id: blockId, heading: null,
        body_override: content.serializeLocaleMap(content.sanitizeLocaleMap(item.body, label)),
      };
    }
    const section = String(item.section || '');
    if (!ALLOWED_SECTIONS.includes(section)) throw invalid(`${label}: unknown section`);
    const heading = item.heading == null ? null : (String(item.heading).trim().slice(0, 255) || null);
    return {
      position: index + 1, section, kind: 'text', block_id: null, heading,
      body_override: content.serializeLocaleMap(content.sanitizeLocaleMap(item.body, label)),
    };
  });
}

/** Take the template's lock: the caller's lockVersion must be current. */
async function claimLock(trx, id, lockVersion) {
  const template = await trx('contract_templates').where({ id }).first();
  if (!template) throw notFound();
  const current = ensureInt(template.lock_version);
  if (ensureInt(lockVersion) !== current) throw conflict();
  const updated = await trx('contract_templates')
    .where({ id, lock_version: current })
    .update({ lock_version: current + 1, updated_at: new Date() });
  if (!updated) throw conflict();
  return template;
}

function assertEditable(template) {
  if (truthy(template.is_system)) {
    throw new AppError('The standard template can\'t be edited. Duplicate it and edit the copy.', 409, 'TEMPLATE_SYSTEM');
  }
  if (template.status === 'archived') {
    throw new AppError('Restore the template before editing it', 409, 'TEMPLATE_ARCHIVED');
  }
}

async function copyItems(trx, fromVersionId, toVersionId) {
  const rows = await trx('contract_template_version_items').where({ version_id: fromVersionId }).orderBy('position');
  if (!rows.length) return;
  const now = new Date();
  await trx('contract_template_version_items').insert(rows.map((row) => ({
    version_id: toVersionId,
    position: row.position,
    section: row.section,
    kind: row.kind,
    block_id: row.block_id,
    heading: row.heading,
    body_override: row.body_override,
    created_at: now,
    updated_at: now,
  })));
}

async function nextVersionNumber(trx, templateId) {
  const row = await trx('contract_template_versions').where({ template_id: templateId }).max('version_number as v').first();
  return ensureInt(row && row.v) + 1;
}

/** The template's draft, created from `fromVersion` (default: the published one) when there is none. */
async function ensureDraft(trx, template, fromVersion = null) {
  const existing = await trx('contract_template_versions').where({ template_id: template.id, status: 'draft' }).first();
  if (existing) return existing;
  const source = fromVersion
    || await trx('contract_template_versions').where({ template_id: template.id, status: 'published' }).first();
  const now = new Date();
  const id = insertedId(await trx('contract_template_versions').insert({
    template_id: template.id,
    version_number: await nextVersionNumber(trx, template.id),
    status: 'draft',
    title: source ? source.title : null,
    intro_text: source ? source.intro_text : null,
    outro_text: source ? source.outro_text : null,
    created_at: now,
    updated_at: now,
  }).returning('id'));
  if (source) {
    await copyItems(trx, source.id, id);
    await attachments.copyVersionAttachments(trx, source.id, id);
  }
  return trx('contract_template_versions').where({ id }).first();
}

async function createTemplate(payload, adminId) {
  const meta = sanitizeMeta(payload, { requireName: true });
  const now = new Date();
  const id = await db.transaction(async (trx) => {
    const templateId = insertedId(await trx('contract_templates').insert({
      ...meta, is_system: false, status: 'draft', lock_version: 1, created_by_admin_id: adminId || null,
      created_at: now, updated_at: now,
    }).returning('id'));
    await trx('contract_template_versions').insert({
      template_id: templateId, version_number: 1, status: 'draft', created_at: now, updated_at: now,
    });
    return templateId;
  });
  await audit('contract_template_created', { templateId: id }, adminId);
  return id;
}

/** Copy a template — its draft, else its published version — into a new draft template. */
async function duplicateTemplate(id, payload, adminId) {
  const source = await db('contract_templates').where({ id }).first();
  if (!source) throw notFound();
  const name = sanitizeMeta({ name: payload.name || `${source.name} (2)` }).name;
  const now = new Date();
  const newId = await db.transaction(async (trx) => {
    const from = await trx('contract_template_versions').where({ template_id: id, status: 'draft' }).first()
      || await trx('contract_template_versions').where({ template_id: id, status: 'published' }).first();
    const templateId = insertedId(await trx('contract_templates').insert({
      name, description: source.description, use_case: source.use_case, is_system: false, status: 'draft',
      lock_version: 1, created_by_admin_id: adminId || null, created_at: now, updated_at: now,
    }).returning('id'));
    const versionId = insertedId(await trx('contract_template_versions').insert({
      template_id: templateId, version_number: 1, status: 'draft',
      title: from ? from.title : null, intro_text: from ? from.intro_text : null, outro_text: from ? from.outro_text : null,
      created_at: now, updated_at: now,
    }).returning('id'));
    if (from) {
      await copyItems(trx, from.id, versionId);
      await attachments.copyVersionAttachments(trx, from.id, versionId);
    }
    return templateId;
  });
  await audit('contract_template_duplicated', { templateId: newId, sourceTemplateId: id }, adminId);
  return newId;
}

/** Save the draft: metadata, title/intro/outro and (when sent) the clause list. */
async function saveDraft(id, payload, adminId) {
  const meta = sanitizeMeta(payload);
  const versionUpdates = {};
  if (payload.title !== undefined) {
    versionUpdates.title = payload.title == null ? null : (String(payload.title).trim().slice(0, 255) || null);
  }
  if (payload.introText !== undefined) {
    versionUpdates.intro_text = content.serializeLocaleMap(content.sanitizeLocaleMap(payload.introText, 'Intro'));
  }
  if (payload.outroText !== undefined) {
    versionUpdates.outro_text = content.serializeLocaleMap(content.sanitizeLocaleMap(payload.outroText, 'Closing text'));
  }

  // Which parts of the draft this save actually rewrote. Keys only, never
  // clause text: "who changed what" on a template is answerable from the
  // activity log without putting the contract's wording into it (#1445).
  const changed = [];
  await db.transaction(async (trx) => {
    const template = await claimLock(trx, id, payload.lockVersion);
    assertEditable(template);
    const now = new Date();
    if (Object.keys(meta).length) {
      await trx('contract_templates').where({ id }).update({ ...meta, updated_at: now });
      changed.push(...Object.keys(meta));
    }
    const draft = await ensureDraft(trx, template);
    if (Object.keys(versionUpdates).length) {
      await trx('contract_template_versions').where({ id: draft.id }).update({ ...versionUpdates, updated_at: now });
      changed.push(...Object.keys(versionUpdates));
    }
    if (payload.items !== undefined) {
      const items = await sanitizeItems(payload.items, trx);
      const before = await trx('contract_template_version_items').where({ version_id: draft.id }).count({ n: '*' }).first();
      await trx('contract_template_version_items').where({ version_id: draft.id }).del();
      if (items.length) {
        await trx('contract_template_version_items').insert(items.map((item) => ({
          ...item, version_id: draft.id, created_at: now, updated_at: now,
        })));
      }
      changed.push('items');
      const was = ensureInt(before && before.n);
      if (was !== items.length) changed.push(`items:${was}->${items.length}`);
    }
    if (payload.attachments !== undefined) {
      await attachments.writeVersionAttachments(trx, draft.id, await attachments.sanitizeAttachmentList(payload.attachments, trx));
      changed.push('attachments');
    }
  });
  await audit('contract_template_draft_saved', { templateId: id, changed }, adminId);
  return getTemplate(id);
}

/**
 * Publish the draft. Runs the pre-publication check first (checkTemplate)
 * and refuses on any error — `400 TEMPLATE_INVALID` with every finding in
 * `details.findings` — before the transaction, so a refused publish changes
 * nothing, the draft's lock version included. The check reads the draft as
 * it stands; a save between the check and the publish bumps the lock, and
 * the publish then fails its lock claim instead of going out unchecked.
 * Returns `{ version, contentSha256 }`.
 */
async function publishTemplate(id, { lockVersion }, adminId) {
  const template = await db('contract_templates').where({ id }).first();
  if (!template) throw notFound();
  if (ensureInt(lockVersion) !== ensureInt(template.lock_version)) throw conflict();
  assertEditable(template);
  if (!(await db('contract_template_versions').where({ template_id: id, status: 'draft' }).first())) {
    throw new AppError('There is no draft to publish', 409, 'TEMPLATE_NO_DRAFT');
  }
  const check = await checkTemplate(id);
  if (!check.ok) {
    const errors = check.findings.filter((f) => f.severity === 'error');
    const err = invalid(errors.map((f) => f.message).join(' · '));
    err.details = { findings: check.findings };
    throw err;
  }
  const result = await db.transaction(async (trx) => {
    const template = await claimLock(trx, id, lockVersion);
    assertEditable(template);
    const draft = await trx('contract_template_versions').where({ template_id: id, status: 'draft' }).first();
    if (!draft) throw new AppError('There is no draft to publish', 409, 'TEMPLATE_NO_DRAFT');
    const items = await loadItems(draft.id, trx);
    if (!items.length) throw invalid('Add at least one clause before publishing');
    const versionAttachments = await attachments.loadVersionAttachments(draft.id, trx);

    // Freeze the blocks' bodies and hash the resolved content.
    const now = new Date();
    const resolved = [];
    for (const item of items) {
      const snapshot = item.kind === 'block' ? content.blockBodies(item, 'block_') : {};
      if (item.kind === 'block') {
        await trx('contract_template_version_items').where({ id: item.id })
          .update({ body_snapshot: content.serializeLocaleMap(snapshot), updated_at: now });
      }
      resolved.push({
        position: item.position,
        section: item.section,
        kind: item.kind,
        block: item.kind === 'block' ? item.block_slug : null,
        heading: item.heading || null,
        body: item.kind === 'block'
          ? content.mergeLocaleMaps(snapshot, item.body_override)
          : content.parseLocaleMap(item.body_override),
      });
    }
    const contentSha256 = canonicalSha256({
      title: draft.title || '',
      intro: content.parseLocaleMap(draft.intro_text),
      outro: content.parseLocaleMap(draft.outro_text),
      items: resolved,
      // Attachments are bound to the version by their bytes.
      attachments: versionAttachments.map((a) => ({ position: a.position, delivery: a.delivery, sha256: a.sha256 })),
    });

    await trx('contract_template_versions').where({ template_id: id, status: 'published' })
      .update({ status: 'superseded', updated_at: now });
    await trx('contract_template_versions').where({ id: draft.id }).update({
      status: 'published', content_sha256: contentSha256, published_at: now.toISOString(),
      published_by_admin_id: adminId || null, updated_at: now,
    });
    await trx('contract_templates').where({ id }).update({
      status: 'published', current_version: draft.version_number, updated_at: now,
    });
    return { version: ensureInt(draft.version_number), contentSha256 };
  });
  await audit('contract_template_published', { templateId: id, version: result.version }, adminId);
  return result;
}

/** Replace the draft with a copy of an earlier version, to continue from there. */
async function draftFromVersion(id, versionNumber, { lockVersion }, adminId) {
  await db.transaction(async (trx) => {
    const template = await claimLock(trx, id, lockVersion);
    assertEditable(template);
    const source = await trx('contract_template_versions')
      .where({ template_id: id, version_number: versionNumber })
      .whereNot({ status: 'draft' })
      .first();
    if (!source) throw new AppError('Template version not found', 404, 'TEMPLATE_VERSION_NOT_FOUND');
    // Through the recorder: a version can be referenced by contracts
    // (contracts.template_version_id, ON DELETE SET NULL), and nulling that
    // reference is a change to an audited row.
    await deleteWithAccountingHistory(trx, 'contract_template_versions',
      { template_id: id, status: 'draft' }, { actor: adminId, source: 'contract.template.discard_draft' });
    await ensureDraft(trx, template, source);
  });
  await audit('contract_template_draft_from_version', { templateId: id, version: versionNumber }, adminId);
  return getTemplate(id);
}

async function archiveTemplate(id, adminId) {
  const template = await db('contract_templates').where({ id }).first();
  if (!template) throw notFound();
  if (Number(await getDefaultTemplateId()) === Number(id)) {
    throw new AppError('Make another template the default before archiving this one', 409, 'TEMPLATE_IS_DEFAULT');
  }
  await db('contract_templates').where({ id }).update({ status: 'archived', updated_at: new Date() });
  await audit('contract_template_archived', { templateId: id }, adminId);
  return getTemplate(id);
}

async function restoreTemplate(id, adminId) {
  const template = await db('contract_templates').where({ id }).first();
  if (!template) throw notFound();
  await db('contract_templates').where({ id })
    .update({ status: template.current_version ? 'published' : 'draft', updated_at: new Date() });
  await audit('contract_template_restored', { templateId: id }, adminId);
  return getTemplate(id);
}

/** Make a published template the one new contracts start from. */
async function setDefaultTemplate(id, adminId) {
  const template = await db('contract_templates').where({ id }).first();
  if (!template) throw notFound();
  if (template.status === 'archived' || !template.current_version) {
    throw new AppError('Only a published template can be the default', 409, 'TEMPLATE_NOT_PUBLISHED');
  }
  await upsertAppSetting(DEFAULT_SETTING, JSON.stringify(Number(id)), 'number');
  await audit('contract_template_default_set', { templateId: id }, adminId);
  return getTemplate(id);
}

// ---------------------------------------------------------------------
// Contracts from a version
// ---------------------------------------------------------------------

/** A published version with its clauses, or a 400/409 for anything else. */
async function loadPublishedVersion(versionId) {
  const version = await db('contract_template_versions as v')
    .join('contract_templates as t', 't.id', 'v.template_id')
    .where('v.id', versionId)
    .select('v.*', 't.status as template_status')
    .first();
  if (!version || version.status !== 'published') {
    throw new AppError('Pick a published template version', 400, 'TEMPLATE_VERSION_INVALID');
  }
  if (version.template_status === 'archived') {
    throw new AppError('This template is archived', 409, 'TEMPLATE_ARCHIVED');
  }
  return { ...version, items: await loadItems(version.id) };
}

/**
 * The version a new contract starts from: the one asked for, else the
 * default template's published version. Resolved outside any transaction
 * (it reads through the global db).
 */
async function resolveVersionForNewContract(templateVersionId = null) {
  if (templateVersionId) return loadPublishedVersion(templateVersionId);
  await ensureDefaultTemplate();
  const defaultId = await getDefaultTemplateId();
  let row = defaultId
    ? await db('contract_template_versions as v')
      .join('contract_templates as t', 't.id', 'v.template_id')
      .where({ 'v.template_id': defaultId, 'v.status': 'published' })
      .whereNot('t.status', 'archived')
      .select('v.id')
      .first()
    : null;
  if (!row) {
    // The default was removed or never published: fall back to the standard one.
    row = await db('contract_template_versions as v')
      .join('contract_templates as t', 't.id', 'v.template_id')
      .where({ 't.is_system': true, 'v.status': 'published' })
      .select('v.id')
      .first();
  }
  return row ? loadPublishedVersion(row.id) : null;
}

/**
 * Write a contract's clauses from a version, inside the caller's
 * transaction. Blocks carry the version's frozen bodies (all languages) and
 * override, so the contract says what the published version says even if
 * the library block changes later; free text becomes contract text
 * sections. Positions run 1..n across the whole contract.
 */
async function seedContractFromVersion(trx, contractId, version, history = { source: 'contract.template.seed' }) {
  const now = new Date();
  const inclusions = [];
  const texts = [];
  for (const item of version.items) {
    if (item.kind === 'block') {
      inclusions.push({
        contract_id: contractId,
        block_id: item.block_id,
        section: item.section,
        position: item.position,
        ...content.snapshotColumns(content.parseLocaleMap(item.body_snapshot)),
        body_override: item.body_override || null,
        included: true,
        created_at: now,
        updated_at: now,
      });
    } else {
      texts.push({
        contract_id: contractId,
        section: item.section,
        position: item.position,
        heading: item.heading || null,
        body: item.body_override || null,
        created_at: now,
        updated_at: now,
      });
    }
  }
  if (inclusions.length) await auditedInsert(trx, 'contract_block_inclusions', inclusions, history);
  if (texts.length) await auditedInsert(trx, 'contract_text_sections', texts, history);
  await attachments.seedContractAttachments(trx, contractId, version.id, history);
}

/** The version a preview or a check renders: the one asked for, else the draft, else the published one. */
async function previewVersion(id, versionNumber) {
  const template = await db('contract_templates').where({ id }).first();
  if (!template) throw notFound();
  const version = versionNumber
    ? await db('contract_template_versions').where({ template_id: id, version_number: versionNumber }).first()
    : (await db('contract_template_versions').where({ template_id: id, status: 'draft' }).first()
      || await db('contract_template_versions').where({ template_id: id, status: 'published' }).first());
  if (!version) throw new AppError('Template version not found', 404, 'TEMPLATE_VERSION_NOT_FOUND');
  return { template, version };
}

/**
 * Render a version the way a contract made from it renders: the business
 * profile's letterhead, and sample data (pdf/sampleData) for the customer,
 * the event and a three-line quote — or a real customer when
 * `customer` is given. Every page names what is previewed ("Preview —
 * <template> v<n|draft>"). `skipUnreadable` leaves out a merged attachment
 * whose file can't be read (the check reports it) instead of failing.
 * Returns the PDF, where each clause landed, what the render worked around,
 * the page count and the render context.
 */
async function renderVersion(template, version, { skipUnreadable = false, customer = null } = {}) {
  const items = await loadItems(version.id);
  const businessProfileService = require('../businessProfileService');
  const { profile } = await businessProfileService.getProfile();
  const sample = require('../pdf/sampleData');
  const language = (profile && profile.default_locale) || 'de';
  const quote = sample.sampleContractQuote(language, profile && profile.default_currency);
  const fakeContract = {
    id: null,
    contract_number: 'PREVIEW',
    customer_account_id: customer ? customer.id : null,
    language,
    issue_date: new Date().toISOString().slice(0, 10),
    event_name: sample.sampleText(language).eventName,
    event_date: '2027-06-12',
    title: version.title || template.name,
    intro_text: content.pickLocale(version.intro_text, language) || null,
    outro_text: content.pickLocale(version.outro_text, language) || null,
    template_version_id: version.id,
  };
  const inclusions = items.filter((item) => item.kind === 'block').map((item) => ({
    ...item,
    included: true,
    // Published versions render their frozen bodies, drafts the live ones.
    ...content.snapshotColumns(content.parseLocaleMap(item.body_snapshot)),
  }));
  const textSections = items.filter((item) => item.kind === 'text').map((item) => ({
    section: item.section, position: item.position, heading: item.heading, body: item.body_override,
  }));
  // Merged attachments where a sent contract has them: before the signature page.
  const merged = [];
  for (const row of (await attachments.loadVersionAttachments(version.id)).filter((r) => r.delivery === 'merged')) {
    try {
      merged.push({ buffer: attachments.readStoredFile(row).buffer, pages: Number(row.page_count) || 0 });
    } catch (err) {
      if (!skipUnreadable) throw err;
    }
  }
  const { buildRenderContext } = require('./renderContext');
  const pdfService = require('../pdfService');
  const ctx = await buildRenderContext(fakeContract, inclusions, textSections, {
    customer: customer || sample.SAMPLE_CUSTOMER,
    quote,
    placeholders: { source_quote_number: quote.number },
  });
  ctx.mergedAttachmentPages = merged.reduce((sum, file) => sum + file.pages, 0);
  const { t: pdfT } = require('../pdf-i18n');
  ctx.previewLabel = pdfT(language, 'template_preview_label', {
    name: template.name,
    version: version.status === 'draft' ? pdfT(language, 'template_preview_draft') : `v${ensureInt(version.version_number)}`,
  });
  const rendered = await pdfService.renderContractWithSlots(ctx);
  const own = rendered.slots && rendered.slots.length ? rendered.slots[0].pageIndex + 1 : 0;
  const result = await insertBeforeLastPage(rendered.buffer, merged.map((file) => file.buffer), { title: 'PREVIEW' });
  return {
    buffer: result.buffer,
    itemPages: rendered.itemPages || [],
    findings: rendered.findings || [],
    pageCount: own + ctx.mergedAttachmentPages,
    ctx,
    profile,
  };
}

/**
 * A sample PDF of a template's draft (or a given version), rendered by the
 * real contract pipeline with sample data, or with a real customer when
 * `customerId` is given (the route checks customers.view first).
 */
async function renderTemplatePreview(id, { version: versionNumber, customerId = null } = {}) {
  const { template, version } = await previewVersion(id, versionNumber);
  let customer = null;
  if (customerId) {
    customer = await db('customer_accounts').where({ id: customerId }).first();
    if (!customer) throw new AppError('Customer not found', 404, 'CUSTOMER_NOT_FOUND');
  }
  return (await renderVersion(template, version, { customer })).buffer;
}

// A contract past this many pages is almost always a mistake (a pasted
// document, a clause repeated); worth a word, not a refusal.
const PAGE_COUNT_WARNING = 30;
const LOCALES_CHECKED = ['en', 'de'];

const finding = (code, severity, message, where = {}) => ({ code, severity, ...where, message });

/**
 * The pre-publication check of a template's draft (#1445): every problem
 * with a code, a severity and where it is — `itemPosition` (1-based clause),
 * `locale`, `key`, `field` ('intro' | 'outro'), `attachmentId` — plus a dry
 * run of the real render with the page each clause lands on. Errors block
 * publishing; warnings don't. Reads only; the draft is never touched.
 *
 * Returns `{ ok, pageCount, itemPages, findings }`.
 */
async function checkTemplate(id) {
  const template = await db('contract_templates').where({ id }).first();
  if (!template) throw notFound();
  const draft = await db('contract_template_versions').where({ template_id: id, status: 'draft' }).first();
  if (!draft) throw new AppError('There is no draft to check', 409, 'TEMPLATE_NO_DRAFT');
  const items = await loadItems(draft.id);
  const findings = [];

  if (!items.length) findings.push(finding('NO_CLAUSES', 'error', 'Add at least one clause before publishing'));

  const textChecks = (text, where) => {
    for (const key of unknownPlaceholders(text, CONTRACT_PLACEHOLDERS)) {
      findings.push(finding('PLACEHOLDER_UNKNOWN', 'error', `Unknown placeholder {{${key}}}`, { ...where, key }));
    }
    for (const code of conditionalProblems(text)) {
      findings.push(finding(code, 'error', code === 'CONDITIONAL_NESTED'
        ? 'A "Show only if" block sits inside another one'
        : 'A "Show only if" block is not closed', where));
    }
  };
  for (const [field, value] of [['intro', draft.intro_text], ['outro', draft.outro_text]]) {
    for (const [locale, text] of Object.entries(content.parseLocaleMap(value))) textChecks(text, { field, locale });
  }

  for (const item of items) {
    const itemPosition = ensureInt(item.position);
    const label = item.kind === 'block' ? (item.block_name || `#${itemPosition}`) : (item.heading || `#${itemPosition}`);
    if (item.kind === 'block' && !truthy(item.block_is_active)) {
      findings.push(finding('BLOCK_ARCHIVED', 'error', `"${label}" is archived in the clause library`, { itemPosition }));
    }
    const override = content.parseLocaleMap(item.body_override);
    if (item.kind === 'text' && !Object.keys(override).length) {
      findings.push(finding('SECTION_EMPTY', 'error', `Free-text section "${label}" has no text`, { itemPosition }));
    }
    for (const [locale, text] of Object.entries(override)) textChecks(text, { itemPosition, locale });
    // What the clause says in each language: a block's override over its
    // library text, a section's own text.
    const effective = item.kind === 'block' ? content.mergeLocaleMaps(content.blockBodies(item, 'block_'), override) : override;
    const has = (locale) => typeof effective[locale] === 'string' && effective[locale].trim() !== '';
    const present = LOCALES_CHECKED.filter(has);
    if (present.length === 1) {
      const missing = LOCALES_CHECKED.find((locale) => !has(locale));
      findings.push(finding('LOCALE_INCOMPLETE', 'warning', `"${label}" has no ${missing.toUpperCase()} text`, { itemPosition, locale: missing }));
    }
  }

  for (const row of await attachments.loadVersionAttachments(draft.id)) {
    const where = { attachmentId: row.attachment_id };
    if (!truthy(row.is_active)) {
      findings.push(finding('ATTACHMENT_ARCHIVED', 'error', `"${row.name}" is archived in the attachment library`, where));
    }
    let buffer = null;
    try {
      ({ buffer } = attachments.readStoredFile(row));
    } catch (_) {
      findings.push(finding('ATTACHMENT_MISSING', 'error', `The file of "${row.name}" is missing`, where));
    }
    if (buffer && crypto.createHash('sha256').update(buffer).digest('hex') !== row.sha256) {
      findings.push(finding('ATTACHMENT_CHANGED', 'error', `The file of "${row.name}" no longer matches the one uploaded`, where));
    }
  }

  // The dry run: the real pipeline, in the render worker.
  let pageCount = null;
  let itemPages = [];
  try {
    const rendered = await renderVersion(template, draft, { skipUnreadable: true });
    pageCount = rendered.pageCount;
    itemPages = rendered.itemPages;
    for (const f of rendered.findings) {
      findings.push(finding(f.code, f.severity, f.code === 'FONT_MISSING'
        ? `The font "${f.key}" could not be loaded; the PDF falls back to Helvetica`
        : 'The logo could not be drawn', f.key ? { key: f.key } : {}));
    }
    const issuer = rendered.ctx.issuer || {};
    const { getAppSetting } = require('../../utils/appSettings');
    const logoConfigured = (rendered.profile && rendered.profile.logo_path)
      || await getAppSetting('branding_logo_path', null) || await getAppSetting('branding_logo_url', null);
    if (issuer.showLogo !== false && logoConfigured && !issuer.logoPath && !findings.some((f) => f.code === 'LOGO_MISSING')) {
      findings.push(finding('LOGO_MISSING', 'warning', 'The logo file could not be found; the PDF has no logo'));
    }
    if (pageCount > PAGE_COUNT_WARNING) {
      findings.push(finding('PAGE_COUNT_HIGH', 'warning', `The contract runs to ${pageCount} pages`));
    }
  } catch (err) {
    findings.push(finding('RENDER_FAILED', 'error', 'The contract could not be rendered'));
  }

  return {
    ok: !findings.some((f) => f.severity === 'error'),
    pageCount,
    itemPages,
    findings,
  };
}

module.exports = {
  listTemplates,
  getTemplate,
  getVersion,
  createTemplate,
  duplicateTemplate,
  saveDraft,
  publishTemplate,
  draftFromVersion,
  archiveTemplate,
  restoreTemplate,
  setDefaultTemplate,
  loadPublishedVersion,
  resolveVersionForNewContract,
  seedContractFromVersion,
  renderTemplatePreview,
  checkTemplate,
};
