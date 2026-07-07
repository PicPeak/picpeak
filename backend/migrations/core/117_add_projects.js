/**
 * Migration: Projects — an admin-only grouping layer ABOVE events
 * (Project Overview cockpit, Model A).
 *
 * A project groups one OR MORE events of (usually) one customer; all the
 * money documents (quotes/contracts/invoices) stay attached to their EVENT
 * and the project simply rolls them up. Customers never see projects.
 *
 *   projects            id, name, customer_account_id (nullable), status,
 *                       timestamps.
 *   events.project_id   FK → projects (nullable, SET NULL on project delete).
 *
 * Backfill: every existing event gets its OWN auto-created project (the
 * 1:1 default) so nothing is unassigned; admins then relink freely (group
 * several events under one project, move events between projects). The
 * auto-project's customer = the event's single assigned customer when there
 * is exactly one, else NULL (admin sets it later). Cardinality is 1:N — the
 * per-event auto-project is only the starting point, never a hard rule.
 *
 * Idempotent: table + column guarded; backfill touches only events whose
 * project_id is still NULL, so a re-run is a no-op.
 */

exports.up = async function (knex) {
  // 1. projects table
  if (!(await knex.schema.hasTable('projects'))) {
    await knex.schema.createTable('projects', (table) => {
      table.increments('id').primary();
      table.string('name', 255).notNullable();
      // Nullable: a multi-customer or not-yet-assigned project has no single
      // customer. SET NULL so erasing a customer doesn't delete the project.
      table.integer('customer_account_id').unsigned()
        .references('id').inTable('customer_accounts').onDelete('SET NULL');
      table.string('status', 24).notNullable().defaultTo('active');
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());
      table.index(['customer_account_id']);
    });
  }

  // 2. events.project_id
  if ((await knex.schema.hasTable('events')) && !(await knex.schema.hasColumn('events', 'project_id'))) {
    await knex.schema.alterTable('events', (table) => {
      table.integer('project_id').unsigned()
        .references('id').inTable('projects').onDelete('SET NULL');
      table.index(['project_id']);
    });
  }

  // 3. Backfill one auto-project per still-unassigned event. Wrapped in a
  //    single transaction so a heavy install (10k+ events) can't be left
  //    half-assigned if the loop dies mid-way — it's all-or-nothing, and a
  //    re-run still no-ops (gated on whereNull('project_id')).
  if ((await knex.schema.hasTable('events')) && (await knex.schema.hasColumn('events', 'project_id'))) {
    const hasAssignments = await knex.schema.hasTable('event_customer_assignments');
    await knex.transaction(async (trx) => {
      const events = await trx('events').whereNull('project_id').select('id', 'event_name');
      for (const ev of events) {
        let customerId = null;
        if (hasAssignments) {
          const rows = await trx('event_customer_assignments')
            .where({ event_id: ev.id })
            .select('customer_account_id');
          if (rows.length === 1) customerId = rows[0].customer_account_id;
        }
        const name = (ev.event_name && String(ev.event_name).trim()) || `Event ${ev.id}`;
        const inserted = await trx('projects').insert({
          name,
          customer_account_id: customerId,
          status: 'active',
          created_at: knex.fn.now(),
          updated_at: knex.fn.now(),
        }).returning('id');
        const projectId = (inserted[0] && typeof inserted[0] === 'object') ? inserted[0].id : inserted[0];
        await trx('events').where({ id: ev.id }).update({ project_id: projectId });
      }
    });
  }
};

exports.down = async function (knex) {
  if ((await knex.schema.hasTable('events')) && (await knex.schema.hasColumn('events', 'project_id'))) {
    await knex.schema.alterTable('events', (table) => {
      table.dropColumn('project_id');
    });
  }
  if (await knex.schema.hasTable('projects')) {
    await knex.schema.dropTable('projects');
  }
};
