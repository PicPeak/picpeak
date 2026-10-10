# UX guide

How admin pages **behave**: structure, saving, permissions, states,
confirmations and copy. How they **look** is in [`STYLING.md`](STYLING.md).

Most of this is written down after the fact — rules that came out of reviews
and bugs. Each one says what to do, what not to do, and where it is already
done right, so a new page can copy a working example instead of this text.

**Reference implementation:** the gallery page,
`src/pages/admin/EventDetailsPage.tsx` and `src/pages/admin/event-details/`
(Overview / Photos / Guests & Feedback / Settings). When a rule here is
unclear, that page is the tie-breaker.

---

## 1. Page anatomy

An entity page (a gallery, a customer, a project) has the same parts in the
same order.

| Part | Contains | Example |
|---|---|---|
| Header | title with a pen to rename it, status badges; action row in the order `⋯` menu (its dropdown anchored right), external "View" link, then the primary action of the moment (Publish on a draft, Send gallery email, Full gallery is ready). Usually one; a draft awaiting its full gallery can show two, Publish and Full gallery is ready. Below `sm` the `⋯` menu moves onto the title row, pinned right, so View and the primary action fit side by side | `EventDetailsHeader.tsx` |
| Banners | state that blocks or warns: expiring, archived. A banner explains; the action it calls for lives in the header when the header has one. A state the header already shows as a pill gets no banner: the pill's tooltip explains it (a draft) | expiry banner with +7 days |
| Tabs | `Overview` first, `Settings` last | `EventTabs.tsx` |
| Tab body | see below | |

A feature that is not plain stable shows its state next to the page title
(New, Beta, Experimental), from the one feature-state list (STYLING.md ›
Feature state): `SectionPageHeader feature=…`. Never in the sidebar.

