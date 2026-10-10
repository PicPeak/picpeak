# Styling guide

One place decides how PicPeak looks: **`src/styles/tokens.css`**. Every
colour in the app is a token there — greys, the accent, the status colours,
the data colours. Change a value and every card, badge, banner, chart and
heading follows, admin and public pages alike. The studio changes the
accent, the gallery palette and the status colours in **Branding › Colours**;
those override the `tokens.css` defaults at runtime. This document explains
what is in that file, how components consume it, and the rules that keep it
the single source.

This file is about **how things look**. How pages behave — page structure,
saving, permissions, states, confirmations, copy — is in [`UX.md`](UX.md).
Read both before building or reworking an admin surface.

## The token families

PicPeak has two audiences with different owners, so its greys come in two
families. The colours that carry meaning are shared.

| Family | Prefix | Who sets the values | Where it is used |
|---|---|---|---|
| **UI tokens** | `--ui-*` | developers, in `tokens.css` | admin panel and every other developer-owned surface |
| **Theme tokens** | `--color-*` | the operator, through Branding › Colours | public gallery, customer portal, public quote/contract pages |
| **Status** | `--status-*` → `--ui-<status>-*` | `tokens.css` defaults, the operator overrides them in Branding › Colours | badges, notices and status chips everywhere |
| **Accent** | `--ui-accent*` | the operator's accent from Branding | primary buttons, active tabs, selections, links, focus rings |
| **Data colours** | `--chart-1` … `--chart-8`, `--color-rating` | developers, in `tokens.css` | charts, calendar entries, categories, rating stars |

The theme tokens are overwritten at runtime: `ThemeContext.applyTheme()`
writes the operator's palette as inline `--color-*` styles on `<html>`, on
every non-gallery page too. That is why **admin code must never read a theme
token**. A `bg-surface` in the admin turns beige the moment an operator picks
a warm gallery theme, and a `var(--shadow-default)` on a card gives the admin
the gallery's shadow (which is exactly what happened before PR 1691).

Dark mode is a class: `AdminDarkModeContext` toggles `.dark` on `<html>`, and
`tokens.css` redefines every UI token under `.dark`. A component written with
the token utilities therefore needs **no `dark:` variants at all**. Two
helpers ride on the same blocks:

