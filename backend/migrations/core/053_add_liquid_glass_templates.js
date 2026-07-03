/**
 * Migration: Add Liquid Glass CSS Templates
 * Updates template slots 2 and 3 with Apple-inspired Liquid Glass designs
 *
 * These are starter example templates for new installations.
 * Users can edit or replace them as needed.
 */

const APPLE_LIQUID_GLASS = `/*
 * PicPeak Custom CSS Template: Apple Liquid Glass
 * Authentic iOS 26 / macOS Tahoe Liquid Glass Design
 */

/* ===== Apple System Fonts ===== */
.gallery-page,
.gallery-page *,
.gallery-sidebar,
.gallery-sidebar * {
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text",
               "Helvetica Neue", Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

/* ===== CSS Variables ===== */
:root {
  --glass-blur: 20px;
  --glass-blur-heavy: 40px;
  --glass-saturation: 180%;
  --glass-bg: rgba(255, 255, 255, 0.08);
  --glass-bg-medium: rgba(255, 255, 255, 0.18);
  --glass-bg-solid: rgba(255, 255, 255, 0.25);
  --glass-border: rgba(255, 255, 255, 0.2);
  --glass-border-light: rgba(255, 255, 255, 0.4);
  --glass-shadow: 0 8px 32px rgba(31, 38, 135, 0.15);
  --glass-inset: inset 0 1px 1px rgba(255, 255, 255, 0.4),
                 inset 0 -1px 1px rgba(0, 0, 0, 0.05);
  --gallery-gradient: linear-gradient(135deg, #667eea 0%, #764ba2 50%, #f093fb 100%);
  --gallery-text: #1a1a2e;
  --gallery-text-light: #ffffff;
  --gallery-accent: #667eea;
  --gallery-radius: 20px;
  --gallery-radius-sm: 12px;
}

/* ===== Page Background ===== */
.gallery-page {
  background: var(--gallery-gradient) !important;
  background-attachment: fixed !important;
  min-height: 100vh;
}

.gallery-page::before {
  content: '';
  position: fixed;
  inset: 0;
  background:
    radial-gradient(ellipse 600px 400px at 15% 85%, rgba(255, 255, 255, 0.2) 0%, transparent 50%),
    radial-gradient(ellipse 500px 350px at 85% 15%, rgba(255, 255, 255, 0.15) 0%, transparent 45%);
  pointer-events: none;
  z-index: 0;
}

/* ===== TOP BAR / HEADER - Liquid Glass ===== */
.gallery-page .gallery-header,
.gallery-page header {
  background: var(--glass-bg-medium) !important;
  backdrop-filter: blur(var(--glass-blur-heavy)) saturate(var(--glass-saturation)) !important;
  -webkit-backdrop-filter: blur(var(--glass-blur-heavy)) saturate(var(--glass-saturation)) !important;
  border-bottom: 1px solid var(--glass-border) !important;
  box-shadow: var(--glass-shadow), var(--glass-inset) !important;
}

.gallery-page .gallery-header > div {
  background: transparent !important;
  border: none !important;
}

/* ===== SIDEBAR - Liquid Glass ===== */
.gallery-sidebar {
  background: var(--glass-bg-medium) !important;
  backdrop-filter: blur(var(--glass-blur-heavy)) saturate(var(--glass-saturation)) !important;
  -webkit-backdrop-filter: blur(var(--glass-blur-heavy)) saturate(var(--glass-saturation)) !important;
  border-right: 1px solid var(--glass-border) !important;
  box-shadow: 4px 0 32px rgba(31, 38, 135, 0.1), var(--glass-inset) !important;
}

.gallery-sidebar h2,
.gallery-sidebar h3 {
  color: var(--gallery-text) !important;
  font-weight: 600 !important;
}

/* ===== HERO LAYOUT - Transform to Glass Title Box ===== */
/* Target the hero wrapper */
.gallery-page .relative.-mt-6 {
  margin-top: 0 !important;
}

/* Target the hero section (first child with h-[60vh]) */
.gallery-page .relative.-mt-6 > .relative:first-child {
  height: auto !important;
  min-height: auto !important;
  margin: 0 !important;
  padding: 2rem !important;
  display: flex !important;
  justify-content: center !important;
  align-items: center !important;
  background: transparent !important;
}

/* Hide the hero background image */
.gallery-page .relative.-mt-6 > .relative:first-child > img,
.gallery-page .relative.-mt-6 > .relative:first-child > canvas {
  display: none !important;
}

/* Hide the dark overlay */
.gallery-page .relative.-mt-6 > .relative:first-child > .absolute.inset-0.bg-black {
  display: none !important;
}

/* Style the content area as glass title box */
.gallery-page .relative.-mt-6 > .relative:first-child > .absolute.inset-0.flex {
  position: relative !important;
  inset: auto !important;
  background: var(--glass-bg-medium) !important;
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturation)) !important;
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturation)) !important;
  border: 1px solid var(--glass-border-light) !important;
  border-radius: var(--gallery-radius) !important;
  padding: 2rem 3rem !important;
  box-shadow: var(--glass-shadow), var(--glass-inset) !important;
  max-width: 600px !important;
  width: auto !important;
}

/* Hide logo in glass title box */
.gallery-page .relative.-mt-6 > .relative:first-child .mb-6 {
  display: none !important;
}

/* Style title text */
.gallery-page .relative.-mt-6 > .relative:first-child h1 {
  color: var(--gallery-text) !important;
  text-shadow: none !important;
  font-weight: 700 !important;
  font-size: 2.25rem !important;
  margin-bottom: 0.75rem !important;
}

/* Style date text */
.gallery-page .relative.-mt-6 > .relative:first-child .text-white\\/90 {
  color: var(--gallery-text) !important;
  opacity: 0.8;
}

/* Hide scroll down button */
.gallery-page .relative.-mt-6 > .relative:first-child > .absolute.bottom-8,
.gallery-page .relative.-mt-6 > .relative:first-child > button.absolute {
  display: none !important;
}

/* ===== PHOTO GRID ===== */
.gallery-page .photo-grid {
  display: grid !important;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)) !important;
  gap: 1.25rem !important;
  padding: 1rem !important;
}

/* ===== PHOTO CARDS - Liquid Glass ===== */
.gallery-page .photo-card {
  background: var(--glass-bg) !important;
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturation)) !important;
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturation)) !important;
  border: 1px solid var(--glass-border) !important;
  border-radius: var(--gallery-radius) !important;
  overflow: hidden !important;
  transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1) !important;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1), var(--glass-inset) !important;
}

.gallery-page .photo-card:hover {
  transform: translateY(-6px) scale(1.02) !important;
  box-shadow: 0 20px 40px rgba(102, 126, 234, 0.25),
              0 8px 16px rgba(0, 0, 0, 0.1),
              var(--glass-inset) !important;
  border-color: var(--glass-border-light) !important;
}

.gallery-page .photo-card img {
  transition: transform 0.4s ease !important;
}

.gallery-page .photo-card:hover img {
  transform: scale(1.05) !important;
}

/* ===== BUTTONS - Glass Pill Style ===== */
.gallery-page button,
.gallery-page [role="button"],
.gallery-sidebar button {
  background: var(--glass-bg) !important;
  backdrop-filter: blur(12px) saturate(150%) !important;
  -webkit-backdrop-filter: blur(12px) saturate(150%) !important;
  border: 1px solid var(--glass-border) !important;
  border-radius: 9999px !important;
  color: var(--gallery-text) !important;
  font-weight: 500 !important;
  transition: all 0.3s ease !important;
}

.gallery-page button:hover,
.gallery-page [role="button"]:hover,
.gallery-sidebar button:hover {
  background: var(--glass-bg-medium) !important;
  transform: translateY(-1px);
  box-shadow: 0 4px 16px rgba(102, 126, 234, 0.2) !important;
}

.gallery-page button[class*="bg-primary"],
.gallery-page .gallery-btn-download {
  background: linear-gradient(135deg, var(--gallery-accent) 0%, #764ba2 100%) !important;
  color: white !important;
  border: none !important;
}

/* ===== INPUT FIELDS ===== */
.gallery-page input,
.gallery-page select,
.gallery-sidebar input,
.gallery-sidebar select {
  background: rgba(255, 255, 255, 0.25) !important;
  backdrop-filter: blur(8px) !important;
  -webkit-backdrop-filter: blur(8px) !important;
  border: 1px solid var(--glass-border) !important;
  border-radius: var(--gallery-radius-sm) !important;
  color: var(--gallery-text) !important;
}

/* Input placeholder text - make it visible */
.gallery-page input::placeholder,
.gallery-sidebar input::placeholder {
  color: rgba(26, 26, 46, 0.6) !important;
  opacity: 1 !important;
}

/* Input focus state */
.gallery-page input:focus,
.gallery-sidebar input:focus {
  background: rgba(255, 255, 255, 0.35) !important;
  border-color: var(--glass-border-light) !important;
  outline: none !important;
  box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.2) !important;
}

/* ===== FOOTER ===== */
.gallery-page .gallery-footer,
.gallery-page footer {
  background: var(--glass-bg) !important;
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturation)) !important;
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturation)) !important;
  border-top: 1px solid var(--glass-border) !important;
}

/* ===== LIGHTBOX ===== */
.gallery-page [class*="fixed"][class*="inset-0"][class*="z-50"] {
  background: rgba(0, 0, 0, 0.7) !important;
  backdrop-filter: blur(30px) !important;
  -webkit-backdrop-filter: blur(30px) !important;
}

/* ===== SCROLLBAR ===== */
.gallery-page ::-webkit-scrollbar,
.gallery-sidebar ::-webkit-scrollbar {
  width: 8px;
}

.gallery-page ::-webkit-scrollbar-track,
.gallery-sidebar ::-webkit-scrollbar-track {
  background: rgba(255, 255, 255, 0.1);
}

.gallery-page ::-webkit-scrollbar-thumb,
.gallery-sidebar ::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.3);
  border-radius: 4px;
}

/* ===== RESPONSIVE ===== */
@media (max-width: 768px) {
  :root {
    --gallery-radius: 16px;
    --glass-blur: 16px;
  }

  .gallery-page .relative.-mt-6 > .relative:first-child > .absolute.inset-0.flex {
    padding: 1.5rem 2rem !important;
    max-width: 90% !important;
  }

  .gallery-page .relative.-mt-6 > .relative:first-child h1 {
    font-size: 1.5rem !important;
  }

  .gallery-page .photo-grid {
    grid-template-columns: repeat(2, 1fr) !important;
    gap: 0.75rem !important;
  }
}

/* ===== ACCESSIBILITY ===== */
@media (prefers-reduced-motion: reduce) {
  .gallery-page .photo-card,
  .gallery-page button {
    transition: none !important;
  }

  .gallery-page .photo-card:hover {
    transform: none !important;
  }
}

@media (prefers-reduced-transparency: reduce) {
  .gallery-page .photo-card,
  .gallery-page button,
  .gallery-sidebar {
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
    background: rgba(255, 255, 255, 0.95) !important;
  }
}`;

