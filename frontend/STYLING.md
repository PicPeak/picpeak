# Styling guide

One place decides how PicPeak looks: **`src/styles/tokens.css`**. Change a
value there and every card, border, heading and hover in the admin follows.
This document explains what is in that file, how components consume it, and
the rules that keep it the single source.

## The two token families

PicPeak has two audiences with different owners, so it has two token families.

| Family | Prefix | Who sets the values | Where it is used |
|---|---|---|---|
| **UI tokens** | `--ui-*` | developers, in `tokens.css` | admin panel and every other developer-owned surface |
| **Theme tokens** | `--color-*` | the operator, through Branding | public gallery, customer portal, public quote/contract pages |

The theme tokens are overwritten at runtime: `ThemeContext.applyTheme()`
writes the operator's palette as inline `--color-*` styles on `<html>`, on
every non-gallery page too. That is why **admin code must never read a theme
token**. A `bg-surface` in the admin turns beige the moment an operator picks
a warm gallery theme, and a `var(--shadow-default)` on a card gives the admin
the gallery's shadow (which is exactly what happened before PR 1691).

Dark mode is a class: `AdminDarkModeContext` toggles `.dark` on `<html>`, and
`tokens.css` redefines every UI token under `.dark`. A component written with
the token utilities therefore needs **no `dark:` variants at all**.

## UI tokens

Each token is exposed as a Tailwind utility. Use the utility, not the
variable, unless you are writing plain CSS.

### Surfaces

| Utility | Token | Light | Dark | Use for |
|---|---|---|---|---|
| `bg-canvas` | `--ui-canvas` | `#fafafa` | `#0a0a0a` | the page floor (AdminLayout) |
| `bg-shell` | `--ui-shell` | `#ffffff` | `#171717` | header, sidebar |
| `bg-panel` | `--ui-panel` | `#ffffff` | `#262626` | cards, modals, tables, inputs, menus |
| `bg-subtle` | `--ui-subtle` | `#fafafa` | `#262626` | quiet boxes on a panel |
| `bg-inset` | `--ui-inset` | `#f5f5f5` | `#404040` | wells, code blocks, sunken rows |
| `bg-fill` | `--ui-fill` | `#e5e5e5` | `#404040` | progress tracks, skeletons, chips |
| `bg-fill-strong` | `--ui-fill-strong` | `#d4d4d4` | `#525252` | toggle thumbs, stronger fills |
| `hover:bg-hover` | `--ui-hover` | `#f5f5f5` | `#404040` | row and button hover on a panel |
| `hover:bg-hover-soft` | `--ui-hover-soft` | `#fafafa` | `#262626` | hover on a subtle box or the shell |

### Text

| Utility | Token | Light | Dark | Use for |
|---|---|---|---|---|
| `text-heading` | `--ui-text-heading` | `#171717` | `#f5f5f5` | titles, table values, anything that must read first |
| `text-body` | `--ui-text-body` | `#404040` | `#d4d4d4` | running text, labels, menu items |
| `text-soft` | `--ui-text-soft` | `#525252` | `#a3a3a3` | secondary text next to body text |
| `text-muted` | `--ui-text-muted` | `#737373` | `#a3a3a3` | captions, helper text, timestamps |
| `text-faint` | `--ui-text-faint` | `#a3a3a3` | `#737373` | icons at rest, placeholders, disabled |

### Lines

| Utility | Token | Light | Dark | Use for |
|---|---|---|---|---|
| `border-line` | `--ui-line` | `#e5e5e5` | `#404040` | card, table and section borders |
| `border-line-strong` | `--ui-line-strong` | `#d4d4d4` | `#525252` | input and select borders |
| `border-line-faint` | `--ui-line-faint` | `#f5f5f5` | `#262626` | hairlines inside a panel |

`divide-line`, `border-t-line`, `hover:border-line-strong` and the other
Tailwind forms work as usual.

### Scale

`rounded-*`, `shadow-*` and `font-sans` read `--radius-*`, `--shadow-*` and
`--font-family` from `tokens.css`, so a new corner radius or a softer shadow
is one edit. The values are Tailwind's defaults plus the project's `xl`/`2xl`
radii and `soft`/`medium`/`large` shadows.

