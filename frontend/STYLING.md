# Styling guide

One place decides how PicPeak looks: **`src/styles/tokens.css`**. Change a
value there and every card, border, heading and hover in the admin follows.
This document explains what is in that file, how components consume it, and
the rules that keep it the single source.

This file is about **how things look**. How pages behave — page structure,
saving, permissions, states, confirmations, copy — is in [`UX.md`](UX.md).
Read both before building or reworking an admin surface.

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

### Accent: the one brand colour the admin follows

The admin is neutral except for one colour: the operator's accent from
Branding. `text-accent`, `border-accent`, `bg-accent-dark`, `.btn-primary` and
`.tile-selected` read `--color-accent` / `--color-accent-dark`, so the active
tab, the primary button and a selected tile carry the studio's brand colour.
That is the deliberate exception to rule 2 below — use those five forms and
nothing else from the theme family.

| Use | Class |
|---|---|
| Primary action (one per view) | `<Button variant="primary">` (`.btn-primary`) |
| Active tab, active nav item, links | `text-accent` / `border-accent` |
| Selected option in a picker grid (layout, source, preset) | `.tile-selected` — full fill, white content |
| Soft highlight (a selected list row, an info note) | `bg-accent-dark/10` with `text-body` / `text-heading` |

Never put accent text on an accent tint (`text-accent` on `bg-accent-dark/10`):
it disappears on dark themes. That is why `.tile-selected` fills and turns its
content white.

Following the brand colour is a feature; the risk is contrast. A pastel
accent makes the white text on `.btn-primary` unreadable. **Follow-up for the
token layer:** a `--ui-accent` token that defaults to the brand accent and is
contrast-clamped against white text, so the admin keeps the studio's colour
without inheriting an unreadable one. There is no separate neutral admin
accent.

### Status colours

Success, warning, danger and info keep Tailwind's `green`, `amber`, `red` and
`blue` scales. They are the same family in both modes by design.

