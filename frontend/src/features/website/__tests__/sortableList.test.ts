/**
 * Dragging a page or block moves it up and down inside its list only
 * (issue 2618): no sideways drift, no dropping it outside the panel.
 */
import { expect, it } from 'vitest';
import type { Modifier } from '@dnd-kit/core';
import { verticalWithinList } from '../SortableList';

const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 10, right: 210, width: 200, height });
const args = (y: number, x = 40) => ({
  transform: { x, y, scaleX: 1, scaleY: 1 },
  draggingNodeRect: rect(100, 40),
  containerNodeRect: rect(50, 300),
}) as unknown as Parameters<Modifier>[0];

it('keeps the item on the vertical axis', () => {
  expect(verticalWithinList(args(20)).x).toBe(0);
  expect(verticalWithinList(args(20)).y).toBe(20);
});

it('keeps the item inside its list', () => {
  // The list spans 50..350; the item 100..140.
  expect(verticalWithinList(args(-200)).y).toBe(-50);
  expect(verticalWithinList(args(400)).y).toBe(210);
});
