/**
 * Migration: gallery admin cleanup
 *
 * Permissions — split WHAT a role may do from WHICH galleries it may do it on:
 *
 *   events.support     Help the client: send / resend the gallery email, show
 *                      and reset the gallery password, extend expiry, reset the
 *                      download limit, moderate feedback and manage guests.
 *                      Those routes accepted only `events.edit` until now; they
 *                      now accept either, and every role holding `events.edit`
 *                      is granted `events.support` here, so no role loses or
 *                      gains a capability on upgrade.
 *   events.view_all    List and read every gallery, not just the role's own and
 *                      ownerless ones. Replaces the hard-coded "role named admin
 *                      sees all" rule in middleware/ownership.js, so it is
 *                      granted to the role named `admin` and nothing else —
 *                      exactly today's behaviour, now editable in the role editor.
 *   events.manage_all  Act on every gallery with whatever event and photo
 *                      permissions the role holds. Granted to nobody here
 *                      (super_admin bypasses ownership already); the new
 *                      customer_support preset holds it.
 *
 * And a `customer_support` preset role, created only when no role of that name
 * exists. Never overwrites a role an operator already made.
 *
 * Theme — `events.custom_theme_enabled` (boolean, default false). Off, the
 * gallery renders the global Branding theme (services/galleryTheme.js); on, its
 * own color_theme / css_template_id. Backfilled so no gallery changes its look:
 * on for every gallery with a CSS template, a preset name, a theme that
 * differs from the current Branding theme, or a header / hero divider style
 * of its own (the gallery renders events.header_style ahead of the theme). Off only for galleries without a
 * theme and for exact copies of Branding (what the create form used to save),
 * which look the same and now follow later Branding changes.
 *
 * Idempotent throughout.
 */

const { formatBoolean } = require('../../src/utils/dbCompat');

const NEW_PERMISSIONS = [
  { name: 'events.support', display_name: 'Help Gallery Clients', category: 'events', description: 'Send and resend the gallery email, show and reset the gallery password, extend expiry, reset the download limit, moderate feedback and manage guests.' },
  { name: 'events.view_all', display_name: 'See All Galleries', category: 'events', description: 'List and read every gallery, not only the ones this user created. Gallery links of other users’ galleries stay hidden unless the role may also manage all galleries.' },
  { name: 'events.manage_all', display_name: 'Manage All Galleries', category: 'events', description: 'Act on every gallery with the gallery and photo permissions this role holds, not only the ones this user created.' },
];

const CUSTOMER_SUPPORT = {
  name: 'customer_support',
  display_name: 'Customer Support',
  description: 'Helps gallery clients across every gallery: resend the gallery email, reset the password, extend expiry, reset download limits, moderate feedback and manage guests. Cannot change gallery settings or photos. A preset starting point.',
  is_system: true,
  priority: 45,
  permissions: [
    'events.view', 'events.view_all', 'events.manage_all', 'events.support',
    'photos.view', 'photos.download',
  ],
};

async function grantPerms(knex, roleId, permIds) {
  if (!roleId || permIds.length === 0) return;
  const existing = await knex('role_permissions')
    .where({ role_id: roleId })
    .whereIn('permission_id', permIds)
    .select('permission_id');
  const have = new Set(existing.map((r) => r.permission_id));
  const inserts = permIds
    .filter((id) => !have.has(id))
    .map((id) => ({ role_id: roleId, permission_id: id }));
  for (let i = 0; i < inserts.length; i += 50) {
    await knex('role_permissions').insert(inserts.slice(i, i + 50));
  }
}

async function permissionIds(knex, names) {
  const rows = await knex('permissions').whereIn('name', names).select('id');
  return rows.map((r) => r.id);
}

async function upPermissions(knex) {
  const hasPermissions = await knex.schema.hasTable('permissions');
  const hasRolePermissions = await knex.schema.hasTable('role_permissions');
  const hasRoles = await knex.schema.hasTable('roles');
  if (!hasPermissions || !hasRolePermissions || !hasRoles) {
    console.log('259: RBAC tables missing, skipping permission seed');
    return;
  }

  const existing = await knex('permissions')
    .whereIn('name', NEW_PERMISSIONS.map((p) => p.name))
    .select('name');
  const existingSet = new Set(existing.map((r) => r.name));
  const toInsert = NEW_PERMISSIONS.filter((p) => !existingSet.has(p.name));
  if (toInsert.length > 0) await knex('permissions').insert(toInsert);

  // events.support takes over routes that needed events.edit: project it onto
  // every role holding events.edit, custom roles included.
  const editPerm = await knex('permissions').where({ name: 'events.edit' }).first();
  const [supportId] = await permissionIds(knex, ['events.support']);
  if (editPerm && supportId) {
    const holders = await knex('role_permissions').where({ permission_id: editPerm.id }).select('role_id');
    for (const { role_id } of holders) await grantPerms(knex, role_id, [supportId]);
  }

  // events.view_all replaces the hard-coded `admin` role rule.
  const adminRole = await knex('roles').where({ name: 'admin' }).first();
  if (adminRole) await grantPerms(knex, adminRole.id, await permissionIds(knex, ['events.view_all']));

  const superAdmin = await knex('roles').where({ name: 'super_admin' }).first();
  if (superAdmin) await grantPerms(knex, superAdmin.id, await permissionIds(knex, NEW_PERMISSIONS.map((p) => p.name)));

  if (!(await knex('roles').where({ name: CUSTOMER_SUPPORT.name }).first())) {
    await knex('roles').insert({
      name: CUSTOMER_SUPPORT.name,
      display_name: CUSTOMER_SUPPORT.display_name,
      description: CUSTOMER_SUPPORT.description,
      is_system: formatBoolean(CUSTOMER_SUPPORT.is_system),
      priority: CUSTOMER_SUPPORT.priority,
      created_at: knex.fn.now(),
      updated_at: knex.fn.now(),
    });
    const role = await knex('roles').where({ name: CUSTOMER_SUPPORT.name }).first();
    await grantPerms(knex, role.id, await permissionIds(knex, CUSTOMER_SUPPORT.permissions));
  }
}

