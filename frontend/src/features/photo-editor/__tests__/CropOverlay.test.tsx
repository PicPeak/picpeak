/**
 * The crop frame (issue 2619): a drag starts from the frame as drawn, the
 * crop shrunk onto a straightened photo, so it can be moved and resized.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_k: string, fallback?: string) => fallback ?? _k }) }));

import { CropOverlay, dragCrop } from '../CropOverlay';

const setup = () => {
  const onChange = vi.fn();
  const effective = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
  render(<CropOverlay effective={effective} aspect={null} onChange={onChange} />);
  const overlay = screen.getByTestId('crop-overlay');
  overlay.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, toJSON: () => ({}) });
  return { onChange, overlay };
};

const drag = (target: Element, dx: number, dy: number) => {
  (target as any).setPointerCapture = () => {};
  // jsdom's PointerEvent carries no coordinates; the handlers read clientX/Y only.
  fireEvent(target, new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));
  target.dispatchEvent(new MouseEvent('pointermove', { clientX: 50 + dx, clientY: 50 + dy }));
  target.dispatchEvent(new MouseEvent('pointerup'));
};

describe('CropOverlay after a straighten without a crop', () => {
  it('moves the frame as drawn', () => {
    const { onChange } = setup();
    drag(screen.getByRole('group'), -5, 5);
    const moved = onChange.mock.calls.at(-1)?.[0];
    expect(moved.x).toBeCloseTo(0.05);
    expect(moved.y).toBeCloseTo(0.15);
    expect(moved.w).toBeCloseTo(0.8);
    expect(moved.h).toBeCloseTo(0.8);
  });

  it('resizes the frame as drawn', () => {
    const { onChange, overlay } = setup();
    drag(overlay.querySelector('[data-handle="se"]')!, -10, -10);
    const resized = onChange.mock.calls.at(-1)?.[0];
    expect(resized.x).toBeCloseTo(0.1);
    expect(resized.w).toBeCloseTo(0.7);
    expect(resized.h).toBeCloseTo(0.7);
  });
});

describe('dragCrop with an aspect, from a corner', () => {
  const start = { x: 0.4, y: 0.1, w: 0.4, h: 0.4 };
  const edges = (r: { x: number; y: number; w: number; h: number }) => ({ left: r.x, top: r.y, right: r.x + r.w, bottom: r.y + r.h });
  const cases: Array<[string, number, string[]]> = [
    // handle, dx, the edges that stay where they were
    ['nw', -0.3, ['right', 'bottom']],
    ['ne', 0.3, ['left', 'bottom']],
    ['sw', -0.3, ['right', 'top']],
    ['se', 0.3, ['left', 'top']],
  ];
  for (const [handle, dx, fixed] of cases) {
    it(`keeps the opposite corner and the frame from ${handle}`, () => {
      const out = dragCrop(start, handle as any, dx, 0, 1);
      const before = edges(start);
      const after = edges(out);
      for (const edge of fixed) expect((after as any)[edge]).toBeCloseTo((before as any)[edge]);
      expect(out.w / out.h).toBeCloseTo(1);
      expect(Math.min(out.x, out.y)).toBeGreaterThanOrEqual(0);
      expect(Math.max(after.right, after.bottom)).toBeLessThanOrEqual(1 + 1e-9);
    });
  }
});
