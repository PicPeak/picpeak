/**
 * Colour labels in the Carousel layout (#1189).
 *
 * Carousel paints its own markup instead of going through PhotoCard, so it
 * inherited none of the colour-label treatment — not other viewers' marks from
 * #1178 and not the viewer's own from #1044. A photo the client flagged green
 * looked identical to one nobody had touched, in a layout a photographer can
 * select like any other.
 *
 * The strip is what these tests care about most: it is the only place the
 * carousel shows more than one photo at once, so it is the only place a label
 * can actually be scanned.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ColorLabelBadge } from '../ColorLabelBadge';

describe('ColorLabelBadge sizing and placement (#1189)', () => {
  const dots = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('span')).filter((el) =>
      el.className.includes('rounded-full')
    );

  it('defaults are untouched, so every existing layout renders as before', () => {
    const { container } = render(<ColorLabelBadge colorLabel="green" otherColorLabels={['red']} />);
    const row = container.querySelector('.absolute.top-2.left-2');
    expect(row).toBeTruthy();

    const [own] = dots(container);
    expect(own.className).toContain('w-5');
    expect(own.className).toContain('border-2');
  });

  it('the small variant shrinks both the own dot and the others', () => {
    // The carousel strip is 80px square; the grid-sized dots cover most of it.
    const { container } = render(
      <ColorLabelBadge colorLabel="green" otherColorLabels={['red', 'blue']} size="sm" />
    );
    const [own, ...others] = dots(container);
    expect(own.className).toContain('w-3.5');
    expect(own.className).not.toContain('w-5');
    others.forEach((d) => expect(d.className).toContain('w-2'));
  });

  it('the position is overridable, because the carousel has different corners free', () => {
    // Its top-left carries the counter and category chips, so the default
    // would render underneath them.
    const { container } = render(
      <ColorLabelBadge colorLabel="green" position="bottom-4 left-4" />
    );
    expect(container.querySelector('.absolute.bottom-4.left-4')).toBeTruthy();
    expect(container.querySelector('.absolute.top-2.left-2')).toBeNull();
  });

  it('still renders nothing when there is no label at all', () => {
    // The carousel maps over every photo in the strip, so an unmarked photo
    // must add no markup rather than an empty positioned span.
    const { container } = render(
      <ColorLabelBadge colorLabel={null} otherColorLabels={[]} size="sm" position="top-1 left-1" />
    );
    expect(container.innerHTML).toBe('');
  });

  it('shows other viewers marks even when the viewer has none of their own', () => {
    // The #1178 case, which is the one that makes the carousel gap visible: a
    // client marked it, the photographer has not.
    render(<ColorLabelBadge colorLabel={null} otherColorLabels={['green']} size="sm" />);
    expect(screen.getByRole('img', { name: /also marked by others/i })).toBeTruthy();
  });

  it('keeps the inset ring, so the selected photo still reads at a glance', () => {
    const { container } = render(<ColorLabelBadge colorLabel="red" size="sm" />);
    const ring = container.querySelector('.absolute.inset-0');
    expect(ring).toBeTruthy();
    expect((ring as HTMLElement).style.boxShadow).toContain('inset');
  });
});
