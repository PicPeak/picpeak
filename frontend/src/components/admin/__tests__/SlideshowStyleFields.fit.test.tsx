/**
 * Issue 2261: the image fit was only reachable under Settings → Slideshow, so
 * a photographer configuring an event's slideshow could not find it. The
 * per-event style editor now leads with it.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SlideshowStyleFields } from '../SlideshowStyleFields';
import { DEFAULT_SLIDESHOW_STYLE } from '../../../services/slideshow.service';

describe('SlideshowStyleFields image fit', () => {
  it('offers inherit, auto, contain and cover, defaulting to inherit', () => {
    render(<SlideshowStyleFields value={DEFAULT_SLIDESHOW_STYLE} onChange={() => {}} />);
    const select = screen.getByLabelText('Image fit') as HTMLSelectElement;
    expect(select.value).toBe('inherit');
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['inherit', 'auto', 'contain', 'cover']);
  });

  it('reports the chosen fit', () => {
    const onChange = vi.fn();
    render(<SlideshowStyleFields value={DEFAULT_SLIDESHOW_STYLE} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Image fit'), { target: { value: 'contain' } });
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SLIDESHOW_STYLE, fit: 'contain' });
  });
});
