import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { FormatComparison } from '../FormatComparison';
import { ProductImage } from '../ProductImage';
import { api } from '../../../config/api';
import { option } from './fixtures';
import type { Attribute, Option } from '../model';

vi.mock('../../../config/api', () => ({ api: { get: vi.fn() } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const attribute = (id: string, options: Option[], extra: Partial<Attribute> = {}): Attribute => ({
  id, name: id, groupId: id, optionIds: options.map((o) => o.id), required: true, multiple: false, addOn: false, dependsOn: [], options, ...extra,
});
const size = (id: string, width: number, height: number, unit: Option['unit'] = 'cm') => option(id, `${width} × ${height} ${unit}`, { width, height, unit });

// Issue 2397: every format in its true ratio, to one scale, no labels inside.
describe('format comparison drawing', () => {
  const format = attribute('format', [option('landscape', 'Landscape'), option('square', 'Square'), option('portrait', 'Portrait')]);
  const sizes = attribute('size', [size('l', 40, 30), size('s', 30, 30), size('s-small', 20, 20), size('p', 210, 297, 'mm')], {
    spread: true, availableWhen: { attributeId: 'format', options: { l: ['landscape'], s: ['square'], 's-small': ['square'], p: ['portrait'] } },
  });
  const draw = () => {
    const { container } = render(<FormatComparison name="f" format={format} size={sizes} onChange={() => {}} />);
    return [...container.querySelectorAll('svg')];
  };

  it('draws each format at its true ratio, a square as a square', () => {
    const rects = draw().map((svg) => svg.querySelector('rect')!);
    const dims = rects.map((r) => [Number(r.getAttribute('width')), Number(r.getAttribute('height'))]);
    expect(dims).toEqual([[400, 300], [300, 300], [210, 297]]);
  });

  it('draws them all to one scale, the largest filling the shared box', () => {
    const svgs = draw();
    expect(new Set(svgs.map((s) => s.getAttribute('viewBox')))).toEqual(new Set(['0 0 400 300']));
    svgs.forEach((s) => expect(s.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet'));
    // Centred in the shared box, so the outlines compare side by side.
    const square = svgs[1].querySelector('rect')!;
    expect([square.getAttribute('x'), square.getAttribute('y')]).toEqual(['50', '0']);
  });

  it('keeps the size names beneath the drawing, none inside it', () => {
    draw().forEach((svg) => expect(svg.textContent).toBe(''));
  });
});

describe('product image renditions', () => {
  it('asks for the small rendition by default and the large one when told', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: new Blob(['x']) } as never);
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:x');
    globalThis.URL.revokeObjectURL = vi.fn();
    const { rerender } = render(<ProductImage imageId="a" alt="Album" slug="wedding" />);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/gallery/wedding/album-products/images/a', { params: { size: 480 }, responseType: 'blob' }));
    rerender(<ProductImage imageId="a" alt="Album" slug="wedding" size={1200} />);
    await waitFor(() => expect(api.get).toHaveBeenLastCalledWith('/gallery/wedding/album-products/images/a', { params: { size: 1200 }, responseType: 'blob' }));
    rerender(<ProductImage imageId="a" alt="Album" />);
    await waitFor(() => expect(api.get).toHaveBeenLastCalledWith('/admin/album-products/images/a', { params: { size: 480 }, responseType: 'blob' }));
  });

  it('fills its square, and keeps the square while it loads', async () => {
    let resolve: (v: unknown) => void = () => {};
    vi.mocked(api.get).mockReturnValue(new Promise((r) => { resolve = r; }) as never);
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:x');
    const { container, findByRole } = render(<ProductImage imageId="a" alt="Album" slug="wedding" />);
    expect(container.firstElementChild).toHaveClass('aspect-square');
    expect(container).not.toHaveTextContent('No image');
    resolve({ data: new Blob(['x']) });
    const img = await findByRole('img', { name: 'Album' });
    expect(img).toHaveClass('aspect-square', 'object-cover');
    expect(img).not.toHaveClass('object-contain');
  });
});