There is **no back link** on list and detail pages: they navigate by the
sidebar, where the list is on screen (#1730). Only an **editor** — a page
you can leave without saving — gets a named exit: **Cancel** back to the
record (or to the list when the record does not exist yet), or a named
"Back to …" when it autosaves and Cancel would be a lie. Below `lg` the
sidebar is a drawer, which is why editors get a named control rather than
relying on browser-back.

**Do**
- Sync the tab to `?tab=` and a sub-section to `?section=`, both read on mount
  and kept in step with back/forward. A copied URL opens the same view.
- Map retired tab names to their new home instead of breaking old links
  (`?tab=categories` opens Photos with the categories panel).
- Put secondary actions (duplicate, invoice, archive) in the `⋯` menu.
  Renaming is a pen next to the title, where the thing it changes is.
  Only actions the role can use are listed; an empty menu is not rendered.

**Don't**
- Don't build a separate "view" and "edit" page, or a view/edit toggle that
  renders every field twice. Read-only information goes on Overview; every
  setting goes in Settings, editable in place.
- Don't hide a tab's content behind a second level of tabs when a section
  list will do.

### Overview vs Settings

- **Overview** answers "what is this and what do I do now?": links, status,
  counts, the next actions. Nothing on it needs saving.
- **Settings** holds everything configurable, as a **split view**
  (`event-details/settings/EventSettingsTab.tsx`, issue 1765):
  - **Left, the overview:** every section as a row — icon, title, and one
    line of what it is set to now ("Password on · expires 31 Dec 2026",
    "External folder · watching"). Rows sit in small groups of two or three
    under a heading (Basics · Access & downloads · Guests · Photos &
    automation), so the list stays readable as it grows. A **Default** tag
    marks a section that only follows the global setting.
  - **Right, the open section,** edited in place: a header with its title and
    one line on what it covers, then the fields. No window, no second Save —
    the page draft and save bar stay as in § 2. Its card's top lines up with
    the first row of the list, not with the group heading above it.
  - **Side by side, the two halves scroll on their own,** under the tabs'
    line: the page header, the tabs and the save bar stay where they are
    (`useFillViewport` in `components/admin/fillViewport.ts`). On a display
    tall enough for both, nothing scrolls. Below `lg` the page scrolls as a
    whole, as everywhere else.
  - Order sections from most to least used. The destructive section ("Danger
    zone") is one full-width red row **after** the groups: it holds actions,
    not settings.
  - **Below `lg`** the overview is the page; tapping a row opens that section
    full-screen with a back arrow. Opening it adds a history entry, so the
    browser's Back returns to the overview as the arrow does, and focus goes
    back to the row. The open section is in the URL (`?section=`): a link to
    any section, General included, opens it; one the flags hide falls back to
    the overview.
  - Side by side, switching sections replaces the URL instead of adding to
    history, like the tabs. Nothing opened means General there.
  - This is not a second menu next to the sidebar (#1689): the rows describe
    **this record's** state, they are not places in the app. Global Settings,
    CRM and Accounting keep the sidebar.
- Overview may *summarise* a setting and link to its section ("Photo source:
  External folder · watched" → Settings › Photo source).

## 2. Settings vs actions — saving

The most important distinction in the admin.

| | A **setting** | An **action** |
|---|---|---|
| What it is | stored configuration | something that happens now |
| Examples | welcome message, download limit, reminder offset, slideshow style | publish, send email, extend +30 days, reset password, rescan, generate a link, upload a logo |
| How it saves | through the page's draft and **one** save bar | immediately, with its own button and toast |
| Can be discarded | yes | no (confirm first if it can't be undone) |

**The test for the grey zone:** a setting is anything persisted that can
later be changed back with no external side effect; anything that sends,
generates, publishes or deletes is an action. "Watch this folder" is a
setting; "Import now" is an action.

**Scope:** this applies to new and reworked pages. Existing pages that save
differently (6 of the 20 global settings tabs don't use the save bar yet)
migrate when they are touched — no big-bang rewrite.

**Do**
- Edit settings in a draft and save them through `SettingsSaveBar`. It shows
  the unsaved state, offers Save and Discard, and registers the leave guard
  (tab close and in-app navigation ask before dropping edits).
- Keep the draft at **page level**, so switching tabs never drops it, and
  register `useUnsavedChanges` there too (`EventDetailsPage.tsx`,
  `EventDetailsLoaded`).
- Mark dirty sections (amber dot and "not saved yet" on the section's row,
  a dot on the Settings tab) and name them in the save bar. The open section
  offers **Undo changes in this section**, which puts back only that
  section's fields (`resetSection`); Discard in the bar drops everything.
- Send **only what changed**. Build the request from the draft and from the
  server state the same way and send the difference (`settings/draft.ts`,
  `eventUpdatePayload`). Saving an untouched form writes nothing.
- When the server state changes underneath an edited draft (a refetch after
  an action elsewhere), take the new value for every **field** the admin has
  not touched (`rebaseDraft`). Otherwise the next save silently undoes the
  other change.
- When one save touches several endpoints, save each changed slice, keep the
  failed ones dirty, and name them in the error.
- Validate on Save and jump to the section with the problem.
- Ask before an action that navigates away from a dirty page
  (`useLeaveGuard().confirmLeave()` — e.g. Duplicate).

**Don't**
- Don't put an instant-save toggle or a per-card "Save" button inside a
  settings form. Mixed saving is how settings get lost.
- Don't put an action behind the save bar ("Extend" that only happens on Save).
- Don't hold a password in a draft after a successful save.

## 3. Permissions in the UI

The UI mirrors the backend; it is never the only gate.

**Do**
- Gate a control with the **same** permission(s) as its route:
  `requirePermission(['events.edit', 'events.support'])` ↔
  `useAnyPermission(['events.edit', 'events.support'])`. If they disagree the
  user gets a button that answers 403.
- Show settings the role can read but not change as **read-only**: a
  disabled `<fieldset>`, a one-line notice ("You can see these settings but
  not change them."), and no save bar.
- **Hide** actions the role can't perform at all (a `⋯` item, Rescan,
  Change folder).
- Respect ownership hints from the API: `share_secrets_hidden` means "you see
  this gallery but cannot act on it" — hide the actions that need ownership.
- Gate a whole page with `RequirePermission` on the route, and a query with
  `enabled:` when its endpoint needs a permission the user may lack.

**Don't**
- Don't gate on the role name. Gate on permissions; roles are editable.
- Don't show a disabled button with no explanation. Disabled needs a reason
  in reach (helper text, tooltip) — otherwise hide it.

## 4. States

Every data view has five states. Design all of them.

| State | Do | Reference |
|---|---|---|
| Loading | `Skeleton*` for lists/grids, `Loading` for a page; keep the layout's shape | `EventDetailsPage` |
| Empty | `EmptyState`: say what is missing and offer the next step ("No photos yet — Upload") | |
| Error | `ErrorState`: say it failed and offer **Retry**. Never fall through to the empty state — "couldn't load" and "there is nothing" are different messages | `PhotosTab.tsx` |
| Read-only | see §3 | `EventSettingsTab` |
| Archived / expired | banner + read-only; actions that still make sense stay (restore, extend) | |

**Do**
- Keep loaded data on a failed **background** refetch (TanStack keeps `data`
  and sets `isError`); only a failed first load shows the error state.
- Poll only while something is running, and stop when it isn't
  (`refetchInterval` returning `false` — processing photos, a folder import).

**Don't**
- Don't report a failed background job as a finished one. Persist the
  failure and show it ("The last import failed: …" + Try again).

## 5. Destructive and irreversible actions

**Do**
- Confirm with `useConfirm({ message, variant: 'danger' })`, and say what is
  lost in the message ("Delete "X" and all its photos? This cannot be undone.").
  Its confirm button is `Button variant="danger"`; use the same variant for
  a destructive button on a page.
- Put delete and archive in the Danger zone (Settings) and/or the `⋯` menu,
  never next to the primary action.
- Name the button after the action ("Delete gallery"), not "OK".

**Don't**
- Don't use `window.confirm()` / `confirm()` — it can't be styled, translated
  consistently or tested. (Some older pages still do; migrate them when you
  touch them.)
- Don't confirm reversible actions. Confirmation fatigue makes the real ones
  invisible.

## 6. Forms

**Do**
- Label every field (`<label htmlFor>` or the `label` prop); helper text
  goes under the field in `text-xs text-muted`.
- For a per-item override of a global default, use a **three-way choice**:
  "Inherit (current global value)", on, off — and store `null` for inherit,
  so a later global change still reaches the item. Show what "inherit"
  currently means in the option text.
- For an override of a whole group (a gallery's own theme), use **one
  switch**: off = follows the global setting, on = own values. Switching off
  keeps the own values, so switching on again restores them.
- Use the locale-aware inputs: `LocalizedDateInput`, `TimeField`,
  `DecimalInput` (accepts `1,50`), and display dates through
  `useLocalizedDate()` and money through `utils/money`.
- Pick-one-of-few with a description per option: tiles (`role="radio"`,
  `.tile-selected`), not a select.
- Pre-fill from defaults (gallery type, Event Defaults, Branding) and say so
  ("From the Wedding type default").

**Don't**
- Don't use `type="number"` for money or decimals.
- Don't silently store a copy of a global default on create — that freezes
  the item and later global changes never reach it.
- Don't use a select for two options; use a switch or two tiles.

## 7. Feedback and copy

**Do**
- Toast the outcome in past tense with the object: "Gallery email queued to
  sarah@example.com." Queued is not delivered — say queued, and say where to
  look if it doesn't arrive.
- On failure, show the server's message when there is one, else a specific
  fallback ("Rescan failed"), never just "Error".
- Write labels as what they do, not what they are: "Send gallery email",
  "Import now", "Change folder".
- Every string through `t('key', 'English fallback')`; the fallback must
  match `en.json`. New keys go into `en.json` **and** `de.json`.
- Say the same thing the same way across pages: one word per concept, used
  everywhere.
- **"Gallery" for everything the user sees.** "Event" stays only where it
  means the occasion ("Event date", "Event type"). Code, API, database and
  i18n **keys** keep `event` — rename values, never keys. The switch happens
  page by page inside the overhaul PRs, not as one big rename (`en.json`
  says "event" ~350 times; a mass rename would conflict with every open PR).

**Don't**
- Don't hard-code strings, and don't build sentences by concatenating
  translated fragments.
- Don't put explanations into toasts that the user needs later — put them
  under the control.

## 8. Layout, language, devices

See STYLING.md › Layout and spacing for the rules. The checks:

- German at 390 px and at desktop width: nothing overflows, every row wraps.
- Dark mode via tokens: toggle it and look at every new surface.
- Keyboard: every control reachable with Tab, menus and popups close on
  Escape (popups without saving, below) and on outside click, icon-only
  buttons have `aria-label`.
- The admin sidebar is a drawer below `lg`; don't remove a control on the
  assumption that "it's in the sidebar".

### Popups and dialogs close with Escape

Every popup — dialog, confirm, prompt, sheet, the gallery's own dialogs —
closes with **Escape, without saving**. Escape is Cancel: whatever was typed
into the dialog is dropped and nothing is sent. Use the primitives, which do
this already: `Modal`, `useConfirm`, `usePrompt` in the admin and portal,
`useGalleryDialog` for the gallery's themed dialogs.

- Escape closes only the **top** dialog. A confirm opened over a dialog
  closes the confirm and leaves the dialog open (they share one stack,
  `pushDialogLayer`).
- **While a request runs**, closing waits: Escape, the backdrop and the X do
  nothing until the save or upload has answered, so a half-sent change is
  never abandoned behind the user's back. Say so in the dialog (a busy
  button is enough).
- **A dialog that must be answered** — the mandatory password change — has
  no Escape, no X and no backdrop close. That is the only exception; it
  needs a reason in the code and in the PR body.
- Never make Escape save, and never put the only way out of a dialog
  behind a button that saves.

## 9. Removing or moving things

**Do**
- For every control you remove, write down where its function lives now
  (the PR body is the place). A pure deletion is still a UX change.
- Redirect retired routes to the new location (`/events/:id/feedback` →
  `?tab=guests`) instead of 404ing.
- Keep functions available to the roles that had them (feedback reading
  stayed `events.view` when it moved into a tab).

## 10. Review checklist

Run before opening a PR that touches the admin UI.

1. Does every control's permission match its route?
2. Is every setting behind the save bar, and every action outside it?
3. Does Save send only changed fields? Does a refetch keep the admin's edits
   and take everyone else's?
4. Loading, empty, error (with Retry), read-only — all handled?
5. Does a failed background job show as failed?
6. Destructive actions: `useConfirm` with `danger`, consequence in the text?
7. Any removed control — where did its function go? Old URLs redirected?
8. German at 390 px: does every row wrap? Dark mode: anything invisible?
   Does every new popup close with Escape without saving (UX.md § 8)?
9. New strings in `en.json` and `de.json`, inline fallbacks matching?
10. `npm run lint` (UI tokens and palette colours: no raw `text-red-600`, no
    hex in a style), `npm run build`, and before/after screenshots on the
    `pr-assets` branch (CONTRIBUTING.md) in light and dark.
11. **E2E selectors:** run the specs in `tests/e2e` that cover the page you
    changed. In specs, prefer `getByRole` and test ids over visible text —
    copy changes are what keep breaking the scheduled suite.
12. **New permission or route = more edits than the route file.** A new
    permission goes into the migration's role grants (and the boot preset
    list if a preset should hold it) as well as the route guard. A new route
    needs a decision in `docs/usage-coverage.v<current>.json`, or the backend
    inventory gate fails.
13. **PR hygiene:** no closing keywords ("Fixes #N") unless merging should
    close the issue; no `Refs #N` / bare `#N` in commit bodies
    (conventional-changelog turns them into closes — write "issue N");
    screenshots on `pr-assets`, never a branch of their own.