- `.ui-light` / `.ui-dark` pin a subtree to the light or dark admin palette
  whatever the page mode (Branding's colour preview shows both side by side).
- `.admin-ui` sits on `<html>` while the admin is mounted
  (`AdminDarkModeProvider`). Shared classes read it to pick the UI tokens over
  the operator's gallery theme: `.btn-secondary`, `.btn-outline` and the
  `--shared-fill` / `--shared-surface` that `Skeleton` uses. Dialogs
  portalled to `<body>` get it too.

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
Branding. It reaches the admin as these tokens:

| Utility / class | Token | Use for |
|---|---|---|
| `<Button variant="primary">` (`.btn-primary`) | `--ui-accent-strong` + `--ui-accent-fg` | the primary action (one per view) |
| `text-accent` | `--accent-text` (the accent made readable as text on its surface: `--color-accent-text` on themed pages, `--ui-accent-text-light/-dark` in the admin; written by `applyTheme`) | links, active tab and nav item text |
| `border-accent` / `ring-accent` | `--color-accent` | active tab underline, focus rings |
| `.tile-selected` | `--ui-accent-strong` + `--ui-accent-fg` | the chosen option in a picker grid (layout, source, preset) |
| `bg-accent-soft` + `text-on-accent-soft`, `border-accent-soft` | `--ui-accent-soft`, `--ui-accent-on-soft`, `--ui-accent-line` | soft highlight: a selected list row, an enabled feature icon |
| `bg-accent-strong`, `text-accent-fg` | `--ui-accent-strong`, `--ui-accent-fg` | a filled accent area that is not a button (a switch that is on) |

Never put accent text on an accent tint (`text-accent` on `bg-accent-soft`):
it disappears on dark themes. Content on the tint takes `text-on-accent-soft`.

Contrast is handled where the colour is set: `applyTheme()` writes
`--color-accent-dark-fg`, white or near-black, whichever reads on the filled
accent, so a pastel brand colour keeps a readable button label. Branding ›
Colours warns when the accent itself is hard to see.

### Status colours

One hue per meaning, in `tokens.css` › Status, overridable in Branding ›
Colours. Every other shade is derived from the hue with `color-mix`, for
light and dark, so a studio picks five colours and never twenty.

| Status | Default | Means |
|---|---|---|
| `success` | `#16a34a` | paid, signed, published, done |
| `warning` | `#d97706` | due soon, draft, pending, not saved yet |
| `danger` | `#dc2626` | overdue, failed, delete |
| `info` | `#2563eb` | sent, in progress, neutral notices |
| `storno` | `#9333ea` | cancelled and credited documents |

Use the components: `<Badge tone="…">` for a pill, `<Notice tone="…">` for a
box. Where a component does not fit, the utilities are:

| Utility | Token | Use for |
|---|---|---|
| `bg-<status>` | `--ui-<status>` | a dot, a filled area, an icon on its own |
| `text-<status>-text` | `--ui-<status>-text` | text in the status colour on a panel |
| `bg-<status>-soft` | `--ui-<status>-soft` | the tint behind a badge or a notice |
| `border-<status>-line` | `--ui-<status>-line` | a notice's border |

A status colour always comes with a word ("Draft", "Failed", "Watching") — never
colour alone. Unsaved changes are the warning colour (`bg-warning` dot, as in
the Settings section list and the tab row).

The customer portal and public pages use `.status-chip` with a `.hue-*`
class: it mixes the same `--status-*` hue into the operator's themed surface.

### Data colours

For things that only need to look different from each other — chart series,
calendar entries, categories, notification and activity icons, workflow
nodes — use `chart-1` … `chart-8` in order (`bg-chart-3`, `text-chart-3`,
`var(--chart-3)` where a library wants a CSS value). They are lighter in
dark mode. Never use a status colour for a series: green would read as
"good". Rating stars are `text-rating` / `fill-rating`, not the warning
colour.

### Colour classes

Raw Tailwind palette classes (`text-red-600`, `bg-primary-50`, `border-blue-200`)
are not used anywhere in `src`: the lint rule `ui-tokens/no-raw-palette`
rejects them. The old fixed green `primary-*` scale and the `sand` scale are
gone from `tailwind.config.js`. `npm run codemod:ui-tokens` rewrites the
classes whose meaning is clear:

| Raw | Token |
|---|---|
| green / emerald | `success` |
| amber | `warning` |
| red / rose | `danger` |
| blue / sky | `info`; blue text with its own hover colour is a link: `text-accent` |
| primary | the accent (`bg-accent-strong`, `text-accent`, `bg-accent-soft`, `border-accent`) |
| any hue in `focus:` / `focus-visible:` rings and borders | `ring-accent` / `border-accent` |

By shade: 50–200 backgrounds become `-soft`, 500–700 backgrounds the solid
colour (a hover on them `hover:opacity-90`), 600+ text `-text`, 100–300
borders `-line`. The `dark:` partner is dropped. Other hues (purple,
orange, yellow, indigo, teal, pink …) have no fixed meaning; the rule
reports them and a person picks a status, a data colour, the rating colour
or a neutral.

Hex values in components are for data only: theme presets, the colour
labels that match Lightroom, a user-pickable palette, signature ink. Styling
reads a token, in a `style` too (`var(--chart-1)`).

## Theme tokens: customer portal and public pages

The customer portal, the quote, contract and payment-check pages, the
invite, legal, transfer and maintenance pages follow the operator's palette.
They use the theme utilities, never a neutral class or a `dark:` variant:

| Utility | Token | Use for |
|---|---|---|
| `bg-background` | `--color-background` | the page floor |
| `bg-surface` | `--color-surface` | cards, sidebar, header |
| `bg-elevated` | `--color-elevated` | wells and quiet boxes on a card, hover on a row |
| `border-border-token`, `divide-border-token` | `--color-surface-border` | card borders, dividers |
| `text-theme` | `--color-text` | running text, headings |
| `text-muted-theme` | `--color-muted-text` | secondary text, icons at rest |
| `text-accent`, `bg-accent-strong text-accent-fg` | accent | links; a filled action that is not a `Button` |
| `.input-themed`, `<Input themed>` | surface, border, text | every field: input, select, textarea, DecimalInput |
| `.status-chip` + `.hue-<status>` | status hue over the surface | status pills |

`border-surface` is **not** the border: Tailwind's `surface` colour turns it
into `--color-surface`, which wins over the class in `index.css`. Use
`border-border-token`.

Every such page calls **`usePublicDarkMode()`** (the portal through
`CustomerLayout`). While one is mounted, `<html>` carries `.public-ui`, and
`tokens.css` maps the UI tokens onto the theme tokens there. That is what lets
the shared primitives — `Notice`, `EmptyState`, `ErrorState`, `Modal`,
`useConfirm`, `Card`, `Input`, `Loading` — and the status utilities
(`bg-danger-soft`, `text-success-text`) sit on the studio's surface, dialogs
portalled to `<body>` included. The hook also sets `.dark` when the palette
itself is dark (read from its background colour, after Branding's force-colour
mode), so the status shades flip with it; both classes come off when the last
such page unmounts. Never put `.dark` on an element below `<html>`: there the
`.dark` defaults in `tokens.css` would replace the operator's colours for
everything inside it.

Paper stays paper: the signature pad and the typed-signature preview are
white with dark ink in every theme.

The setup wizard is PicPeak's own screen, shown before any branding exists:
it uses the UI tokens.

## Rules for admin code

1. **No neutral light/dark pairs.** `text-neutral-500 dark:text-neutral-400`
   is `text-muted`. The lint rule `ui-tokens/no-raw-dark-palette` fails the
   build on any pair that has a token, and `npm run codemod:ui-tokens`
   rewrites them for you.
2. **No theme tokens or theme utilities.** `bg-surface`, `text-theme`,
   `text-muted-theme`, `var(--color-*)` and `var(--shadow-default)` belong to
   the gallery, portal and public pages only. The `brandingThemeTextLeak`
   test guards the headings that were bitten by this.
3. **Prefer the primitives.** `Button`, `Badge`, `Notice`, `Modal`, `Tabs`,
   `Table`, `Switch`, `EmptyState`, `ErrorState`, `Card`, `Input`, `Loading`,
   `Skeleton`, `ConfirmDialog` in `src/components/common` already carry the
   tokens. A hand-rolled `<button className="px-3 py-2 rounded-lg bg-panel …">`
   is a sign that a variant is missing from `Button`; add the variant instead.
4. **New colour, new token.** If a design needs a shade that is not in the
   tables above, add a token to `tokens.css` (light and dark), expose it in
   `tailwind.config.js`, and document it here. Do not reach for
   `neutral-350` or a hex value in a component. Raw palette classes fail
   `ui-tokens/no-raw-palette`.
5. **No lone neutrals in new code.** `text-neutral-400` without a pair renders
   the same in both modes and goes invisible on a dark panel. Use the token
   (`text-faint` for an icon at rest). Adding `dark:` to a lone neutral is not
   the fix: the lint rule rejects the pair it creates.

## Building blocks

Reach for these before writing markup. A missing variant is added to the
component, not re-created next to it.

| Need | Use | Notes |
|---|---|---|
| Button | `Button` (`common`) — `primary` / `secondary` / `outline` / `ghost` / `danger`, `sm` / `md` / `lg` / `icon-sm` / `icon-md`, `leftIcon`, `isLoading` | one `primary` per view; `ghost` for tertiary actions in toolbars and menus; `danger` for destructive actions (confirm first); icon sizes need `aria-label` |
| Status pill | `Badge` (`common`) — `tone`, `appearance="outline"`, `caps`, `dot` | "Paid", "Draft", "Default"; always a word. Portal and public pages: `.status-chip .hue-<status>` |
| Notice / banner | `Notice` (`common`) — `tone`, `title`, `action`, `size="sm"` | explains a state; its action shares a wrapping row with the text |
| Dialog window | `Modal` (`common`) — `title`, `description`, `footer`, `size` | Escape closes without saving (UX.md › Popups and dialogs), focus stays inside and returns to the opener; a sheet on a phone. A yes/no question is `useConfirm()` |
| Tab row | `Tabs` (`common`) — `items` with `icon`, `count`, `dirty` | arrow keys move; the divider is an inset shadow |
| List table | `Table`, `TableHead`, `TableBody`, `TableRow`, `TableHeaderCell`, `TableCell` (`common`) | the table scrolls sideways inside its card, never the page; `SortableHeader` goes inside a header cell |
| On / off | `Switch` (`common`) — `label`, `description` | changes the draft, saves with the save bar |
| Nothing here yet | `EmptyState` (`common`) | say what is missing, offer the next step |
| Loading failed | `ErrorState` (`common`) — `onRetry` | never the empty state |
| Feature state | `FeatureStatusBadge` (`features/featureStatus`), or `feature=` on `SectionPageHeader` | see Feature state below |
| Card / section box | `Card` (`common`), or `bg-panel border border-line rounded-xl p-5` for a settings section | |
| Text field | `Input` (`common`) — `label`, `error`, `leftIcon`, `themed` | `themed` on portal, public and gallery pages: field, label and icons read the theme tokens (`.input-themed`); a raw `<select>` / `<textarea>` there takes `.input-themed` |
| Date | `LocalizedDateInput` | follows the general date format setting |
| Time | `TimeField` | |
| Money / decimals | `DecimalInput` | accepts `1,50` and `1.50`; `type="number"` does not |
| Loading | `Loading`, `Skeleton*` (`common`) | skeletons for lists and grids, `Loading` for a whole page |
| Confirm | `useConfirm()` (`ConfirmDialog`) — `variant: 'danger'` for destructive | never `window.confirm()` |
| Page header (section pages) | `SectionPageHeader` (`admin`) | icon, title, one-line description, actions; `feature="quotes"` adds the feature's state label |
| Settings save | `SettingsSaveBar` (`admin`) | see UX.md › Saving |
| Panes that scroll on their own | `useFillViewport()` (`admin/fillViewport`) | the page fills the window from `lg`; see Layout › Split views |
| Permission gate | `PermissionGate`, `usePermission`, `useAnyPermission`; route level `RequirePermission` | see UX.md › Permissions |
| Picker tile | `.tile-selected` on the chosen tile, `border-2 border-line` on the rest | |
| Hover help | `<span class="info-tooltip" data-tooltip="…">` for a hint on an icon | longer help goes under the field. A tooltip people should click (a status pill) follows `DraftPill` (`event-details/EventDetailsHeader.tsx`): a `<button>` with an `Info` icon (`w-3.5 h-3.5`), `info-tooltip info-tooltip-start`, its own open state for click/tap (Safari does not focus a clicked button), Escape and an outside click to close, and an `aria-label` with the same text. `info-tooltip-start` takes the bubble out of layout while closed and, on a phone, anchors it to the nearest `relative` row |

## Feature state

How far along a feature is, from one list:
`src/features/featureStatus/registry.ts`. Change a feature's state there and
nowhere else.

| State | Label | Means |
|---|---|---|
| `stable` | none | done |
| `stable` with `newSince` | **New** (green) | released; the label shows for 30 days after the date, then disappears on its own |
| `beta` | **Beta** (amber) | in development: ready for real work, details may still change |
| `experimental` | **Experimental** (red) | may break or be removed; not for a production studio |
| `roadmap` | **Roadmap** (grey outline) | not built yet; its toggle stays locked |

The label shows on the Settings › Features card and on the feature's own page
header (`SectionPageHeader feature=…`, or `FeatureStatusBadge` next to a
hand-written title), and on the customer record's portal tabs. **Never in the
sidebar.** A customer-portal tab that is not a feature of its own gets a
registry entry of its own (`portalCalendar`).

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
- Status colours: edit the five `--status-*` hues; text, tints and borders
  follow in both modes. Keep `src/utils/statusColors.ts`
  (`DEFAULT_STATUS_COLORS`) and `backend/src/utils/statusColors.js` in step.
  A studio overrides them in Branding › Colours.
- Data colours: edit `--chart-*` (light on `:root`, dark under `.dark`).
- Corner radius or shadow depth: edit `--radius-*` / `--shadow-*`.
- The default gallery theme: edit the `--color-*` defaults, and keep
  `src/types/theme.types.ts` (the preset the operator sees) in step.

Documents and emails follow Branding › Colours too, for the accent only:
a PDF's title and headings and an email's buttons, links and info-box rule
take the brand's filled accent unless the PDF theme or Settings → Email sets
their own. Their greys stay tuned for paper and mail clients.

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
  side with a neutral dark side. The status and accent codemod has since
  mapped their coloured side.
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

The colour sweep (status, accent, data colours) rewrote 1,342 class lists by
codemod and about 200 classes by hand. Lone neutral classes are still the
per-component decision described above.

## Tooling

| Command | What it does |
|---|---|
| `npm run lint` | includes `ui-tokens/no-raw-dark-palette` (admin scope) and `ui-tokens/no-raw-palette` (all of `src`) |
| `npm run codemod:ui-tokens` | applies both rules' autofixes and nothing else; reports the classes a person has to decide |
| `npm run codemod:ui-tokens -- --check` | reports what is left, exit 1 if anything (use after a rebase) |

The tables the tools read are `scripts/ui-tokens-map.mjs` (neutral pairs) and
`scripts/ui-palette-map.mjs` (palette colours).
