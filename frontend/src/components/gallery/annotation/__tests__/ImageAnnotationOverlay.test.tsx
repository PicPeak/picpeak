/**
 * The annotation overlay (issue 1733): it draws exactly the validated
 * strokes, on the rectangle the rendered picture covers, and nothing at all
 * for a value that does not validate.
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnnotationSvg } from '../AnnotationSvg';
import { ImageAnnotationOverlay } from '../ImageAnnotationOverlay';
import { ANNOTATION_PALETTE } from '../../../../utils/photoAnnotation';

const FIXTURE = {
  v: 1,
  strokes: [
    { t: 'free', c: 0, p: [[0.1, 0.1], [0.2, 0.3], [0.4, 0.2]] },
    { t: 'arrow', c: 3, p: [[0.9, 0.9], [0.5, 0.5]] },
    { t: 'free', c: 4, p: [[0.6, 0.1], [0.7, 0.1]] },
  ],
};

vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });

describe('AnnotationSvg', () => {
  it('renders one path per stroke in a normalised, non-scaling space', () => {
    const { container } = render(<AnnotationSvg annotation={FIXTURE} aspect={1.5} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('viewBox')).toBe('0 0 1 1');
    expect(svg.getAttribute('preserveAspectRatio')).toBe('none');
    const paths = Array.from(container.querySelectorAll('path'));
    expect(paths).toHaveLength(3);
    expect(paths.map((p) => p.getAttribute('stroke'))).toEqual([
      ANNOTATION_PALETTE[0], ANNOTATION_PALETTE[3], ANNOTATION_PALETTE[4],
    ]);
    for (const path of paths) {
      expect(path.getAttribute('vector-effect')).toBe('non-scaling-stroke');
      expect(path.getAttribute('fill')).toBe('none');
      expect(path.getAttribute('d')).toMatch(/^[MLe0-9. -]+$/);
    }
  });

  it('renders no path for a value that does not validate', () => {
    const hostile = { v: 1, strokes: [{ t: 'free', c: '"><script>alert(1)</script>', p: [[0, 0], [1, 1]] }] };
    const { container } = render(<AnnotationSvg annotation={hostile} aspect={1} />);
    expect(container.querySelectorAll('path')).toHaveLength(0);
    expect(container.innerHTML).not.toContain('script');
  });
});

describe('ImageAnnotationOverlay', () => {
  // jsdom lays nothing out: give the picture a box and a natural size.
  const sizes = { offsetWidth: 400, offsetHeight: 300, naturalWidth: 2000, naturalHeight: 1000 };
  beforeEach(() => {
    for (const [key, value] of Object.entries(sizes)) {
      Object.defineProperty(HTMLImageElement.prototype, key, { configurable: true, get: () => value });
    }
  });
  afterEach(() => {
    for (const key of Object.keys(sizes)) {
      delete (HTMLImageElement.prototype as unknown as Record<string, unknown>)[key];
    }
  });

  it('covers the rendered picture, not the element box, when photo dimensions are unknown', () => {
    render(
      <div>
        <img alt="photo" />
        <ImageAnnotationOverlay annotation={FIXTURE} />
      </div>
    );
    const svg = screen.getByTestId('annotation-overlay');
    // A 2:1 picture contained in a 400x300 box is 400x200.
    expect(svg.style.width).toBe('400px');
    expect(svg.style.height).toBe('200px');
    expect(svg.style.pointerEvents).toBe('none');
    expect(svg.querySelectorAll('path')).toHaveLength(3);
  });

  it('renders nothing until there is a picture to measure', () => {
    render(
      <div>
        <div className="placeholder" />
        <ImageAnnotationOverlay annotation={FIXTURE} />
      </div>
    );
    expect(screen.queryByTestId('annotation-overlay')).toBeNull();
  });

  // The thumbnail shown when the picture itself fails to load can be a
  // centre crop: the same coordinates point somewhere else on it.
  it('stays off a picture that shows its fallback, and comes back with the real one', async () => {
    render(
      <div>
        <img alt="photo" data-fallback="true" />
        <ImageAnnotationOverlay annotation={FIXTURE} />
      </div>
    );
    expect(screen.queryByTestId('annotation-overlay')).toBeNull();
    screen.getByAltText('photo').removeAttribute('data-fallback');
    expect(await screen.findByTestId('annotation-overlay')).toBeTruthy();
  });

  it('turns a pointer drag into one stroke in image coordinates', () => {
    const onStroke = vi.fn();
    render(
      <div>
        <img alt="photo" />
        <ImageAnnotationOverlay annotation={null} draw={{ tool: 'arrow', color: 2, onStroke }} />
      </div>
    );
    const svg = screen.getByTestId('annotation-overlay');
    svg.getBoundingClientRect = () => ({ left: 100, top: 50, width: 400, height: 200 } as DOMRect);
    // jsdom has no PointerEvent: a MouseEvent of the right type carrying the
    // pointer fields the handlers read.
    const pointer = (type: string, x: number, y: number) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
      Object.assign(event, { isPrimary: true, pointerId: 1, pointerType: 'touch' });
      act(() => { fireEvent(svg, event); });
    };
    pointer('pointerdown', 100, 50);
    pointer('pointermove', 300, 150);
    // Past the edge: clamped to the picture.
    pointer('pointermove', 900, 150);
    expect(svg.querySelectorAll('path')).toHaveLength(1);
    pointer('pointerup', 900, 150);
    expect(onStroke).toHaveBeenCalledTimes(1);
    expect(onStroke).toHaveBeenCalledWith({ t: 'arrow', c: 2, p: [[0, 0], [1, 0.5]] });
    expect(svg.querySelectorAll('path')).toHaveLength(0);
  });

  // A second finger landing on the photo is ignored, so its lifting must not
  // end the stroke the first finger is still drawing.
  it('only ends a stroke for the pointer that started it', () => {
    const onStroke = vi.fn();
    render(
      <div>
        <img alt="photo" />
        <ImageAnnotationOverlay annotation={null} draw={{ tool: 'arrow', color: 0, onStroke }} />
      </div>
    );
    const svg = screen.getByTestId('annotation-overlay');
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 200 } as DOMRect);
    const pointer = (type: string, x: number, y: number, pointerId = 1) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
      Object.assign(event, { isPrimary: pointerId === 1, pointerId, pointerType: 'touch' });
      act(() => { fireEvent(svg, event); });
    };
    pointer('pointerdown', 0, 0);
    pointer('pointermove', 100, 100);
    pointer('pointerdown', 300, 50, 2);
    pointer('pointerup', 300, 50, 2);
    pointer('pointercancel', 300, 50, 2);
    expect(onStroke).not.toHaveBeenCalled();
    expect(svg.querySelectorAll('path')).toHaveLength(1);

    pointer('pointermove', 400, 200);
    pointer('pointerup', 400, 200);
    expect(onStroke).toHaveBeenCalledWith({ t: 'arrow', c: 0, p: [[0, 0], [1, 1]] });
  });

  // Escape while the pointer is still down, on a drawing being edited: the
  // overlay stays for the attached drawing, and with `draw` gone no pointerup
  // handler is left to take the half-drawn stroke away.
  it('drops the stroke under the pointer when drawing ends mid-stroke', () => {
    const onStroke = vi.fn();
    const ui = (drawing: boolean) => (
      <div>
        <img alt="photo" />
        <ImageAnnotationOverlay annotation={FIXTURE} draw={drawing ? { tool: 'free', color: 2, onStroke } : undefined} />
      </div>
    );
    const { rerender } = render(ui(true));
    const svg = screen.getByTestId('annotation-overlay');
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 200 } as DOMRect);
    const pointer = (type: string, x: number, y: number) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
      Object.assign(event, { isPrimary: true, pointerId: 1, pointerType: 'mouse' });
      act(() => { fireEvent(svg, event); });
    };
    pointer('pointerdown', 10, 10);
    pointer('pointermove', 200, 100);
    expect(svg.querySelectorAll('path')).toHaveLength(4);

    rerender(ui(false));
    expect(svg.querySelectorAll('path')).toHaveLength(3);
    // Drawing again does not pick the abandoned trail back up.
    rerender(ui(true));
    pointer('pointermove', 300, 150);
    pointer('pointerup', 300, 150);
    expect(svg.querySelectorAll('path')).toHaveLength(3);
    expect(onStroke).not.toHaveBeenCalled();
  });
});
