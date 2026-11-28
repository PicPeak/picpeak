/**
 * A colour that is not set (the branding's, or picked automatically) shows
 * as an "automatic" chip, not as a black swatch: black would claim a colour
 * the page does not use.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : k) }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

import { ColorField } from '../fields';

describe('ColorField', () => {
  it('shows an automatic chip while no colour is set, and still opens the picker', () => {
    const onChange = vi.fn();
    const { container } = render(<ColorField label="Text colour" value={null} emptyLabel="Automatic, for contrast" onChange={onChange} />);
    expect(container.querySelector('[data-colour-auto]')).not.toBeNull();
    const input = screen.getByLabelText('Text colour') as HTMLInputElement;
    // The native swatch (black, having no value) is not what is shown.
    expect(input.className).toMatch(/\bopacity-0\b/);
    fireEvent.change(input, { target: { value: '#336699' } });
    expect(onChange).toHaveBeenCalledWith('#336699');
  });

  it('shows the colour once one is set', () => {
    const { container } = render(<ColorField label="Text colour" value="#336699" onChange={() => {}} />);
    expect(container.querySelector('[data-colour-auto]')).toBeNull();
    const input = screen.getByLabelText('Text colour') as HTMLInputElement;
    expect(input.value).toBe('#336699');
    expect(input.className).not.toMatch(/\bopacity-0\b/);
  });
});
