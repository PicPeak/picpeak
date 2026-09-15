/**
 * Unit tests for renumberLineItemPositions (#1452).
 *
 * The editors keep `position` as a stable row id (`LineItemsTable` never
 * renumbers a row), so the payload's array order is the display order. These
 * tests pin the pure renumbering + the parent remap that makes a reorder
 * survive a save:
 *
 *   - reordered top-level items,
 *   - reordered sub-items inside one parent,
 *   - a moved parent whose sub-items must follow it.
 *
 * Fast, no database: the route wiring is covered by
 * __tests__/integration/lineItemOrder.test.js.
 */
const { renumberLineItemPositions } = require('../../src/utils/lineItemPositions');

describe('renumberLineItemPositions', () => {
  it('numbers positions 1..n in array order (reordered top-level items)', () => {
    const out = renumberLineItemPositions([
      { position: 3, description: 'Album' },
      { position: 1, description: 'Studio shooting' },
      { position: 2, description: 'Retouching' },
    ]);
    expect(out.map((li) => li.description)).toEqual(['Album', 'Studio shooting', 'Retouching']);
    expect(out.map((li) => li.position)).toEqual([1, 2, 3]);
  });

  it('leaves an already ordered payload in place', () => {
    const out = renumberLineItemPositions([
      { position: 1, description: 'A', parent_position: null },
      { position: 2, description: 'B', parent_position: null },
    ]);
    expect(out.map((li) => li.position)).toEqual([1, 2]);
    expect(out.map((li) => li.description)).toEqual(['A', 'B']);
    expect(out.map((li) => li.parent_position)).toEqual([null, null]);
  });

  it('keeps a moved parent\'s sub-items attached and remaps their parent_position', () => {
    // Editor order after the parent moved to the top:
    //   parent (row id 2) with its two sub-items (row ids 4 and 5).
    const out = renumberLineItemPositions([
      { position: 2, description: 'Package' },
      { position: 4, description: 'Camera', parent_position: 2 },
      { position: 5, description: 'Lens', parent_position: 2 },
      { position: 1, description: 'Travel' },
    ]);
    expect(out.map((li) => li.position)).toEqual([1, 2, 3, 4]);
    const parent = out.find((li) => li.description === 'Package');
    const subItems = out.filter((li) => li.description === 'Camera' || li.description === 'Lens');
    expect(parent.position).toBe(1);
    // Both sub-items point at the parent's NEW position, not the old row id.
    expect(subItems.map((li) => li.parent_position)).toEqual([1, 1]);
  });

  it('renumbers reordered sub-items inside the same parent', () => {
    const out = renumberLineItemPositions([
      { position: 1, description: 'Package' },
      { position: 3, description: 'Lens', parent_position: 1 },
      { position: 2, description: 'Camera', parent_position: 1 },
    ]);
    expect(out.map((li) => [li.position, li.description])).toEqual([
      [1, 'Package'],
      [2, 'Lens'],
      [3, 'Camera'],
    ]);
    expect(out[1].parent_position).toBe(1);
    expect(out[2].parent_position).toBe(1);
  });

  it('does not renumber in place — the input stays untouched', () => {
    const items = [
      { position: 3, description: 'Album' },
      { position: 1, description: 'Studio shooting' },
    ];
    renumberLineItemPositions(items);
    expect(items.map((li) => li.position)).toEqual([3, 1]);
  });

  it('normalises a missing, null or empty parent_position to null', () => {
    const out = renumberLineItemPositions([
      { position: 1, description: 'A' },
      { position: 2, description: 'B', parent_position: null },
      { position: 3, description: 'C', parent_position: '' },
    ]);
    expect(out.map((li) => li.parent_position)).toEqual([null, null, null]);
  });

  it.each([1, 42])('rejects a missing parent %i before it can alias a new position', (parent) => {
    expect(() => renumberLineItemPositions([
      { position: 10, description: 'A' },
      { position: 20, description: 'Orphan', parent_position: parent },
    ])).toThrow(expect.objectContaining({ code: 'LINE_ITEM_PARENT_NOT_FOUND' }));
  });

  it.each([
    [{ position: 10 }, { position: 10 }],
    [{ position: '10' }, { position: 10 }],
    [{ position: 2 }, {}],
  ])('rejects duplicate original or defaulted positions in %j', (...items) => {
    expect(() => renumberLineItemPositions(items))
      .toThrow(expect.objectContaining({ code: 'LINE_ITEM_POSITION_DUPLICATE' }));
  });

  it('preserves numeric string parent references and does not mutate the input', () => {
    const items = [
      Object.freeze({ position: '10', description: 'Parent' }),
      Object.freeze({ position: '20', parent_position: '10', details_text: 'Keep me' }),
    ];
    const out = renumberLineItemPositions(Object.freeze(items));
    expect(out[1]).toEqual({ position: 2, parent_position: 1, details_text: 'Keep me' });
    expect(items[1].parent_position).toBe('10');
  });

  it('rejects self-parenting', () => {
    expect(() => renumberLineItemPositions([{ position: 10, parent_position: 10 }]))
      .toThrow(expect.objectContaining({ code: 'LINE_ITEM_SELF_PARENT' }));
  });

  it('rejects nesting under a child', () => {
    expect(() => renumberLineItemPositions([
      { position: 10 }, { position: 20, parent_position: 10 }, { position: 30, parent_position: 20 },
    ])).toThrow(expect.objectContaining({ code: 'LINE_ITEM_NESTING_TOO_DEEP' }));
  });

  it('gives a row with no position the position its array order implies', () => {
    const out = renumberLineItemPositions([
      { description: 'A' },
      { description: 'B' },
    ]);
    expect(out.map((li) => li.position)).toEqual([1, 2]);
  });

  it('is a no-op on non-array input', () => {
    expect(renumberLineItemPositions(null)).toBeNull();
    expect(renumberLineItemPositions(undefined)).toBeUndefined();
  });

  it('handles an empty payload', () => {
    expect(renumberLineItemPositions([])).toEqual([]);
  });
});
