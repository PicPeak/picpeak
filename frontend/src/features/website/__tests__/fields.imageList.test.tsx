/**
 * The image list of a grid or strip block: the order of the pictures can be
 * changed, and the buttons on a picture do not depend on hovering, which a
 * touch screen cannot do.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ImageRef } from '../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, fb?: unknown, o?: Record<string, unknown>) => (typeof fb === 'string' ? fb.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(o?.[name] ?? '')) : k) }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('../ImagePicker', () => ({ ImagePicker: () => null }));
vi.mock('../../../services/website.service', () => ({ websiteService: {}, mediaKey: (ref: { id: string | number }) => String(ref.id) }));

import { ImageListField } from '../fields';

const images: ImageRef[] = ['a', 'b', 'c'].map((id) => ({ source: 'asset', id, alt: '' }));
const ids = (list: ImageRef[]) => list.map((ref) => ref.id);

describe('ImageListField', () => {
  it('moves a picture earlier or later', () => {
    const onChange = vi.fn();
    render(<ImageListField label="Images" value={images} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Move image 1 later' }));
    expect(ids(onChange.mock.calls.at(-1)?.[0])).toEqual(['b', 'a', 'c']);
    fireEvent.click(screen.getByRole('button', { name: 'Move image 3 earlier' }));
    expect(ids(onChange.mock.calls.at(-1)?.[0])).toEqual(['a', 'c', 'b']);
    expect(screen.getByRole('button', { name: 'Move image 1 earlier' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move image 3 later' })).toBeDisabled();
  });

  it('shows the buttons on a touch screen without hovering', () => {
    render(<ImageListField label="Images" value={images} onChange={() => {}} />);
    for (const name of ['Remove image 2', 'Move image 2 earlier', 'Move image 2 later']) {
      expect(screen.getByRole('button', { name }).parentElement?.className + screen.getByRole('button', { name }).className).toContain('[@media(pointer:coarse)]:opacity-100');
    }
  });
});
