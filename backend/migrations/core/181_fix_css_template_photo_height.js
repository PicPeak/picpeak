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
 * SCOPE: only the exact declarations we shipped are rewritten, matched as
 * whole rule bodies. A fixed height someone deliberately wrote themselves does
 * not look like this and is left alone — and the other pixel heights in these
 * same templates (a 1px gradient divider, an 8px scrollbar) must obviously
 * survive, which is why this does not simply regex `height:\s*\d+px`.
 */

// [ what shipped, what it becomes ] — full rule bodies, so a partial match
// cannot rewrite something else that happens to share a declaration.
const REPLACEMENTS = [
  // 052, "Elegant Dark" (the default).
  [
    '.photo-card img {\n  width: 100%;\n  height: 200px;\n  object-fit: cover;',
    '.photo-card img {\n  width: 100%;\n  height: 100%;\n  object-fit: cover;',
  ],
  // 053, "Liquid Glass Dark".
  [
    '.photo-card img {\n  width: 100%;\n  height: 240px;\n  object-fit: cover;',
    '.photo-card img {\n  width: 100%;\n  height: 100%;\n  object-fit: cover;',
  ],
  // 053's mobile media query, same template.
  [
    '  .photo-card img {\n    height: 180px;\n  }',
    '  .photo-card img {\n    height: 100%;\n  }',
  ],
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('css_templates'))) return;

  const rows = await knex('css_templates').select('id', 'css_content');
  let fixed = 0;

  for (const row of rows) {
    const original = row.css_content;
    if (!original || typeof original !== 'string') continue;

    let updated = original;
    for (const [from, to] of REPLACEMENTS) {
      updated = updated.split(from).join(to);
    }

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
