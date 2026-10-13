import type React from 'react';

/**
 * Arrow keys for the hand-built ARIA widgets (`role="tree"`,
 * `role="radiogroup"`). Both read the rendered DOM, so the components keep
 * their own markup and state.
 */

const TREE_ITEM = '[data-tree-item]:not(:disabled)';

// Alt+Left is the browser's Back, Cmd/Ctrl+arrows belong to the OS and the
// browser: the widgets only take the bare keys.
const hasModifier = (e: React.KeyboardEvent) => e.altKey || e.metaKey || e.ctrlKey;

/**
 * Keyboard for a folder tree. Each row's main button carries
 * `data-tree-item`, `data-key`, `data-parent` (the parent's key, '' at the
 * top) and, when it has children, `data-expanded="true" | "false"`. Put the
 * handler on the element with `role="tree"`.
 *
 * Up / Down move between visible rows, Home / End to the first / last,
 * Right opens a closed row or moves into an open one, Left closes an open
 * row or moves to its parent. Enter and Space are the buttons' own click.
 */
export function treeKeyDown(
  e: React.KeyboardEvent<HTMLElement>,
  { expand, collapse }: { expand: (key: string) => void; collapse: (key: string) => void },
): void {
  if (hasModifier(e)) return;
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(TREE_ITEM));
  const current = (e.target as HTMLElement).closest<HTMLElement>('[data-tree-item]');
  const index = current ? items.indexOf(current) : -1;
  if (index < 0) return;
  const key = current!.dataset.key || '';
  const expanded = current!.dataset.expanded;
  let next: HTMLElement | undefined;
  switch (e.key) {
    case 'ArrowDown': next = items[index + 1]; break;
    case 'ArrowUp': next = items[index - 1]; break;
    case 'Home': next = items[0]; break;
    case 'End': next = items[items.length - 1]; break;
    case 'ArrowRight':
      if (expanded === 'false') { e.preventDefault(); expand(key); return; }
      if (expanded === 'true') next = items.find((el, i) => i > index && el.dataset.parent === key);
      break;
    case 'ArrowLeft':
      if (expanded === 'true') { e.preventDefault(); collapse(key); return; }
      next = items.find((el) => el.dataset.key === current!.dataset.parent && current!.dataset.parent !== '');
      break;
    default:
      return;
  }
  e.preventDefault();
  next?.focus();
}

/**
 * Keyboard for a radio group made of buttons (`role="radio"`): the arrow
 * keys move to the previous / next option and pick it, wrapping at the ends,
 * as a native radio group does. Pair with `tabIndex={checked ? 0 : -1}` on
 * each option so Tab enters the group once. Put the handler on the element
 * with `role="radiogroup"`.
 */
export function radioGroupKeyDown(e: React.KeyboardEvent<HTMLElement>): void {
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
  if (!step || hasModifier(e)) return;
  const radios = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]:not(:disabled)'));
  const index = radios.indexOf((e.target as HTMLElement).closest<HTMLElement>('[role="radio"]')!);
  if (index < 0 || radios.length === 0) return;
  e.preventDefault();
  const next = radios[(index + step + radios.length) % radios.length];
  next.focus();
  next.click();
}
