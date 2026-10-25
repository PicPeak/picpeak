# Timestamp album selection — independent preparation for #2251

This branch prepares a pure metadata helper for [the album-generator proposal](https://github.com/PicPeak/picpeak/issues/2251). It is not wired into the application and does not implement a native album editor, layout generator, preview, automatic job, proof, checkout or supplier workflow. It does not alter #2222 or implement #48. Those integration boundaries still need agreement.

`backend/src/services/albumDrafts/timestampSelection.js` exports `selectTimestampPhotos(photos, { count: 80 })`. It has no database, filesystem, image, network or model dependency. The helper accepts a target of 1–100; an eventual client action can restrict its album target to the proposed 50–100 range. An eligible gallery smaller than the target yields fewer photos.

Each input record contains:

- `id`: a stable, non-empty string. An eventual adapter converts native IDs explicitly.
- `captureTimeMs`: a comparable, valid integer epoch-millisecond value, or null/omitted when the time is unavailable or ambiguous.
- `mustUse` and `excluded`: optional booleans. Exclusion takes precedence. Excess eligible must-use photos cause an error rather than silent removal.

The caller must resolve timestamp provenance and camera clocks before supplying times. This helper does not parse date strings, assume a host time zone, use upload time as capture time or infer that cameras agree. Native `captured_at` exists, but legacy numeric/string/Date forms and unrecorded clock offsets require a deliberate integration adapter. Ambiguous timestamps must reach this helper as null, not as invented UTC values. No such adapter is claimed by this preparatory change.

With complete, varying times, the selector sorts chronologically (stable string-ID tie breaks), retains range endpoints when priorities leave room and fills the largest uncovered distances. Ordinal distance breaks equal-distance ties. A single suggestion uses the nearest time midpoint unless a must-use photo occupies it. Any missing eligible time switches the whole run to the supplied array order; identical times also use that fallback. The report identifies the strategy version, fallback reason and counts. Identical duplicate identities collapse; conflicting duplicate metadata is rejected.

Time coverage does not recognise wedding moments, quality, expressions or visual duplicates and may over-represent quiet periods. It is a suggestion for photographer review. The input array/records remain unchanged. Store the returned IDs, strategy/settings and source-set identity in a new draft revision only after that draft/review contract is agreed; never overwrite hand edits or treat selection as approval.

Work is bounded by sorting plus O(photos × target) comparisons and O(photos) storage. Only metadata is processed; this says nothing about preview/export rendering costs. The synthetic 2,000-record fixture verifies reproducibility, priorities, exclusions, unique output and chronological order. Do not present it as a benchmark of the full workflow on ARM64.

Future routes must enforce gallery/media access and retention, and future jobs must handle revisions, retry and cancellation independently. This helper deliberately has no authority to publish, approve, charge or send anything to a lab.
