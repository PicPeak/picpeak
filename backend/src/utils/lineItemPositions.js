/**
 * Line-item display order, shared by the quote and invoice editors (#1452).
 *
 * `LineItemsTable` in the frontend treats `position` as a stable row
 * identifier: its header promises "once assigned at row creation we never
 * renumber it", and `move()` only reorders the array. Both editors therefore
 * post each row's original `position` back on save, the service stores it
 * verbatim, and the detail endpoints read the items back
 * `ORDER BY position` — which is how a reorder could look right in the editor
 * and come back in the original order after a reload.
 *
 * The payload's array order is the order the user arranged, so that is the
 * order that gets stored: `position` is renumbered 1..n, and every
 * `parent_position` is rewritten through the same old -> new map so a moved
 * parent keeps its sub-items attached.
 *
 * A `parent_position` that names a position absent from the payload is left
 * untouched, so the service's `validateLineItemHierarchy` still reports it as
 * a missing parent instead of this helper silently re-parenting the row onto
 * whatever item happens to end up on that number.
 *
 * @param {Array<object>} items line items in display order, carrying
 *   `position` and optionally `parent_position`
 * @returns {Array<object>} new items, `position` 1..n and `parent_position`
 *   remapped; the input array is not mutated
 */
function renumberLineItemPositions(items) {
  if (!Array.isArray(items)) return items;

  const renumberedByOldPosition = new Map();
  items.forEach((item, index) => {
    renumberedByOldPosition.set(Number(item.position), index + 1);
  });

  return items.map((item, index) => {
    const parentPosition = item.parent_position == null || item.parent_position === ''
      ? null
      : Number(item.parent_position);
    const renumberedParent = parentPosition == null || !renumberedByOldPosition.has(parentPosition)
      ? parentPosition
      : renumberedByOldPosition.get(parentPosition);
    return { ...item, position: index + 1, parent_position: renumberedParent };
  });
}

module.exports = { renumberLineItemPositions };
