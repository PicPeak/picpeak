'use strict';

/**
 * Migration 217 — contract templates (#1445).
 *
 * contract_templates            a named template (name, description, use case,
 *                               system flag, status, optimistic lock).
 * contract_template_versions    its versions: one editable `draft` at most,
 *                               immutable `published` ones, earlier published
 *                               ones `superseded`. Title, intro and outro live
 *                               on the version; `content_sha256` is set when
 *                               it's published.
 * contract_template_version_items  the ordered clauses of a version: a library
 *                               block (FK RESTRICT — a block used by a version
 *                               is archived, never deleted) with an optional
 *                               per-template override, or a free-text section.
 *                               Texts are JSON locale maps; `body_snapshot`
 *                               freezes the block's bodies at publish.
 * contract_text_sections        free-text sections on a contract (the
 *                               inclusion table's block_id stays NOT NULL).
 *
 * contracts gain the template and version they came from (NULL = a contract
 * from before templates, rendered as before), the frozen content they were
 * sent with plus its sha256, and an optimistic lock. Inclusions gain a
 * per-contract override and snapshots for ru/pt/nl/fr (only EN and DE were
 * frozen at send).
 *
 * Permission `contracts.templates.manage`, granted to super_admin and admin.
 * The default "Standard contract" template is seeded at runtime
 * (services/contract/defaultTemplate.js), like the system blocks.
 */

const NEW_PERMISSIONS = [
  {
    name: 'contracts.templates.manage',
    display_name: 'Manage Contract Templates',
    category: 'contracts',
    description: 'Create, edit, publish and archive contract templates.',
  },
];

async function addColumn(knex, table, column, build) {
  if (!(await knex.schema.hasTable(table))) return;
  if (await knex.schema.hasColumn(table, column)) return;
  await knex.schema.alterTable(table, build);
}

