import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ColourSwatches } from '../ColourSwatches';
import { AlbumChoiceDetails } from '../AlbumChoiceDetails';
import type { Choice } from '../model';
import type { Option } from '../model';

vi.mock('../ProductImage', () => ({ ProductImage: ({ imageId }: { imageId: string | null }) => <span data-testid="product-image" data-image={imageId ?? ''} /> }));

const option = (id: string, extra: Partial<Option>) => ({ id, name: id, imageId: null, ...extra }) as Option;

describe('ColourSwatches', () => {
  it('keeps plain colour values round', () => {
    render(<ColourSwatches name="c" legend="Colour" options={[option('Ivory', { hex: '#d8cfc0' })]} onChange={() => {}} />);
    expect(document.querySelector('[data-swatch]')!.className).toContain('rounded-full');
    expect(screen.queryByTestId('product-image')).toBeNull();
  });

  it('shows a pictured colour round, in its circle, next to a colour value', () => {
    const onChange = vi.fn();
    render(
      <ColourSwatches
        name="c"
        legend="Colour"
        options={[option('Linen', { imageId: 'img-linen' }), option('Black', { hex: '#000000' })]}
        value="Linen"
        onChange={onChange}
        priceOf={(id) => (id === 'Black' ? '+ €20.00' : null)}
      />,
    );
    const image = screen.getByTestId('product-image');
    expect(image).toHaveAttribute('data-image', 'img-linen');
    expect(image.closest('[data-swatch]')!.className).toContain('rounded-full');
    const black = document.querySelector('[data-swatch="#000000"]') as HTMLElement;
    expect(black.className).toContain('rounded-full');
    expect(black.style.backgroundColor).toBe('rgb(0, 0, 0)');

    expect(screen.getByRole('radio', { name: 'Linen' })).toBeChecked();
    expect(screen.getByText('+ €20.00')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /^Black/ }));
    expect(onChange).toHaveBeenCalledWith('Black');
  });
});

describe('AlbumChoiceDetails', () => {
  it('shows a colour\'s picture round and square-cut, every other picture as a tile', () => {
    const renderImage = vi.fn((id: string, alt: string, shape?: 'square') => <img alt={alt} data-id={id} data-shape={shape ?? 'tile'} />);
    const choice = {
      schemaVersion: 2,
      productVersion: '1',
      product: { id: 'p', name: 'Album' },
      attributes: [
        { id: 'm', name: 'Material', addOn: false, role: 'material', options: [{ id: 'leather', name: 'Leather', imageId: 'img-leather' }] },
        { id: 'c', name: 'Colour', addOn: false, role: 'colour', options: [{ id: 'linen', name: 'Linen', imageId: 'img-linen' }] },
      ],
    } as Choice;
    render(<AlbumChoiceDetails choice={choice} renderPhoto={() => null} renderImage={renderImage} />);
    const linen = screen.getByRole('img', { name: 'Linen' });
    expect(linen).toHaveAttribute('data-shape', 'square');
    expect(linen.parentElement!.className).toContain('rounded-full');
    const leather = screen.getByRole('img', { name: 'Leather' });
    expect(leather).toHaveAttribute('data-shape', 'tile');
    expect(leather.parentElement!.className).not.toContain('rounded-full');
  });
});