const LIQUID_GLASS_DARK = `/*
 * PicPeak Custom CSS Template: Liquid Glass Dark
 * Inspired by Apple's iOS 26 Liquid Glass Design Language
 *
 * Features:
 * - Deep translucent dark surfaces
 * - Neon accent highlights
 * - Dramatic glass reflections
 * - Subtle animated gradients
 */

/* ===== Base Theme Variables ===== */
.gallery-page {
  --glass-bg: rgba(15, 15, 35, 0.7);
  --glass-bg-elevated: rgba(25, 25, 55, 0.85);
  --glass-border: rgba(255, 255, 255, 0.1);
  --glass-border-highlight: rgba(255, 255, 255, 0.2);
  --glass-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  --glass-blur: 24px;
  --glass-saturation: 150%;

  --gallery-bg: #0a0a1a;
  --gallery-text: #f0f0f5;
  --gallery-text-muted: rgba(240, 240, 245, 0.6);
  --gallery-accent: #00d4ff;
  --gallery-accent-secondary: #ff00e5;
  --gallery-accent-hover: #00ffea;
  --gallery-radius: 20px;
  --gallery-spacing: 20px;

  /* Neon glow variables */
  --neon-glow: 0 0 20px rgba(0, 212, 255, 0.5), 0 0 40px rgba(0, 212, 255, 0.2);
  --neon-glow-secondary: 0 0 20px rgba(255, 0, 229, 0.5), 0 0 40px rgba(255, 0, 229, 0.2);
}

/* ===== Page Background ===== */
.gallery-page {
  background: var(--gallery-bg);
  min-height: 100vh;
  position: relative;
  overflow-x: hidden;
}

/* Animated mesh gradient background */
.gallery-page::before {
  content: '';
  position: fixed;
  top: -50%;
  left: -50%;
  right: -50%;
  bottom: -50%;
  background:
    radial-gradient(circle at 30% 20%, rgba(0, 212, 255, 0.15) 0%, transparent 40%),
    radial-gradient(circle at 70% 80%, rgba(255, 0, 229, 0.1) 0%, transparent 40%),
    radial-gradient(circle at 50% 50%, rgba(100, 100, 255, 0.05) 0%, transparent 60%);
  animation: gradientShift 20s ease-in-out infinite;
  pointer-events: none;
  z-index: 0;
}

@keyframes gradientShift {
  0%, 100% { transform: translate(0, 0) rotate(0deg); }
  25% { transform: translate(2%, 2%) rotate(1deg); }
  50% { transform: translate(-1%, 3%) rotate(-1deg); }
  75% { transform: translate(3%, -2%) rotate(2deg); }
}

/* ===== Gallery Header ===== */
.gallery-header {
  background: var(--glass-bg-elevated);
  backdrop-filter: blur(30px) saturate(var(--glass-saturation));
  -webkit-backdrop-filter: blur(30px) saturate(var(--glass-saturation));
  border-bottom: 1px solid var(--glass-border-highlight);
  padding: calc(var(--gallery-spacing) * 1.5);
  position: sticky;
  top: 0;
  z-index: 100;
  box-shadow:
    0 4px 24px rgba(0, 0, 0, 0.3),
    inset 0 1px 0 rgba(255, 255, 255, 0.1);
}

.gallery-title {
  color: var(--gallery-text);
  font-weight: 700;
  font-size: 1.75rem;
  letter-spacing: -0.02em;
  background: linear-gradient(135deg, var(--gallery-text) 0%, var(--gallery-accent) 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

/* ===== Photo Grid ===== */
.photo-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: var(--gallery-spacing);
  padding: calc(var(--gallery-spacing) * 2);
  position: relative;
  z-index: 1;
}

/* ===== Photo Cards - Dark Glass Style ===== */
.photo-card {
  position: relative;
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturation));
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturation));
  border: 1px solid var(--glass-border);
  border-radius: var(--gallery-radius);
  overflow: hidden;
  transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow:
    0 4px 24px rgba(0, 0, 0, 0.3),
    inset 0 1px 0 rgba(255, 255, 255, 0.05);
}

/* Top highlight reflection */
.photo-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(255, 255, 255, 0.3) 50%,
    transparent 100%
  );
  z-index: 2;
}

/* Inner glow effect */
.photo-card::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: var(--gallery-radius);
  padding: 1px;
  background: linear-gradient(
    135deg,
    rgba(0, 212, 255, 0) 0%,
    rgba(0, 212, 255, 0) 40%,
    rgba(0, 212, 255, 0.1) 100%
  );
  -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.4s ease;
}

.photo-card:hover {
  transform: translateY(-8px) scale(1.02);
  border-color: var(--glass-border-highlight);
  box-shadow:
    0 24px 48px rgba(0, 0, 0, 0.4),
    0 0 0 1px rgba(0, 212, 255, 0.2),
    var(--neon-glow);
}

.photo-card:hover::after {
  opacity: 1;
}

.photo-card img {
  width: 100%;
  height: 240px;
  object-fit: cover;
  transition: transform 0.4s ease, filter 0.4s ease;
  filter: brightness(0.9);
}

.photo-card:hover img {
  transform: scale(1.05);
  filter: brightness(1);
}

.photo-card-info {
  padding: var(--gallery-spacing);
  background: linear-gradient(
    180deg,
    rgba(0, 0, 0, 0.2) 0%,
    rgba(0, 0, 0, 0.4) 100%
  );
  color: var(--gallery-text);
}

.photo-card-info p {
  color: var(--gallery-text-muted);
  font-size: 0.875rem;
}

/* ===== Buttons - Neon Glass Style ===== */
.gallery-btn {
  background: var(--glass-bg);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border: 1px solid var(--glass-border);
  border-radius: calc(var(--gallery-radius) / 2);
  padding: 12px 24px;
  color: var(--gallery-text);
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s ease;
  position: relative;
}

.gallery-btn:hover {
  border-color: var(--gallery-accent);
  box-shadow: var(--neon-glow);
  color: var(--gallery-accent);
}

.gallery-btn-primary {
  background: linear-gradient(135deg, var(--gallery-accent) 0%, var(--gallery-accent-secondary) 100%);
  color: white;
  border: none;
  box-shadow: var(--neon-glow);
}

.gallery-btn-primary:hover {
  box-shadow:
    0 0 30px rgba(0, 212, 255, 0.6),
    0 0 60px rgba(0, 212, 255, 0.3),
    0 0 90px rgba(255, 0, 229, 0.2);
  transform: translateY(-2px);
}

/* ===== Lightbox - Dark Glass ===== */
.lightbox-overlay {
  background: rgba(5, 5, 15, 0.9);
  backdrop-filter: blur(40px);
  -webkit-backdrop-filter: blur(40px);
}

.lightbox-content {
  background: var(--glass-bg-elevated);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  border: 1px solid var(--glass-border-highlight);
  border-radius: var(--gallery-radius);
  box-shadow:
    0 24px 80px rgba(0, 0, 0, 0.5),
    var(--neon-glow);
}

/* ===== Category Pills ===== */
.category-pill {
  background: var(--glass-bg);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border: 1px solid var(--glass-border);
  border-radius: 9999px;
  padding: 8px 20px;
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--gallery-text-muted);
  transition: all 0.3s ease;
}

.category-pill:hover {
  border-color: var(--gallery-accent);
  color: var(--gallery-accent);
  box-shadow: var(--neon-glow);
}

.category-pill.active {
  background: linear-gradient(135deg, var(--gallery-accent) 0%, var(--gallery-accent-secondary) 100%);
  color: white;
  border-color: transparent;
  box-shadow: var(--neon-glow);
}

/* ===== Scrollbar Styling ===== */
.gallery-page ::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

.gallery-page ::-webkit-scrollbar-track {
  background: var(--glass-bg);
  border-radius: 4px;
}

.gallery-page ::-webkit-scrollbar-thumb {
  background: linear-gradient(180deg, var(--gallery-accent) 0%, var(--gallery-accent-secondary) 100%);
  border-radius: 4px;
}

/* ===== Responsive ===== */
@media (max-width: 768px) {
  .gallery-page {
    --gallery-radius: 16px;
    --gallery-spacing: 12px;
    --glass-blur: 16px;
  }

  .photo-grid {
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  }

  .photo-card img {
    height: 180px;
  }

  /* Reduce animation complexity on mobile */
  .gallery-page::before {
    animation: none;
  }
}

/* ===== Accessibility: Reduce Motion ===== */
@media (prefers-reduced-motion: reduce) {
  .gallery-page::before {
    animation: none;
  }

  .photo-card,
  .gallery-btn {
    transition: none;
  }

  .photo-card:hover {
    transform: none;
  }
}

/* ===== Accessibility: Reduce Transparency ===== */
@media (prefers-reduced-transparency: reduce) {
  .photo-card,
  .gallery-btn,
  .gallery-header {
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }

  .gallery-page {
    --glass-bg: rgba(20, 20, 40, 0.98);
    --glass-bg-elevated: rgba(30, 30, 60, 0.98);
  }
}`;

