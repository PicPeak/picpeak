/**
 * Migration 142: Workflow / automation engine schema + permissions.
 *
 * An admin-configurable visual flow engine (trigger → conditions → ordered
 * steps with branching, loops, waits and approval gates). Strictly opt-in via
 * the `workflows` feature flag (default off; no run is created/resumed while
 * off). See docs / project_workflow_engine_requirements.
 *
 * Graph model (canvas, not a list):
 *   - workflows         : one row per flow (name, enabled, current `version`,
 *                         trigger_type + trigger_config). Built-ins (e.g. the
 *                         dunning ladder) carry is_builtin + builtin_key.
 *   - workflow_nodes    : nodes of a flow VERSION (node_key, type, config, x/y).
 *   - workflow_edges    : edges of a flow VERSION (from_node[+handle] → to_node).
 *   Versioned so in-flight runs keep executing the version they started on
 *   (editing bumps workflows.version and writes a fresh node/edge set).
 *   - workflow_runs     : one execution (pinned version, entity, status,
 *                         current_node, context JSON, wake_at for delays,
 *                         dedup_key to prevent double-fire on re-tick).
 *   - workflow_run_steps: per-node audit trail (observability + System Health).
 *   - workflow_approvals: human gates — token_hash for the email confirm/deny
 *                         link (hashed at rest) + the webview inbox.
 *
 * Loose-FK integers (no DB-level FK) by design, matching whatsapp_queue /
 * inbound_documents / expenses — the service cascades child deletes in a
 * transaction. Idempotent: every createTable is hasTable-guarded; the
 * permission seed mirrors migration 123.
 */
