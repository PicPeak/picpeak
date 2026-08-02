/**
 * Migration 167: give `projects` a first-class owner (GHSA-wrg5).
 *
 * Project routes authorize on generic `events.view` / `events.edit` only, with
 * no ownership check, so an editor-like admin could enumerate, read, update
 * and aggregate projects belonging to other admins' events.
 *
 * Ownership IS derivable transitively — `events.project_id` (migration 117)
 * plus `events.created_by` (migration 060) — but only for projects that have
 * at least one linked event. A freshly created, still-empty project has no
 * derivable owner, which would leave a hole exactly where the create → attach
 * flow starts. Storing the creator removes that ambiguity: projectService
 * already receives `adminId` in createProject() and simply discarded it.
 *
 * Backfill uses the transitive path, which is well-defined here: migration 117
 * created exactly one auto-project per pre-existing event, so those projects
 * map 1:1 to an owning event. Projects with no linked event (or whose events
 * are themselves ownerless legacy rows) stay NULL and are treated as
 * unowned//legacy by the ownership helper — same convention the events table
 * already uses for `created_by IS NULL`.
 *
 * down() drops the column; the derived data is reconstructible by re-running
 * the same backfill, so nothing is lost irreversibly.
 */

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('projects'))) return;

  if (!(await knex.schema.hasColumn('projects', 'created_by'))) {
    await knex.schema.alterTable('projects', (t) => {
      // No FK constraint: admin_users rows can be removed, and orphaning a
      // project would be worse than a dangling id (which reads as unowned).
      t.integer('created_by').nullable();
    });
  }

  // Backfill from the linked events, only where we can determine it
  // unambiguously (every owning event agrees on a single non-null creator).
  if (await knex.schema.hasColumn('events', 'project_id')
    && await knex.schema.hasColumn('events', 'created_by')) {
    const rows = await knex('events')
      .whereNotNull('project_id')
      .whereNotNull('created_by')
      .select('project_id', 'created_by')
      .groupBy('project_id', 'created_by');

    const byProject = new Map();
    for (const row of rows) {
      const list = byProject.get(row.project_id) || [];
      list.push(row.created_by);
      byProject.set(row.project_id, list);
    }

    for (const [projectId, creators] of byProject) {
      // Ambiguous (events from two different admins) → leave NULL rather than
      // guess an owner and hand one admin authority over another's work.
      if (creators.length !== 1) continue;
      await knex('projects')
        .where({ id: projectId })
        .whereNull('created_by')
        .update({ created_by: creators[0] });
    }
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('projects'))) return;
  if (await knex.schema.hasColumn('projects', 'created_by')) {
    await knex.schema.alterTable('projects', (t) => t.dropColumn('created_by'));
  }
};