async function dropColumn(knex, table, column) {
  if (!(await knex.schema.hasTable(table))) return;
  if (!(await knex.schema.hasColumn(table, column))) return;
  await knex.schema.alterTable(table, (t) => t.dropColumn(column));
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('contract_templates'))) {
    await knex.schema.createTable('contract_templates', (t) => {
      t.increments('id').primary();
      t.string('name', 128).notNullable();
      t.text('description');
      t.string('use_case', 64);
      t.boolean('is_system').notNullable().defaultTo(false);
      t.string('status', 16).notNullable().defaultTo('draft'); // draft | published | archived
      t.integer('current_version'); // the published version new contracts use
      t.integer('lock_version').notNullable().defaultTo(1);
      t.integer('created_by_admin_id');
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('updated_at').defaultTo(knex.fn.now());
      t.index(['status']);
    });
    // One system template ("Standard contract").
    await knex.raw('CREATE UNIQUE INDEX contract_templates_one_system ON contract_templates (is_system) WHERE is_system');
  }

  if (!(await knex.schema.hasTable('contract_template_versions'))) {
    await knex.schema.createTable('contract_template_versions', (t) => {
      t.increments('id').primary();
      t.integer('template_id').unsigned().notNullable()
        .references('id').inTable('contract_templates').onDelete('CASCADE');
      t.integer('version_number').notNullable();
      t.string('status', 16).notNullable().defaultTo('draft'); // draft | published | superseded
      t.string('title', 255);
      t.text('intro_text'); // JSON locale map
      t.text('outro_text'); // JSON locale map
      t.string('content_sha256', 64);
      t.timestamp('published_at');
      t.integer('published_by_admin_id');
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('updated_at').defaultTo(knex.fn.now());
      t.unique(['template_id', 'version_number']);
    });
    // At most one draft per template.
    await knex.raw(
      'CREATE UNIQUE INDEX contract_template_versions_one_draft ON contract_template_versions (template_id) WHERE status = \'draft\''
    );
  }

  if (!(await knex.schema.hasTable('contract_template_version_items'))) {
    await knex.schema.createTable('contract_template_version_items', (t) => {
      t.increments('id').primary();
      t.integer('version_id').unsigned().notNullable()
        .references('id').inTable('contract_template_versions').onDelete('CASCADE');
      t.integer('position').notNullable();
      t.string('section', 32).notNullable();
      t.string('kind', 8).notNullable(); // block | text
      t.integer('block_id').unsigned()
        .references('id').inTable('contract_blocks').onDelete('RESTRICT');
      t.string('heading', 255); // free-text sections
      t.text('body_override'); // JSON locale map: a block override, or a free-text body
      t.text('body_snapshot'); // JSON locale map: the block's bodies at publish
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('updated_at').defaultTo(knex.fn.now());
      t.index(['version_id']);
      t.index(['block_id']);
    });
  }

  if (!(await knex.schema.hasTable('contract_text_sections'))) {
    await knex.schema.createTable('contract_text_sections', (t) => {
      t.increments('id').primary();
      t.integer('contract_id').unsigned().notNullable()
        .references('id').inTable('contracts').onDelete('CASCADE');
      t.string('section', 32).notNullable();
      t.integer('position').notNullable();
      t.string('heading', 255);
      t.text('body'); // JSON locale map
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('updated_at').defaultTo(knex.fn.now());
      t.index(['contract_id']);
    });
  }

  await addColumn(knex, 'contracts', 'template_id', (t) => t.integer('template_id').unsigned()
    .references('id').inTable('contract_templates').onDelete('SET NULL'));
  await addColumn(knex, 'contracts', 'template_version_id', (t) => t.integer('template_version_id').unsigned()
    .references('id').inTable('contract_template_versions').onDelete('SET NULL'));
  await addColumn(knex, 'contracts', 'rendered_content', (t) => t.text('rendered_content'));
  await addColumn(knex, 'contracts', 'rendered_content_sha256', (t) => t.string('rendered_content_sha256', 64));
  await addColumn(knex, 'contracts', 'lock_version', (t) => t.integer('lock_version').notNullable().defaultTo(1));

  await addColumn(knex, 'contract_block_inclusions', 'body_override', (t) => t.text('body_override'));
  for (const locale of ['ru', 'pt', 'nl', 'fr']) {
    const column = `body_text_${locale}_snapshot`;
    // eslint-disable-next-line no-await-in-loop
    await addColumn(knex, 'contract_block_inclusions', column, (t) => t.text(column));
  }

  // ---- permission -------------------------------------------------------
  const hasPermissions = await knex.schema.hasTable('permissions');
  const hasRoles = await knex.schema.hasTable('roles');
  const hasRolePermissions = await knex.schema.hasTable('role_permissions');
  if (!hasPermissions || !hasRoles || !hasRolePermissions) return;

  const existing = await knex('permissions')
    .whereIn('name', NEW_PERMISSIONS.map((p) => p.name))
    .select('name');
  const have = new Set(existing.map((r) => r.name));
  const toInsert = NEW_PERMISSIONS.filter((p) => !have.has(p.name));
  if (toInsert.length > 0) {
    await knex('permissions').insert(toInsert);
  }

  const permIds = (await knex('permissions')
    .whereIn('name', NEW_PERMISSIONS.map((p) => p.name))
    .select('id')).map((p) => p.id);
  if (permIds.length === 0) return;

  // super_admin tracks everything; admin already manages contracts and
  // their clause library, so templates are theirs too. Other roles,
  // including the frozen presets, start without it.
  for (const roleName of ['super_admin', 'admin']) {
    // eslint-disable-next-line no-await-in-loop
    const role = await knex('roles').where({ name: roleName }).first();
    if (!role) continue;
    // eslint-disable-next-line no-await-in-loop
    const granted = await knex('role_permissions')
      .where({ role_id: role.id })
      .whereIn('permission_id', permIds)
      .select('permission_id');
    const has = new Set(granted.map((r) => r.permission_id));
    const inserts = permIds
      .filter((id) => !has.has(id))
      .map((id) => ({ role_id: role.id, permission_id: id }));
    if (inserts.length > 0) {
      // eslint-disable-next-line no-await-in-loop
      await knex('role_permissions').insert(inserts);
    }
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('permissions')) {
    const perms = await knex('permissions')
      .whereIn('name', NEW_PERMISSIONS.map((p) => p.name))
      .select('id');
    const ids = perms.map((p) => p.id);
    if (ids.length > 0) {
      if (await knex.schema.hasTable('role_permissions')) {
        await knex('role_permissions').whereIn('permission_id', ids).del();
      }
      await knex('permissions').whereIn('id', ids).del();
    }
  }

  for (const locale of ['fr', 'nl', 'pt', 'ru']) {
    // eslint-disable-next-line no-await-in-loop
    await dropColumn(knex, 'contract_block_inclusions', `body_text_${locale}_snapshot`);
  }
  await dropColumn(knex, 'contract_block_inclusions', 'body_override');
  for (const column of ['lock_version', 'rendered_content_sha256', 'rendered_content', 'template_version_id', 'template_id']) {
    // eslint-disable-next-line no-await-in-loop
    await dropColumn(knex, 'contracts', column);
  }

  await knex.schema.dropTableIfExists('contract_text_sections');
  await knex.schema.dropTableIfExists('contract_template_version_items');
  await knex.schema.dropTableIfExists('contract_template_versions');
  await knex.schema.dropTableIfExists('contract_templates');
};
