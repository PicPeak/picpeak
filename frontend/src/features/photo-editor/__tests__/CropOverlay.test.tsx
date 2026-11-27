/**
 * The crop frame (issue 2619): a drag starts from the frame as drawn, the
 * crop shrunk onto a straightened photo, so it can be moved and resized.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_k: string, fallback?: string) => fallback ?? _k }) }));

import { CropOverlay } from '../CropOverlay';

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