**Interim rule.** There is no `Badge` / `Notice` primitive in `common/` yet,
so for now copy exactly these pairs, so every badge and banner reads the same.
The first overhaul PR adds `Badge` (`tone: success | warning | danger |
info`) and `Notice`; from then on this table is those components' internals,
rule 3 applies (use the component, don't copy classes), and the status token
layer becomes a one-file change:

| Meaning | Badge | Banner (box) | Text only |
|---|---|---|---|
| success | `bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300` | `border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-900/20` | `text-green-700 dark:text-green-400` |
| warning | `bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300` | `border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-900/20` | `text-amber-700 dark:text-amber-400` |
| danger | `bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300` | `border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-900/20` | `text-red-600 dark:text-red-400` |
| info | `bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300` | `border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-900/20` | `text-blue-700 dark:text-blue-400` |

A status colour always comes with a word ("Draft", "Failed", "Watching") — never
colour alone. Unsaved changes are amber (`bg-amber-500` dot, as in the Settings
section list).

The `.status-chip` / `.hue-*` classes in `index.css` are for the **customer
portal and public pages**: they mix the hue into the operator's theme surface.
Do not use them in the admin.

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
5. **No lone neutrals in new code.** `text-neutral-400` without a pair renders
   the same in both modes and goes invisible on a dark panel. Use the token
   (`text-faint` for an icon at rest). Adding `dark:` to a lone neutral is not
   the fix: the lint rule rejects the pair it creates.

## Building blocks

Reach for these before writing markup. A missing variant is added to the
component, not re-created next to it.

| Need | Use | Notes |
|---|---|---|
| Button | `Button` (`common`) — `primary` / `secondary` / `outline` / `ghost`, `sm` / `md` / `lg`, `leftIcon`, `isLoading` | one `primary` per view; `ghost` for tertiary actions in toolbars and menus |
| Card / section box | `Card` (`common`), or `bg-panel border border-line rounded-xl p-5` for a settings section | |
| Text field | `Input` (`common`) — `label`, `error`, `leftIcon` | |
| Date | `LocalizedDateInput` | follows the general date format setting |
| Time | `TimeField` | |
| Money / decimals | `DecimalInput` | accepts `1,50` and `1.50`; `type="number"` does not |
| Loading | `Loading`, `Skeleton*` (`common`) | skeletons for lists and grids, `Loading` for a whole page |
| Confirm | `useConfirm()` (`ConfirmDialog`) — `variant: 'danger'` for destructive | never `window.confirm()` |
| Page header (section pages) | `SectionPageHeader` (`admin`) | icon, title, one-line description, actions |
| Settings save | `SettingsSaveBar` (`admin`) | see UX.md › Saving |
| Panes that scroll on their own | `useFillViewport()` (`admin/fillViewport`) | the page fills the window from `lg`; see Layout › Split views |
| Permission gate | `PermissionGate`, `usePermission`, `useAnyPermission`; route level `RequirePermission` | see UX.md › Permissions |
| Picker tile | `.tile-selected` on the chosen tile, `border-2 border-line` on the rest | |
| Hover help | `<span class="info-tooltip" data-tooltip="…">` for a hint on an icon | longer help goes under the field. A tooltip people should click (a status pill) follows `DraftPill` (`event-details/EventDetailsHeader.tsx`): a `<button>` with an `Info` icon (`w-3.5 h-3.5`), `info-tooltip info-tooltip-start`, its own open state for click/tap (Safari does not focus a clicked button), Escape and an outside click to close, and an `aria-label` with the same text. `info-tooltip-start` takes the bubble out of layout while closed and, on a phone, anchors it to the nearest `relative` row |

## Layout and spacing

- **Sizes come from the scale.** `gap-2` inside a control group, `gap-4`
  between fields, `space-y-4` inside a section, `space-y-6` / `gap-6`
  between cards. Don't invent `mt-[13px]`.
- **Radius:** `rounded-lg` for controls (buttons, inputs, menu items),
  `rounded-xl` for cards and sections, `rounded-full` for chips and dots.
- **Forms read in one column** up to `max-w-3xl`; pair short fields
  (`grid-cols-1 md:grid-cols-2`) only when they belong together (name +
  email, from + to).
- **Two-column overview pages:** content left, summary right —
  `grid-cols-1 xl:grid-cols-[minmax(0,1fr)_380px]`. Below `xl` it stacks.
- **Every flex row of controls wraps.** `flex flex-wrap gap-2`, and
  `min-w-0` on a growing input inside a row. German labels run 30–50 % wider
  than English; check the row in German at 390 px. In a banner (icon, text,
  action), the text and the action share a wrapping row beside the icon, so
  on a phone the button drops under the text, lined up with it (the expiry
  banner). Keep button labels short enough for a phone: `.btn` is
  `whitespace-nowrap` with a fixed height, so a long label overflows rather
  than wrapping. If one cannot be shortened, give that button
  `max-w-full h-auto whitespace-normal`.
- **No horizontal scroll** in the admin content area at any width. A grid
  child that must not grow gets `min-w-0`; a fixed `w-64` inside a grid cell
  becomes `w-full`.
- **Split views scroll by pane, not by page.** When two columns sit side
  by side (a list and the open item, like gallery Settings), the page head,
  the tabs and the save bar stay put and each column scrolls on its own
  under the tabs' line. Call `useFillViewport()` in the view; give the
  page root `lg:flex-1 lg:min-h-0 lg:flex lg:flex-col`, and each pane
  `lg:min-h-0 lg:overflow-y-auto` with its top and bottom gap as padding
  *inside* the pane (`lg:pt-6 lg:pb-8`), so content scrolls right up to the
  line. Below `lg` the page scrolls as one. Every box between `<main>` and
  the panes takes `lg:min-h-0`, never a `min-h-*` floor: a floor lets the
  panes overflow `<main>` on a short window, and the pinned save bar then
  covers their last rows.
- **Never size from the window by guessing the chrome.** No
  `h-[calc(100vh-6rem)]`: banners, the upload bar and the save bar come and
  go, so the guess is wrong somewhere. Let flex give the height
  (`flex-1 min-h-0`).
- **A row that scrolls sideways clips the other axis.** `overflow-x-auto`
  makes overflow-y `auto` too, so a child pulled 1px past the edge gives
  the row a vertical scrollbar on a Mac that shows scrollbars. Pair it with
  `overflow-y-hidden`, and then keep everything inside the row: a tab row
  draws its divider as an inset shadow (`shadow-[inset_0_-1px_0_var(--ui-line)]`)
  instead of a border with the tabs pulled over it by `-mb-px`, because
  the clip would cut that pixel off the active underline.
- **Columns side by side start on one line,** the first *item* on each side,
  not a group heading on one and a card on the other. Give the heading a
  fixed height from the scale (`h-4 leading-4 mb-2`) and offset the other
  column by the same amount (`mt-6`). An `sr-only` element inside a
  `space-y-*` list still counts as the first sibling and pushes the next
  one down; keep it outside the spaced wrapper.
- **Icons:** `lucide-react`, `w-4 h-4` in buttons and inline, `w-5 h-5` in
  card titles. Icon-only buttons need `aria-label`.

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
`hover:bg-neutral-200 dark:hover:bg-neutral-600` stays raw too: `hover` is the same value as `inset` in both modes, so rewriting it would take the hover feedback off every button that sits on an inset background.

## Tooling

| Command | What it does |
|---|---|
| `npm run lint` | includes `ui-tokens/no-raw-dark-palette` over the admin scope |
| `npm run codemod:ui-tokens` | applies that rule's autofix and nothing else |
| `npm run codemod:ui-tokens -- --check` | reports remaining pairs, exit 1 if any (use after a rebase) |

The pair table both tools read is `scripts/ui-tokens-map.mjs`.
