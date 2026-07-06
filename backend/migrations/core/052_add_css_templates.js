/**
 * Migration: Add CSS Templates feature
 * Creates css_templates table and adds css_template_id to events table
 */

// Default CSS template content
const DEFAULT_CSS_TEMPLATE = `/*
 * PicPeak Custom CSS Template: Elegant Dark
 *
 * Available CSS Custom Properties:
 * --gallery-bg: Background color
 * --gallery-text: Primary text color
 * --gallery-accent: Accent/highlight color
 * --gallery-border: Border color
 * --gallery-shadow: Box shadow value
 * --gallery-radius: Border radius value
 * --gallery-spacing: Base spacing unit
 */

/* ===== Base Theme Variables ===== */
.gallery-page {
  --gallery-bg: #1a1a2e;
  --gallery-bg-secondary: #16213e;
  --gallery-text: #eaeaea;
  --gallery-text-muted: #8b8b9a;
  --gallery-accent: #e94560;
  --gallery-accent-hover: #ff6b6b;
  --gallery-border: #2d2d44;
  --gallery-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  --gallery-radius: 12px;
  --gallery-spacing: 16px;
}

/* ===== Page Background ===== */
.gallery-page {
  background: linear-gradient(135deg, var(--gallery-bg) 0%, var(--gallery-bg-secondary) 100%);
  min-height: 100vh;
  color: var(--gallery-text);
}

/* ===== Gallery Header ===== */
.gallery-header {
  background: rgba(22, 33, 62, 0.8);
  backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--gallery-border);
  padding: calc(var(--gallery-spacing) * 2);
}

.gallery-title {
  color: var(--gallery-text);
  font-size: 2rem;
  font-weight: 700;
  letter-spacing: -0.02em;
}

/* ===== Photo Grid ===== */
.photo-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--gallery-spacing);
  padding: calc(var(--gallery-spacing) * 2);
}

/* ===== Photo Cards ===== */
.photo-card {
  background: var(--gallery-bg-secondary);
  border-radius: var(--gallery-radius);
  overflow: hidden;
  transition: transform 0.3s ease, box-shadow 0.3s ease;
  border: 1px solid var(--gallery-border);
}

.photo-card:hover {
  transform: translateY(-4px);
  box-shadow: var(--gallery-shadow);
}

.photo-card img {
  width: 100%;
  height: 200px;
  object-fit: cover;
  transition: transform 0.3s ease;
}

.photo-card:hover img {
  transform: scale(1.05);
}

/* ===== Buttons ===== */
.gallery-btn {
  background: var(--gallery-accent);
  color: white;
  border: none;
  border-radius: calc(var(--gallery-radius) / 2);
  padding: calc(var(--gallery-spacing) / 2) var(--gallery-spacing);
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s ease, transform 0.2s ease;
}

.gallery-btn:hover {
  background: var(--gallery-accent-hover);
  transform: translateY(-2px);
}

/* ===== Lightbox ===== */
.lightbox-overlay {
  background: rgba(10, 10, 20, 0.95);
  backdrop-filter: blur(20px);
}

/* ===== Responsive Adjustments ===== */
@media (max-width: 768px) {
  .gallery-page {
    --gallery-spacing: 12px;
  }

  .photo-grid {
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  }

  .gallery-title {
    font-size: 1.5rem;
  }
}`;

exports.up = async function(knex) {
  // Create css_templates table
  const hasTable = await knex.schema.hasTable('css_templates');
  if (!hasTable) {
    await knex.schema.createTable('css_templates', (table) => {
      table.increments('id').primary();
      table.integer('slot_number').notNullable();
      table.string('name', 50).notNullable().defaultTo('Untitled');
      table.text('css_content').notNullable().defaultTo('');
      table.boolean('is_enabled').notNullable().defaultTo(false);
      table.boolean('is_default').notNullable().defaultTo(false);
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());
      table.unique('slot_number');
    });

    // Insert default templates
    await knex('css_templates').insert([
      {
        slot_number: 1,
        name: 'Elegant Dark',
        css_content: DEFAULT_CSS_TEMPLATE,
        is_enabled: true,
        is_default: true
      },
      {
        slot_number: 2,
        name: 'Untitled',
        css_content: '',
        is_enabled: false,
        is_default: false
      },
      {
        slot_number: 3,
        name: 'Untitled',
        css_content: '',
        is_enabled: false,
        is_default: false
      }
    ]);
  }

  // Add css_template_id to events table
  const hasColumn = await knex.schema.hasColumn('events', 'css_template_id');
  if (!hasColumn) {
    await knex.schema.alterTable('events', (table) => {
      table.integer('css_template_id').references('id').inTable('css_templates').onDelete('SET NULL');
    });
  }
};

exports.down = async function(knex) {
  // Remove css_template_id from events table
  const hasColumn = await knex.schema.hasColumn('events', 'css_template_id');
  if (hasColumn) {
    await knex.schema.alterTable('events', (table) => {
      table.dropColumn('css_template_id');
    });
  }

  // Drop css_templates table
  await knex.schema.dropTableIfExists('css_templates');
};

// Export default template for use in reset functionality
module.exports.DEFAULT_CSS_TEMPLATE = DEFAULT_CSS_TEMPLATE;
