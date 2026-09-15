const { AppError } = require('./errors');
const { ensureInt } = require('./numericHelpers');

/**
 * Validate the hierarchy of a line-item payload BEFORE insert. Throws
 * AppError on:
 *   - duplicate positions
 *   - sub-item's parent_position not found in the payload
 *   - sub-item's parent is itself a sub-item (max 1 level deep)
 *   - circular reference (item references itself)
 *
 * Used by both quote + invoice services so the rules stay identical
 * across both flows (and so the quote→invoice cloner doesn't have to
 * re-validate).
 */
function validateLineItemHierarchy(lineItems) {
  if (!Array.isArray(lineItems) || lineItems.length === 0) return;
  const positions = new Set();
  const parentPositions = new Map(); // position → parent_position (or null)
  for (const li of lineItems) {
    const pos = ensureInt(li.position);
    if (!pos) {
      throw new AppError('Every line item must have a positive position', 400, 'LINE_ITEM_POSITION_REQUIRED');
    }
    if (positions.has(pos)) {
      throw new AppError(`Duplicate line item position: ${pos}`, 400, 'LINE_ITEM_POSITION_DUPLICATE');
    }
    positions.add(pos);
    const pp = li.parent_position == null || li.parent_position === '' ? null : ensureInt(li.parent_position);
    parentPositions.set(pos, pp);
  }
  for (const [pos, pp] of parentPositions) {
    if (pp == null) continue;
    if (pp === pos) {
      throw new AppError(`Line item ${pos} cannot be its own parent`, 400, 'LINE_ITEM_SELF_PARENT');
    }
    if (!parentPositions.has(pp)) {
      throw new AppError(`Sub-item ${pos} references missing parent position ${pp}`, 400, 'LINE_ITEM_PARENT_NOT_FOUND');
    }
    if (parentPositions.get(pp) != null) {
      throw new AppError(`Sub-item ${pos} cannot nest under another sub-item (max one level deep)`, 400, 'LINE_ITEM_NESTING_TOO_DEEP');
    }
  }
}

/**
 * Persist the editor's array order while preserving its stable row references.
 * Validate the original positions BEFORE replacing them: renumbering would hide
 * duplicates and can turn a missing parent into an unrelated, newly numbered row.
 * The same validator remains available to quote/invoice service callers.
 */
function renumberLineItemPositions(items) {
  if (!Array.isArray(items)) return items;

  const normalized = items.map((item, index) => ({
    ...item,
    position: ensureInt(item.position == null ? index + 1 : item.position),
    parent_position: item.parent_position == null || item.parent_position === ''
      ? null : ensureInt(item.parent_position),
  }));
  validateLineItemHierarchy(normalized);

  const newPositions = new Map(normalized.map((item, index) => [item.position, index + 1]));
  return normalized.map((item, index) => ({
    ...item,
    position: index + 1,
    parent_position: item.parent_position == null ? null : newPositions.get(item.parent_position),
  }));
}

module.exports = { renumberLineItemPositions, validateLineItemHierarchy };
