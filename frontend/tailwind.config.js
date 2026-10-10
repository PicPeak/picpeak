/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      // `text-accent` reads the accent nudged until it reads as text
      // (tokens.css › --accent-text); fills and borders keep the raw accent.
      textColor: {
        accent: 'var(--accent-text)',
      },
      colors: {
        // 8-token CI palette aliases — these read CSS variables that are set
        // either by ThemeContext.applyTheme (gallery + branding) or by the
        // :root.dark { } block in index.css (admin dark mode). Use these in
        // place of bg-white / text-neutral-900 / border-neutral-200 so that
        // every component flips with dark/light mode automatically.
        // UI tokens (src/styles/tokens.css) — the admin palette. Light on :root,
        // dark under .dark, so these need no dark: variants. STYLING.md has the
        // table; scripts/codemod-ui-tokens.mjs rewrites raw pairs to them.
        canvas: 'var(--ui-canvas)',
        shell: 'var(--ui-shell)',
        panel: 'var(--ui-panel)',
        subtle: 'var(--ui-subtle)',
        inset: 'var(--ui-inset)',
        fill: { DEFAULT: 'var(--ui-fill)', strong: 'var(--ui-fill-strong)' },
        hover: { DEFAULT: 'var(--ui-hover)', soft: 'var(--ui-hover-soft)' },
        heading: 'var(--ui-text-heading)',
        body: 'var(--ui-text-body)',
        soft: 'var(--ui-text-soft)',
        muted: 'var(--ui-text-muted)',
        faint: 'var(--ui-text-faint)',
        // Status (tokens.css › Status): bg-success for a dot, text-success-text
        // on a panel, bg-success-soft + border-success-line for a box. The
        // Badge and Notice components use these; prefer the components.
        success: { DEFAULT: 'var(--ui-success)', text: 'var(--ui-success-text)', soft: 'var(--ui-success-soft)', line: 'var(--ui-success-line)' },
        warning: { DEFAULT: 'var(--ui-warning)', text: 'var(--ui-warning-text)', soft: 'var(--ui-warning-soft)', line: 'var(--ui-warning-line)' },
        danger: { DEFAULT: 'var(--ui-danger)', text: 'var(--ui-danger-text)', soft: 'var(--ui-danger-soft)', line: 'var(--ui-danger-line)' },
        info: { DEFAULT: 'var(--ui-info)', text: 'var(--ui-info-text)', soft: 'var(--ui-info-soft)', line: 'var(--ui-info-line)' },
        storno: { DEFAULT: 'var(--ui-storno)', text: 'var(--ui-storno-text)', soft: 'var(--ui-storno-soft)', line: 'var(--ui-storno-line)' },
        // Data colours (tokens.css › Data colours): chart-1 … chart-8, in order.
        chart: { 1: 'var(--chart-1)', 2: 'var(--chart-2)', 3: 'var(--chart-3)', 4: 'var(--chart-4)', 5: 'var(--chart-5)', 6: 'var(--chart-6)', 7: 'var(--chart-7)', 8: 'var(--chart-8)' },
        // Rating stars (tokens.css › Data colours).
        rating: 'var(--color-rating)',
        // Admin accent (tokens.css › Accent).
        'accent-strong': 'var(--ui-accent-strong)',
        'accent-fg': 'var(--ui-accent-fg)',
        line: { DEFAULT: 'var(--ui-line)', strong: 'var(--ui-line-strong)', faint: 'var(--ui-line-faint)' },
        // Theme tokens — operator-themed surfaces (gallery, portal, public pages).
        background: 'var(--color-background)',
        surface: 'var(--color-surface)',
        elevated: 'var(--color-elevated)',
        'border-token': 'var(--color-surface-border)',
        'text-primary': 'var(--color-text)',
        'text-secondary': 'var(--color-muted-text)',
        accent: 'var(--color-accent)',
        'accent-dark': 'var(--color-accent-dark)',
        neutral: {
          50: '#fafafa',
          100: '#f5f5f5',
          200: '#e5e5e5',
          300: '#d4d4d4',
          400: '#a3a3a3',
          500: '#737373',
          600: '#525252',
          700: '#404040',
          800: '#262626',
          900: '#171717',
        }
      },
      fontFamily: {
        sans: ['Inter', 'Noto Sans', 'system-ui', '-apple-system', 'sans-serif'],
      },
      animation: {
        'fade-in': 'fadeIn 0.5s ease-in-out',
        'slide-up': 'slideUp 0.3s ease-out',
        'scale-in': 'scaleIn 0.2s ease-out',
        'shimmer': 'shimmer 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'panel-in-right': 'panelInRight 0.2s ease-out',
        'panel-in-left': 'panelInLeft 0.2s ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { transform: 'translateY(10px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        scaleIn: {
          '0%': { transform: 'scale(0.95)', opacity: '0' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        panelInRight: {
          '0%': { transform: 'translateX(16px)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
        panelInLeft: {
          '0%': { transform: 'translateX(-16px)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
      },
      spacing: {
        '18': '4.5rem',
        '88': '22rem',
      },
      // Scale tokens: rounded-* and shadow-* read src/styles/tokens.css, so a
      // change there moves every corner and shadow at once.
      borderRadius: {
        'sm': 'var(--radius-sm)',
        'md': 'var(--radius-md)',
        'lg': 'var(--radius-lg)',
        'xl': 'var(--radius-xl)',
        '2xl': 'var(--radius-2xl)',
        '3xl': 'var(--radius-3xl)',
      },
      boxShadow: {
        'sm': 'var(--shadow-sm)',
        'md': 'var(--shadow-md)',
        'lg': 'var(--shadow-lg)',
        'xl': 'var(--shadow-xl)',
        '2xl': 'var(--shadow-2xl)',
        'soft': 'var(--shadow-soft)',
        'medium': 'var(--shadow-medium)',
        'large': 'var(--shadow-large)',
      },
    },
  },
  safelist: [
    // Dynamic grid-cols classes used by thumbnail scale offsets
    ...Array.from({ length: 12 }, (_, i) => `grid-cols-${i + 1}`),
    ...Array.from({ length: 12 }, (_, i) => `sm:grid-cols-${i + 1}`),
    ...Array.from({ length: 12 }, (_, i) => `lg:grid-cols-${i + 1}`),
    ...Array.from({ length: 12 }, (_, i) => `xl:grid-cols-${i + 1}`),
  ],
  plugins: [
    // Tailwind's Preflight resets h1-h6 to inherit their size and weight, and
    // strips list-style and padding from ul/ol. Ten places in this app render
    // rich text inside a `prose` container and rely on this plugin to put that
    // typography back — the CMS editor and its preview, the public CMS page,
    // release notes, and the gallery welcome message among them.
    //
    // Without it every `prose*` class is a no-op, so applying a heading or a
    // list in the CMS editor changed the document and changed NOTHING on
    // screen: the toolbar button lit up (the editor state was correct) while
    // the text stayed visually a paragraph. That is issue #1288.
    require('@tailwindcss/typography'),
  ],
}

