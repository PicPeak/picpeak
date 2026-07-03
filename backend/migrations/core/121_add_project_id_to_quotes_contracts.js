/**
 * Migration: link quotes + contracts to a project.
 *
 * Quotes and contracts carry no event_id (see migration 107), so the Project
 * Overview cockpit originally rolled them up by the project's customer — which
 * is imprecise once a customer has more than one project. This adds an explicit
 * `project_id` FK to both tables so the rollup is exact, and the quote/contract
 * editors get a project picker.
 *
 *   quotes.project_id     FK → projects (nullable, SET NULL on project delete).
 *   contracts.project_id  FK → projects (nullable, SET NULL on project delete).
 *
 * Backfill: only the unambiguous case. For every customer that owns EXACTLY ONE
 * project, link that customer's still-unassigned quotes/contracts to it. Customers
 * with several projects stay unassigned — the admin links them via the picker
 * (we can't guess which project a document belongs to).
 *
 * Idempotent: columns guarded; backfill touches only NULL project_id rows.
 */

exports.up = async function (knex) {
  for (const tbl of ['quotes', 'contracts']) {
    if ((await knex.schema.hasTable(tbl)) && !(await knex.schema.hasColumn(tbl, 'project_id'))) {
      await knex.schema.alterTable(tbl, (table) => {
        table.integer('project_id').unsigned()
          .references('id').inTable('projects').onDelete('SET NULL');
        table.index(['project_id']);
      });
    }
  }

  if (!(await knex.schema.hasTable('projects'))) return;

  // Customers that own exactly one project → the unambiguous backfill target.
  const projects = await knex('projects').whereNotNull('customer_account_id').select('id', 'customer_account_id');
  const byCustomer = new Map();
  for (const p of projects) {
    const list = byCustomer.get(p.customer_account_id) || [];
    list.push(p.id);
    byCustomer.set(p.customer_account_id, list);
  }

  for (const [customerId, projectIds] of byCustomer.entries()) {
    if (projectIds.length !== 1) continue;
    const projectId = projectIds[0];
    for (const tbl of ['quotes', 'contracts']) {
      if (!(await knex.schema.hasTable(tbl))) continue;
      if (!(await knex.schema.hasColumn(tbl, 'customer_account_id'))) continue;
      await knex(tbl)
        .where({ customer_account_id: customerId })
        .whereNull('project_id')
        .update({ project_id: projectId });
    }
  }
};

exports.down = async function (knex) {
  for (const tbl of ['quotes', 'contracts']) {
    if ((await knex.schema.hasTable(tbl)) && (await knex.schema.hasColumn(tbl, 'project_id'))) {
      await knex.schema.alterTable(tbl, (table) => {
        table.dropColumn('project_id');
      });
    }
  }
};
