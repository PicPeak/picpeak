/**
 * Remove remote `url()` references from stored CSS templates.
 *
 * `sanitizeCSS` was supposed to block them on write. It didn't: it prefixed
 * the offending token with a `/* BLOCKED URL *\/` COMMENT and left the URL
 * in place. CSS comments are discarded during tokenization, so what a browser
 * parsed still carried the live URL:
 *
 *   '.a{background:url(https://x/p.gif)}'
 *     stored as '.a{background:/* BLOCKED URL *\/ url(https://x/p.gif)}'
 *     parsed as '.a{background: url(https://x/p.gif)}'
 *
 * Meanwhile the route returned `sanitization_warnings: ["Blocked external URL
 * references..."]`, so the admin was told it had been stopped.
 *
 * The sanitizer is fixed, but that only covers FUTURE writes. The public
 * render path (`gallery.js`, GET /gallery/:slug/css) serves
 * `css_templates.css_content` verbatim as text/css to gallery visitors — it
 * does not re-sanitize on read. So without this pass every template already
 * carrying a remote URL keeps serving it to every visitor forever, which is
 * exactly the population the fix exists for.
 *
 * WHY A MIGRATION AND NOT A BOOT SELF-HEAL: once the sanitizer is fixed, the
 * write path is the only way a bad row can appear, so there is nothing left
 * to self-heal. This is a one-time data correction and belongs in the ledger.
 *
 * IRREVERSIBLE BY DESIGN: `down()` cannot restore the removed URLs — the
 * original text is gone, and re-introducing third-party requests into pages
 * served to visitors is not something a rollback should do silently. It is a
 * no-op, deliberately.
 *
 * WHAT IT COSTS: a template using a remote background image has worked until
 * now (because the block was inert) and will stop. That is the point, but it
 * is a visible change, so every affected slot is named in an `activity_logs`
 * entry — which is what the admin notification bell reads — rather than
 * changing silently. Note the CSS is served with `Cache-Control: public,
 * max-age=3600`, so a visitor may hold a cached copy for up to an hour after
 * this runs.
 *
 * Inline `data:image/*` URIs are untouched.
 */

const { stripDisallowedUrls } = require('../../src/utils/cssSanitizer');

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('css_templates'))) return;

  const templates = await knex('css_templates')
    .whereNotNull('css_content')
    .select('id', 'slot_number', 'name', 'css_content');

  const repaired = [];

  for (const template of templates) {
    // ONLY the url() pass, not the whole of sanitizeCSS.
    //
    // Re-running the full sanitizer would be the obvious move and is wrong:
    // it strips control characters, and `\n` is one — so every template would
    // come back as a single line. Migration 181 hit the same edge from the
    // other side. Reformatting every stylesheet in the install is far beyond
    // "remove the remote URLs", and it would land in the editor the operator
    // next opens.
    //
    // The url() pass is also the ONLY thing that was broken: `@import`,
    // `expression(`, `behavior:` and friends were genuinely removed by the
    // old code. So the narrow fix is also the complete one.
    const { sanitized: urlSafe, blocked } = stripDisallowedUrls(template.css_content);

    // Drop the stale marker the broken sanitizer left behind. Only rows that
    // carry one are touched, and by definition those are affected rows.
    const sanitized = urlSafe.replace(/\/\*\s*BLOCKED URL\s*\*\/\s*/gi, '');

    if (blocked === 0 && sanitized === template.css_content) continue;

    await knex('css_templates')
      .where({ id: template.id })
      .update({ css_content: sanitized, updated_at: knex.fn.now() });

    repaired.push({
      slot: template.slot_number,
      name: template.name || `Slot ${template.slot_number}`,
    });
  }

  if (repaired.length === 0) return;

  console.log(
    `200: removed remote url() references from ${repaired.length} CSS template(s): `
    + repaired.map((r) => `#${r.slot} ${r.name}`).join(', ')
  );

  // Surface it to the operator. Admin notifications ARE unread activity_logs
  // rows (adminNotifications.js reads that table), so this shows up in the
  // bell without a second mechanism. Written directly rather than through
  // logActivity() to keep the migration free of a service import.
  if (await knex.schema.hasTable('activity_logs')) {
    try {
      await knex('activity_logs').insert({
        activity_type: 'css_template_remote_urls_removed',
        actor_type: 'system',
        metadata: JSON.stringify({
          count: repaired.length,
          templates: repaired,
        }),
      });
    } catch (err) {
      // A notification is not worth failing the data correction over.
      console.log(`200: could not write the activity log entry (${err.message})`);
    }
  }
};

exports.down = async function () {
  // Intentionally a no-op — see the header.
};
