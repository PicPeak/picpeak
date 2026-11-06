import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ColourSwatches } from '../ColourSwatches';
import type { Option } from '../model';

vi.mock('../ProductImage', () => ({ ProductImage: ({ imageId }: { imageId: string | null }) => <span data-testid="product-image" data-image={imageId ?? ''} /> }));

const option = (id: string, extra: Partial<Option>) => ({ id, name: id, imageId: null, ...extra }) as Option;

describe('ColourSwatches', () => {
  it('keeps plain colour values round', () => {
    render(<ColourSwatches name="c" legend="Colour" options={[option('Ivory', { hex: '#d8cfc0' })]} onChange={() => {}} />);
    expect(document.querySelector('[data-swatch]')!.className).toContain('rounded-full');
    expect(screen.queryByTestId('product-image')).toBeNull();
  });

  it('shows pictured colours as whole 3:2 tiles, and fills a colour-only one to the same box', () => {
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
    expect(screen.getByTestId('product-image')).toHaveAttribute('data-image', 'img-linen');
    expect(document.querySelector('.rounded-full')).toBeNull();
    const black = document.querySelector('[data-swatch="#000000"]') as HTMLElement;
    expect(black.className).toContain('aspect-[3/2]');
    expect(black.style.backgroundColor).toBe('rgb(0, 0, 0)');

    expect(screen.getByRole('radio', { name: 'Linen' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Linen' }).closest('label')!.className).toContain('tile-selected');
    expect(screen.getByText('+ €20.00')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /^Black/ }));
    expect(onChange).toHaveBeenCalledWith('Black');
  });
});