exports.up = async function(knex) {
  // Update template slot 2 with Apple Liquid Glass (Light)
  await knex('css_templates')
    .where({ slot_number: 2 })
    .update({
      name: 'Apple Liquid Glass',
      css_content: APPLE_LIQUID_GLASS,
      is_enabled: true,
      is_default: false,
      updated_at: knex.fn.now()
    });

  // Update template slot 3 with Liquid Glass Dark
  await knex('css_templates')
    .where({ slot_number: 3 })
    .update({
      name: 'Liquid Glass Dark',
      css_content: LIQUID_GLASS_DARK,
      is_enabled: true,
      is_default: false,
      updated_at: knex.fn.now()
    });
};

exports.down = async function(knex) {
  // Revert to empty templates
  await knex('css_templates')
    .where({ slot_number: 2 })
    .update({
      name: 'Untitled',
      css_content: '',
      is_enabled: false,
      is_default: false,
      updated_at: knex.fn.now()
    });

  await knex('css_templates')
    .where({ slot_number: 3 })
    .update({
      name: 'Untitled',
      css_content: '',
      is_enabled: false,
      is_default: false,
      updated_at: knex.fn.now()
    });
};

// Export templates for use elsewhere
module.exports.APPLE_LIQUID_GLASS = APPLE_LIQUID_GLASS;
module.exports.LIQUID_GLASS_DARK = LIQUID_GLASS_DARK;
