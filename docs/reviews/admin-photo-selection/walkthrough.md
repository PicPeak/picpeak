# Admin photo selection: implementation and validation

## Problem and reproduction

Changing a photo filter could leave IDs from the previous view attached to
Export and bulk actions. The grid owned its selection and sent a separate
copy to `PhotosTab` for Export; neither selection was scoped to most filters.

Two paths exposed the problem:

1. Select a photo, then enter a filename search with no matches. While the
   uncached query loaded, the grid unmounted and lost its selection, but Export
   retained the previous photo IDs.
2. Visit a filename search, clear it, select photos, then return to the cached
   search. The grid could remain mounted and retain IDs for photos absent from
   the result. Delete Selected could therefore target off-screen photos.

The existing visibility-specific reset covered visibility changes, but not
filename, category, feedback or other photo filters.

## Implementation

[`PhotosTab.tsx`](../../../frontend/src/pages/admin/event-details/PhotosTab.tsx)
now owns the selection used by both Export and
[`AdminPhotoGrid.tsx`](../../../frontend/src/components/admin/AdminPhotoGrid.tsx).
The grid accepts an optional controlled selection and reports changes through
its existing callback. Without that property, its standalone selection
behavior remains available.

The selection is scoped to the event ID and both filter objects using
TanStack Query's deterministic `hashKey`. Sort field and direction are excluded:

- A filter or event change clears the entire selection, including photos that
  would still match the new view.
- Changing only the sort field or direction preserves selected IDs, whether
  the query is cached or briefly replaces the grid with a loading indicator.
- A successful refresh removes selected IDs no longer present in the list,
  while retaining the remaining selections. A failed query clears selection.
- Returning to an earlier filter view does not restore its previous selection.

Selection state is adjusted before rendering children, so Export does not
receive IDs from a previous view while a new filter is loading. The grid's
React key uses the same event/filter scope to reset its shift-click anchor and
selection mode. Sorting does not change that key.

This change does not alter API filtering, authorization, deletion semantics or
the filter-only export request format. It requires no migration or dependency.

## Validation

The loading-search and cached-search regression tests failed on unchanged main
before the fix. The final focused run passed **63 tests across 11 files**:

```sh
cd frontend
npx vitest run --maxWorkers=2 \
  src/pages/admin/__tests__/eventDetailsPhotosTab.test.tsx \
  src/components/admin/__tests__/AdminPhotoGrid.*.test.tsx
```

Coverage includes selection clearing during loading and cached transitions,
category/feedback changes, the existing visibility workflow, export and
bulk-delete request IDs, preserved sorting selections, refetch pruning, and
the existing grid action and shift-selection suites.

Chromium with synthetic photos and mocked API responses reproduced the old
cached-search behavior, confirmed the cleared selection after filtering,
preserved a new selection through cached and uncached sorting, and verified
that export and deletion requested only the newly selected photo ID. No page
errors occurred. The PR description includes before/after screenshots.
This browser check does not exercise a live backend, database or deployment.

Full frontend lint passed with existing warnings. A standalone type check
reports the existing eight diagnostics addressed by the separate frontend
TypeScript repair. With that repair applied, a forced type check and
`npm run build:check` passed. The two code changes can be reviewed and merged
independently.