const NEW_PERMISSIONS = [
  {
    name: 'workflows.view',
    display_name: 'View Workflows',
    category: 'workflows',
    description: 'View automation workflows, their runs and pending approvals',
  },
  {
    name: 'workflows.manage',
    display_name: 'Manage Workflows',
    category: 'workflows',
    description: 'Create, edit, enable/disable workflows and act on approval gates',
  },
];

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('workflows'))) {
    await knex.schema.createTable('workflows', (table) => {
      table.increments('id').primary();
      table.string('name', 255).notNullable();
      table.text('description');
      table.boolean('enabled').notNullable().defaultTo(false);
      // Current/latest graph version. Editing bumps this; runs pin the value
      // they started on so an edit never rewrites a flow mid-run.
      table.integer('version').notNullable().defaultTo(1);
      table.string('trigger_type', 64).notNullable();
      table.json('trigger_config');
      // Seeded built-ins (e.g. the converted reminder ladder) are flagged so a
      // boot self-heal can find/upsert them by a stable key.
      table.boolean('is_builtin').notNullable().defaultTo(false);
      table.string('builtin_key', 64);
      table.integer('created_by').unsigned();
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());
      table.index(['enabled', 'trigger_type'], 'workflows_trigger_index');
      table.index(['builtin_key']);
    });
  }

  if (!(await knex.schema.hasTable('workflow_nodes'))) {
    await knex.schema.createTable('workflow_nodes', (table) => {
      table.increments('id').primary();
      table.integer('workflow_id').unsigned().notNullable();
      table.integer('version').notNullable().defaultTo(1);
      // Stable id within the graph (edges + runs.current_node reference it).
      table.string('node_key', 64).notNullable();
      // trigger | condition | branch | loop | wait | action | gate | webhook
      table.string('type', 32).notNullable();
      table.json('config');
      table.integer('pos_x').notNullable().defaultTo(0);
      table.integer('pos_y').notNullable().defaultTo(0);
      table.unique(['workflow_id', 'version', 'node_key'], 'workflow_nodes_key_unique');
      table.index(['workflow_id', 'version'], 'workflow_nodes_graph_index');
    });
  }

  if (!(await knex.schema.hasTable('workflow_edges'))) {
    await knex.schema.createTable('workflow_edges', (table) => {
      table.increments('id').primary();
      table.integer('workflow_id').unsigned().notNullable();
      table.integer('version').notNullable().defaultTo(1);
      table.string('from_node', 64).notNullable();
      // Output handle for multi-path nodes (yes/no, confirm/deny, ≥max/continue).
      table.string('from_handle', 32);
      table.string('to_node', 64).notNullable();
      table.string('label', 64);
      // True for the loop-back edge so the canvas can render it distinctly.
      table.boolean('loop_back').notNullable().defaultTo(false);
      table.index(['workflow_id', 'version'], 'workflow_edges_graph_index');
    });
  }

  if (!(await knex.schema.hasTable('workflow_runs'))) {
    await knex.schema.createTable('workflow_runs', (table) => {
      table.increments('id').primary();
      table.integer('workflow_id').unsigned().notNullable();
      // Pinned graph version this run executes.
      table.integer('version').notNullable();
      table.string('trigger_event', 64).notNullable();
      table.string('entity_type', 64);
      table.integer('entity_id').unsigned();
      // pending | running | waiting | done | failed | cancelled
      table.string('status', 20).notNullable().defaultTo('pending');
      table.string('current_node', 64);
      table.json('context');
      // Idempotency: prevents a re-emitted/re-ticked trigger from double-firing.
      table.string('dedup_key', 191).unique();
      // When a waiting run (delay or gate timeout) should be resumed by the
      // scheduler. NULL while running/done.
      table.timestamp('wake_at');
      table.timestamp('started_at').defaultTo(knex.fn.now());
      table.timestamp('finished_at');
      table.text('error');
      // Scheduler poll path: waiting runs whose wake_at has passed.
      table.index(['status', 'wake_at'], 'workflow_runs_wake_index');
      table.index(['entity_type', 'entity_id'], 'workflow_runs_entity_index');
      table.index(['workflow_id']);
    });
  }

  if (!(await knex.schema.hasTable('workflow_run_steps'))) {
    await knex.schema.createTable('workflow_run_steps', (table) => {
      table.increments('id').primary();
      table.integer('run_id').unsigned().notNullable();
      table.string('node_key', 64).notNullable();
      table.string('node_type', 32);
      // done | failed | skipped | waiting
      table.string('status', 20).notNullable().defaultTo('pending');
      table.json('result');
      table.text('error');
      table.timestamp('started_at').defaultTo(knex.fn.now());
      table.timestamp('finished_at');
      table.index(['run_id'], 'workflow_run_steps_run_index');
    });
  }

  if (!(await knex.schema.hasTable('workflow_approvals'))) {
    await knex.schema.createTable('workflow_approvals', (table) => {
      table.increments('id').primary();
      table.integer('run_id').unsigned().notNullable();
      table.string('node_key', 64).notNullable();
      table.string('type', 32).notNullable().defaultTo('payment_confirm');
      // pending | confirmed | denied | expired
      table.string('status', 20).notNullable().defaultTo('pending');
      // SHA-256 hex of the single-use email confirm/deny token (hash-on-store).
      table.string('token_hash', 128).notNullable();
      table.json('payload');
      table.timestamp('expires_at');
      table.integer('acted_by').unsigned();
      table.string('acted_via', 16);
      table.timestamp('acted_at');
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.unique(['token_hash'], 'workflow_approvals_token_unique');
      table.index(['status'], 'workflow_approvals_status_index');
      table.index(['run_id']);
    });
  }

  // --- Permissions (idempotent, mirrors migration 123) ---
  if (await knex.schema.hasTable('permissions')) {
    const names = NEW_PERMISSIONS.map((p) => p.name);
    const existing = await knex('permissions').whereIn('name', names).select('name');
    const existingSet = new Set(existing.map((r) => r.name));
    const toInsert = NEW_PERMISSIONS.filter((p) => !existingSet.has(p.name));
    if (toInsert.length > 0) await knex('permissions').insert(toInsert);

    if ((await knex.schema.hasTable('roles')) && (await knex.schema.hasTable('role_permissions'))) {
      const roles = await knex('roles').whereIn('name', ['super_admin', 'admin']).select('id');
      const perms = await knex('permissions').whereIn('name', names).select('id');
      if (roles.length && perms.length) {
        const existingGrants = await knex('role_permissions')
          .whereIn('role_id', roles.map((r) => r.id))
          .whereIn('permission_id', perms.map((p) => p.id))
          .select('role_id', 'permission_id');
        const grantSet = new Set(existingGrants.map((g) => `${g.role_id}:${g.permission_id}`));
        const toGrant = [];
        for (const r of roles) {
          for (const p of perms) {
            if (!grantSet.has(`${r.id}:${p.id}`)) {
              toGrant.push({ role_id: r.id, permission_id: p.id });
            }
          }
        }
        if (toGrant.length > 0) await knex('role_permissions').insert(toGrant);
      }
    }
  }
};

exports.down = async function (knex) {
  if (await knex.schema.hasTable('permissions')) {
    const names = NEW_PERMISSIONS.map((p) => p.name);
    const perms = await knex('permissions').whereIn('name', names).select('id');
    if (perms.length && (await knex.schema.hasTable('role_permissions'))) {
      await knex('role_permissions').whereIn('permission_id', perms.map((p) => p.id)).del();
    }
    await knex('permissions').whereIn('name', names).del();
  }
  await knex.schema.dropTableIfExists('workflow_approvals');
  await knex.schema.dropTableIfExists('workflow_run_steps');
  await knex.schema.dropTableIfExists('workflow_runs');
  await knex.schema.dropTableIfExists('workflow_edges');
  await knex.schema.dropTableIfExists('workflow_nodes');
  await knex.schema.dropTableIfExists('workflows');
};