async function downPermissions(knex) {
  for (const table of ['permissions', 'roles', 'role_permissions', 'admin_users']) {
    if (!(await knex.schema.hasTable(table))) return;
  }
  const role = await knex('roles').where({ name: CUSTOMER_SUPPORT.name }).first();
  if (role) {
    const assigned = await knex('admin_users').where({ role_id: role.id }).first();
    if (!assigned) {
      await knex('role_permissions').where({ role_id: role.id }).del();
      await knex('roles').where({ id: role.id }).del();
    }
  }
  const ids = await permissionIds(knex, NEW_PERMISSIONS.map((p) => p.name));
  if (ids.length > 0) {
    await knex('role_permissions').whereIn('permission_id', ids).del();
    await knex('permissions').whereIn('id', ids).del();
  }
}

// Keys a stored theme copy may carry that are not part of the look.
const THEME_COMPARE_IGNORED = new Set(['logoUrl', 'name']);

function canonicalTheme(value) {
  if (Array.isArray(value)) return value.map(canonicalTheme);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (THEME_COMPARE_IGNORED.has(key) || value[key] === undefined || value[key] === null) continue;
      out[key] = canonicalTheme(value[key]);
    }
    return out;
  }
  return value;
}

function parseThemeValue(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  const text = String(value).trim();
  if (!text.startsWith('{')) return undefined; // a preset name, or junk
  try {
    return JSON.parse(text);
  } catch (_) {
    return undefined;
  }
}

/**
 * Whether a gallery's stored theme makes it look different from Branding, so
 * it must keep its own look. Errs towards true: only "no theme" and an exact
 * copy of the Branding theme count as not custom.
 */
function storedThemeIsCustom(event, brandingTheme) {
  if (event.css_template_id != null) return true;
  // GalleryView renders events.header_style / hero_divider_style ahead of the
  // theme, so a gallery whose own value differs from Branding's looks
  // different today and must keep it.
  const brandingHeader = brandingTheme?.headerStyle || 'standard';
  const brandingDivider = brandingTheme?.heroDividerStyle || 'wave';
  if (event.header_style && event.header_style !== brandingHeader) return true;
  if (event.hero_divider_style && event.hero_divider_style !== brandingDivider) return true;
  if (event.color_theme == null || String(event.color_theme).trim() === '') return false;
  const theme = parseThemeValue(event.color_theme);
  if (!theme || typeof theme !== 'object' || !brandingTheme) return true;
  return JSON.stringify(canonicalTheme(theme)) !== JSON.stringify(canonicalTheme(brandingTheme));
}

async function upTheme(knex) {
  if (!(await knex.schema.hasTable('events'))) return;
  if (await knex.schema.hasColumn('events', 'custom_theme_enabled')) return;
  await knex.schema.alterTable('events', (table) => {
    table.boolean('custom_theme_enabled').notNullable().defaultTo(false);
  });

  const { custom, total } = await markCustomThemes(knex);
  console.log(`259: custom_theme_enabled on for ${custom} of ${total} galleries`);
}

/**
 * Turn custom_theme_enabled on for the galleries whose stored theme differs
 * from Branding. All galleries, or only `eventIds`: a portable restore of an
 * archive made before this migration runs it for the restored rows, which the
 * early return above would otherwise skip (issue 2481).
 */
async function markCustomThemes(knex, eventIds = null) {
  let brandingTheme = null;
  if (await knex.schema.hasTable('app_settings')) {
    const row = await knex('app_settings').where({ setting_key: 'theme_config' }).first('setting_value');
    const parsed = parseThemeValue(row?.setting_value);
    brandingTheme = parsed && typeof parsed === 'object' ? parsed : null;
  }

  const rows = [];
  const columns = ['id', 'color_theme', 'css_template_id', 'header_style', 'hero_divider_style'];
  if (eventIds === null) rows.push(...await knex('events').select(columns));
  else {
    for (let i = 0; i < eventIds.length; i += 200) {
      rows.push(...await knex('events').whereIn('id', eventIds.slice(i, i + 200)).select(columns));
    }
  }
  const customIds = rows.filter((r) => storedThemeIsCustom(r, brandingTheme)).map((r) => r.id);
  for (let i = 0; i < customIds.length; i += 200) {
    await knex('events').whereIn('id', customIds.slice(i, i + 200)).update({ custom_theme_enabled: formatBoolean(true) });
  }
  return { custom: customIds.length, total: rows.length };
}

async function downTheme(knex) {
  if (await knex.schema.hasColumn('events', 'custom_theme_enabled')) {
    await knex.schema.alterTable('events', (table) => table.dropColumn('custom_theme_enabled'));
  }
}

exports.up = async function (knex) {
  await upPermissions(knex);
  await upTheme(knex);
};

exports.down = async function (knex) {
  await downTheme(knex);
  await downPermissions(knex);
};

exports.storedThemeIsCustom = storedThemeIsCustom;
exports.markCustomThemes = markCustomThemes;

exports.NEW_PERMISSIONS = NEW_PERMISSIONS;
exports.CUSTOMER_SUPPORT = CUSTOMER_SUPPORT;