### Status colours

Success, warning, danger and info keep Tailwind's `green`, `amber`, `red` and
`blue` scales, and the `.status-chip` / `.hue-*` classes in `index.css`. They
are the same in both modes by design. A token layer for them is a follow-up.

## Rules for admin code

1. **No neutral light/dark pairs.** `text-neutral-500 dark:text-neutral-400`
   is `text-muted`. The lint rule `ui-tokens/no-raw-dark-palette` fails the
   build on any pair that has a token, and `npm run codemod:ui-tokens`
   rewrites them for you.
2. **No theme tokens or theme utilities.** `bg-surface`, `text-theme`,
   `text-muted-theme`, `var(--color-*)` and `var(--shadow-default)` belong to
   the gallery, portal and public pages only. The `brandingThemeTextLeak`
   test guards the headings that were bitten by this.
3. **Prefer the primitives.** `Button`, `Card`, `Input`, `Loading`,
   `Skeleton`, `ConfirmDialog` in `src/components/common` already carry the
   tokens. A hand-rolled `<button className="px-3 py-2 rounded-lg bg-panel …">`
   is a sign that a variant is missing from `Button`; add the variant instead.
4. **New colour, new token.** If a design needs a shade that is not in the
   tables above, add a token to `tokens.css` (light and dark), expose it in
   `tailwind.config.js`, and document it here. Do not reach for
   `neutral-350` in a component.

## Changing the look

- Cooler or warmer greys, more contrast, a different dark palette: edit the
  `--ui-*` values in `tokens.css`. Nothing else needs to change.
- Corner radius or shadow depth: edit `--radius-*` / `--shadow-*`.
- The default gallery theme: edit the `--color-*` defaults, and keep
  `src/types/theme.types.ts` (the preset the operator sees) in step.

Check both modes after a change: the admin dark-mode toggle is in the header,
and `localStorage['admin-dark-mode'] = 'dark'` forces it.

## Migration state

The codemod rewrote every neutral pair in `src/components/admin`,
`src/pages/admin`, `src/features` and `src/components/common` (4,290 pairs in
225 files). What it deliberately left:

- **Lone light classes** (`text-neutral-400` with no dark partner, about 800
  of them). They render the same in both modes today; migrating one adds a
  dark value, so it is a per-component decision and a visual change.
- **Opacity modifiers** (`dark:bg-neutral-800/60`). The tokens are plain hex
  and cannot take `/60`. Either drop the alpha or use `bg-panel` and accept
  the solid fill.
- **Mixed pairs** (`bg-primary-50 dark:bg-neutral-800`): a coloured light
  side with a neutral dark side. Those are status boxes and need the status
  token layer first.
- **Inverse pairs** (`bg-neutral-900 dark:bg-neutral-100`): a handful of
  inverted buttons and tooltips.

The mapping normalises a few shades on purpose so that the token set stays
small. Screenshot diffs of the dashboard, an event, the settings and the
events list in both modes show no pixel moving more than a few steps; the
visible ones are:

- `text-neutral-800 dark:text-neutral-200` is `text-body` (light one step darker).
- `text-neutral-600 dark:text-neutral-300` is `text-body` (light one step darker, dark unchanged).
- `bg-neutral-50 dark:bg-neutral-700` and `bg-white dark:bg-neutral-700` are `bg-inset` (light one step darker).
- `bg-neutral-50 dark:bg-neutral-900` is `bg-shell` (light `#fafafa` becomes white).
- `border-neutral-200 dark:border-neutral-800` is `border-line-faint` (light one step lighter).
- `.input` in dark mode moved its border from `neutral-700` to `neutral-600`, matching the raw inputs around it.

`text-neutral-300` pairs (light text on a dark surface) have no token and stay raw.

## Tooling

| Command | What it does |
|---|---|
| `npm run lint` | includes `ui-tokens/no-raw-dark-palette` over the admin scope |
| `npm run codemod:ui-tokens` | applies that rule's autofix and nothing else |
| `npm run codemod:ui-tokens -- --check` | reports remaining pairs, exit 1 if any (use after a rebase) |

The pair table both tools read is `scripts/ui-tokens-map.mjs`.
