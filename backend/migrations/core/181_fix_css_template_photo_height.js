/**
 * The bundled CSS templates pinned every gallery image to a fixed pixel
 * height, which broke every aspect-ratio layout (#1131).
 *
 * Six of the seven layouts size a tile by putting a computed pixel height on
 * `.photo-card` and letting the image fill it with `h-full`. A template rule
 * of `.photo-card img { height: 200px }` has specificity (0,1,1) and beats
 * `.h-full` at (0,1,0), so the image detached from its card: masonry rendered
 * correctly-shaped cards with a 200px image glued to the top and empty
 * background below — or, where the computed card was shorter than 200px, an
 * image taller than its own container.
 *
 * "Elegant Dark" is seeded `is_default = true`, so this was the out-of-the-box
 * result for anyone choosing any layout other than grid/timeline (where a
 * fixed square happens to look deliberate).
 *
 * Migrations 052 and 053 are corrected for fresh installs; this repairs the
 * rows already seeded. Templates are referenced by `events.css_template_id`
 * and read at serve time rather than copied onto the event, so fixing the row
 * fixes every gallery using it.
 *
 * SCOPE: every `.photo-card img` rule that carries a fixed PIXEL height, in
 * every template — not just the two we seeded, and not just their pristine
 * copies.
 *
 * That is broader than it first looks, and deliberately so. It is also not the
 * scope this started with: matching the exact seeded text missed every install
 * where the template had ever been saved through the editor, because
 * `sanitizeCSS` strips newlines. Those are the majority, and a migration that
 * silently no-ops on them while being recorded as applied is worse than none.
 *
 * The cost is that a fixed pixel height a user wrote themselves is rewritten
 * too. That is judged acceptable because there is no layout it can be right
 * for: all seven give `.photo-card` a definite height and expect the image to
 * fill it, so a pixel height on the image can only detach it from its card.
 * Anything that is not a fixed px height — %, vh, auto — is left alone, as is
 * every declaration outside a `.photo-card img` body.
 */

/**
 * Every `.photo-card img { … }` rule body, however it is spaced.
 *
 * Matching the exact seeded text does NOT work, and the reason is worth
 * stating: `sanitizeCSS` strips all control characters (cssSanitizer.js:61),
 * so the moment an admin saves a template through the editor — even only to
 * rename it or toggle it — every newline is REMOVED from the stored CSS. The
 * shipped `.photo-card img {\n  height: 200px;` becomes
 * `.photo-card img {  height: 200px;`. An exact-match migration would find
 * nothing on those installs, be recorded as applied, and leave the galleries
 * broken with no second chance.
 *
 * Scoped to the rule body rather than the whole stylesheet, so the other pixel
 * heights in these same templates — a 1px gradient divider, an 8px scrollbar —
 * are untouched.
 */
const PHOTO_CARD_IMG_RULE = /(\.photo-card\s+img\s*\{)([^}]*)\}/g;

/**
 * Only a fixed PIXEL height is wrong here; %, vh, auto and the rest stay.
 *
 * The lookbehind is load-bearing rather than defensive: without it the pattern
 * matches the TAIL of `line-height`, `max-height`, `min-height` and any custom
 * property ending in `-height`, and silently rewrites those instead — in a
 * migration whose down() is deliberately irreversible.
 */
const FIXED_PX_HEIGHT = /(?<![\w-])height\s*:\s*\d+(?:\.\d+)?px/gi;

function relaxFixedImageHeights(css) {
  return css.replace(PHOTO_CARD_IMG_RULE, (whole, open, body) => {
    if (!FIXED_PX_HEIGHT.test(body)) return whole;
    FIXED_PX_HEIGHT.lastIndex = 0;
    return `${open}${body.replace(FIXED_PX_HEIGHT, 'height: 100%')}}`;
  });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('css_templates'))) return;

  const rows = await knex('css_templates').select('id', 'css_content');
  let fixed = 0;

  for (const row of rows) {
    const original = row.css_content;
    if (!original || typeof original !== 'string') continue;

    const updated = relaxFixedImageHeights(original);

    if (updated !== original) {
      await knex('css_templates').where({ id: row.id }).update({ css_content: updated });
      fixed += 1;
    }
  }

  if (fixed > 0) {
    console.log(`  181: relaxed the fixed image height in ${fixed} CSS template(s)`);
  }
};

exports.down = async function down() {
  // Deliberately irreversible. Putting the pixel heights back would re-break
  // every aspect-ratio layout, and the rows may have been edited since — there
  // is no version of "restore" here that is safer than doing nothing.
};
