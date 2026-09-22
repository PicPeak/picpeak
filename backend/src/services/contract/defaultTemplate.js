'use strict';

/**
 * The "Standard contract" template (#1445), seeded at runtime like the
 * system clause blocks (contractBlocksService.ensureSystemBlocksSeeded).
 *
 * Version 1 lists the active system blocks in the order contracts always had
 * them — section order, then each block's display order — so a contract made
 * from it contains exactly what a new contract contained before templates
 * existed. It becomes the default for new contracts unless an admin already
 * picked one. System templates aren't edited in place: an admin duplicates
 * one, customises the copy and makes that the default.
 *
 * Revisions: SYSTEM_TEMPLATE_REVISION is bumped when the built-in wording or
 * block list changes in code. At boot, a system template whose newest
 * version was built from an older revision gets a new published version —
 * never a change to an old one, so contracts made from it keep what they
 * said. Copies are not touched; they show that the system template moved
 * on and let the admin compare and take in clauses (templates.getTemplate).
 * Two replicas booting together race for the same version number; the
 * unique (template_id, version_number) lets one in and the other stands down.
 */

const { db } = require('../../database/db');
const logger = require('../../utils/logger');
const { isUniqueViolation } = require('../../utils/dbErrors');
const { getAppSetting, upsertAppSetting } = require('../../utils/appSettings');
const { ensureInt } = require('../../utils/numericHelpers');
const { canonicalSha256 } = require('../../utils/canonicalJson');
const { ensureSystemBlocksSeeded } = require('../contractBlocksService');
const { SECTIONS_ORDER } = require('./helpers');
const content = require('./content');
const { DEFAULT_CONSENTS } = require('./consents');

const DEFAULT_SETTING = 'crm_contracts_default_template_id';
const SYSTEM_NAME = 'Standard contract';
// 1: the original seed (versions from before migration 245 carry NULL).
const SYSTEM_TEMPLATE_REVISION = 1;

let ensured = false;

const insertedId = (rows) => (typeof rows[0] === 'object' ? rows[0].id : rows[0]);

/** The active system blocks in the order contracts always had them. */
async function systemBlocks(conn = db) {
  const blocks = await conn('contract_blocks').where({ is_system: true, is_active: true }).select('*');
  const rank = (section) => {
    const i = SECTIONS_ORDER.indexOf(section);
    return i === -1 ? SECTIONS_ORDER.length : i;
  };
  return blocks.sort((a, b) => rank(a.section) - rank(b.section)
    || (Number(a.display_order) - Number(b.display_order))
    || (Number(a.id) - Number(b.id)));
}

const contentSha256Of = (blocks) => canonicalSha256({
  title: '',
  intro: {},
  outro: {},
  items: blocks.map((block, index) => ({
    position: index + 1, section: block.section, kind: 'block', block: block.slug, heading: null,
    body: content.blockBodies(block),
  })),
  attachments: [],
  // The declarations a signer confirms (#1446), part of what a version is.
  consents: DEFAULT_CONSENTS,
});

/** Insert a published system version with these blocks (inside `trx`). */
async function insertSystemVersion(trx, templateId, versionNumber, blocks, revision) {
  const now = new Date().toISOString();
  const versionId = insertedId(await trx('contract_template_versions').insert({
    template_id: templateId,
    version_number: versionNumber,
    status: 'published',
    content_sha256: contentSha256Of(blocks),
    published_at: now,
    system_revision: revision,
    consents: JSON.stringify(DEFAULT_CONSENTS),
    created_at: now,
    updated_at: now,
  }).returning('id'));
  if (blocks.length) {
    await trx('contract_template_version_items').insert(blocks.map((block, index) => ({
      version_id: versionId,
      position: index + 1,
      section: block.section,
      kind: 'block',
      block_id: block.id,
      body_snapshot: content.serializeLocaleMap(content.blockBodies(block)),
      created_at: now,
      updated_at: now,
    })));
  }
  return versionId;
}

async function createSystemTemplate(revision = SYSTEM_TEMPLATE_REVISION) {
  const blocks = await systemBlocks();
  const now = new Date().toISOString();
  return db.transaction(async (trx) => {
    const templateId = insertedId(await trx('contract_templates').insert({
      name: SYSTEM_NAME,
      is_system: true,
      status: 'published',
      current_version: 1,
      lock_version: 1,
      created_at: now,
      updated_at: now,
    }).returning('id'));
    await insertSystemVersion(trx, templateId, 1, blocks, revision);
    return templateId;
  });
}

/**
 * Publish a new system version when the newest one was built from an older
 * revision than `revision`. Returns the new version number, or null when
 * there was nothing to do (or another process did it first).
 */
async function publishSystemRevision(system, revision = SYSTEM_TEMPLATE_REVISION) {
  const latest = await db('contract_template_versions').where({ template_id: system.id })
    .orderBy('version_number', 'desc').first();
  const built = latest ? (ensureInt(latest.system_revision) || 1) : 0;
  if (latest && built >= revision) return null;
  const blocks = await systemBlocks();
  const versionNumber = (latest ? ensureInt(latest.version_number) : 0) + 1;
  try {
    await db.transaction(async (trx) => {
      await insertSystemVersion(trx, system.id, versionNumber, blocks, revision);
      await trx('contract_template_versions')
        .where({ template_id: system.id, status: 'published' })
        .whereNot({ version_number: versionNumber })
        .update({ status: 'superseded', updated_at: new Date().toISOString() });
      // The new version becomes current; an archived template stays archived.
      await trx('contract_templates').where({ id: system.id })
        .update({ current_version: versionNumber, updated_at: new Date().toISOString() });
    });
  } catch (err) {
    // Another replica published this version first.
    if (isUniqueViolation(err)) return null;
    throw err;
  }
  logger.info('Published a new revision of the standard contract template', { version: versionNumber, revision });
  return versionNumber;
}

/** Seed the standard template once per process and make sure a default is set. */
async function ensureDefaultTemplate() {
  if (ensured) return;
  if (!(await db.schema.hasTable('contract_templates'))) return;
  await ensureSystemBlocksSeeded();

  let system = await db('contract_templates').where({ is_system: true }).first();
  if (!system) {
    try {
      await createSystemTemplate();
      logger.info('Seeded the standard contract template');
    } catch (err) {
      // Another process seeded it first; the unique index let one through.
      if (!isUniqueViolation(err)) throw err;
    }
    system = await db('contract_templates').where({ is_system: true }).first();
  }
  if (system && (await db.schema.hasColumn('contract_template_versions', 'system_revision'))) {
    await publishSystemRevision(system);
  }
  if (system && !ensureInt(await getAppSetting(DEFAULT_SETTING))) {
    await upsertAppSetting(DEFAULT_SETTING, JSON.stringify(system.id), 'number');
  }
  ensured = true;
}

/** A restore replaced the database: check the standard template again on next use. */
function forgetEnsured() {
  ensured = false;
}

async function getDefaultTemplateId() {
  return ensureInt(await getAppSetting(DEFAULT_SETTING)) || null;
}

module.exports = {
  forgetEnsured,
  DEFAULT_SETTING,
  SYSTEM_NAME,
  SYSTEM_TEMPLATE_REVISION,
  publishSystemRevision,
  ensureDefaultTemplate,
  getDefaultTemplateId,
};
