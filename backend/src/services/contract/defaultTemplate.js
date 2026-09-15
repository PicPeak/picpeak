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

const DEFAULT_SETTING = 'crm_contracts_default_template_id';
const SYSTEM_NAME = 'Standard contract';

let ensured = false;

const insertedId = (rows) => (typeof rows[0] === 'object' ? rows[0].id : rows[0]);

async function createSystemTemplate() {
  const blocks = await db('contract_blocks').where({ is_system: true, is_active: true }).select('*');
  const rank = (section) => {
    const i = SECTIONS_ORDER.indexOf(section);
    return i === -1 ? SECTIONS_ORDER.length : i;
  };
  blocks.sort((a, b) => rank(a.section) - rank(b.section)
    || (Number(a.display_order) - Number(b.display_order))
    || (Number(a.id) - Number(b.id)));

  const now = new Date();
  const contentSha256 = canonicalSha256({
    title: '',
    intro: {},
    outro: {},
    items: blocks.map((block, index) => ({
      position: index + 1, section: block.section, kind: 'block', block: block.slug, heading: null,
      body: content.blockBodies(block),
    })),
    attachments: [],
  });

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
    const versionId = insertedId(await trx('contract_template_versions').insert({
      template_id: templateId,
      version_number: 1,
      status: 'published',
      content_sha256: contentSha256,
      published_at: now,
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
    return templateId;
  });
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
  if (system && !ensureInt(await getAppSetting(DEFAULT_SETTING))) {
    await upsertAppSetting(DEFAULT_SETTING, JSON.stringify(system.id), 'number');
  }
  ensured = true;
}

async function getDefaultTemplateId() {
  return ensureInt(await getAppSetting(DEFAULT_SETTING)) || null;
}

module.exports = {
  DEFAULT_SETTING,
  SYSTEM_NAME,
  ensureDefaultTemplate,
  getDefaultTemplateId,
};
