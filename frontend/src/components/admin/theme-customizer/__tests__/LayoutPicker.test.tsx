/**
 * The layout picker (issue 1733, section E): wireframe tiles as a radio
 * group. Picking, the arrow keys, the single Tab stop, and the two places in
 * the theme editor that use it (gallery layout, masonry mode).
 */
import React, { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

import en from '../../../../i18n/locales/en.json';
import { LayoutPicker } from '../LayoutPicker';
import { GalleryLayoutCard } from '../GalleryLayoutCard';
import { layoutWireframes, masonryModeWireframes } from '../layoutWireframes';
import type { ThemeConfig } from '../../../../types/theme.types';

// Resolves keys against en.json, so a missing key shows up as the raw key.
const lookup = (key: string): unknown =>
  key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], en);
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => {
      const value = lookup(key);
      return typeof value === 'string' ? value : typeof fallback === 'string' ? fallback : key;
    },
  }),
}));

const options = [
  { value: 'a', label: 'Alpha', description: 'First', wireframe: <svg /> },
  { value: 'b', label: 'Beta', description: 'Second', wireframe: <svg /> },
  { value: 'c', label: 'Gamma', description: 'Third', wireframe: <svg /> },
];

const Controlled: React.FC<{ initial?: string; onChange?: (v: string) => void }> = ({ initial, onChange }) => {
  const [value, setValue] = useState(initial);
  return (
    <LayoutPicker
      aria-label="Layout"
      options={options}
      value={value}
      onChange={(v) => { setValue(v); onChange?.(v); }}
    />
  );
};

describe('LayoutPicker', () => {
  it('is a radio group with the chosen tile checked and the only Tab stop', () => {
    render(<Controlled initial="b" />);
    const group = screen.getByRole('radiogroup', { name: 'Layout' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
    // The name is the label; the description is the description.
    const beta = screen.getByRole('radio', { name: 'Beta' });
    expect(beta).toHaveAccessibleDescription('Second');
  });

  it('gives the first tile the Tab stop when nothing matches', () => {
    render(<Controlled initial={undefined} />);
    expect(screen.getAllByRole('radio').map((r) => r.tabIndex)).toEqual([0, -1, -1]);
  });

  it('picks a tile on click', () => {
    const onChange = vi.fn();
    render(<Controlled initial="a" onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Gamma' }));
    expect(onChange).toHaveBeenCalledWith('c');
    expect(screen.getByRole('radio', { name: 'Gamma' }).getAttribute('aria-checked')).toBe('true');
  });

  it('moves and picks with the arrow keys, wrapping at the ends', () => {
    const onChange = vi.fn();
    render(<Controlled initial="a" onChange={onChange} />);
    const alpha = screen.getByRole('radio', { name: 'Alpha' });
    alpha.focus();
    fireEvent.keyDown(alpha, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('b');
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Beta' }));

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(onChange).toHaveBeenLastCalledWith('c');
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Gamma' }));
  });

  it('leaves out the description in compact mode', () => {
    render(<LayoutPicker aria-label="Preview" compact options={options} value="a" onChange={vi.fn()} />);
    expect(screen.queryByText('First')).toBeNull();
    expect(screen.getByRole('radio', { name: 'Alpha' })).not.toHaveAttribute('aria-describedby');
  });
});

const renderCard = (theme: ThemeConfig) => {
  const handleChange = vi.fn();
  const updateGallerySettings = vi.fn();
  render(
    <GalleryLayoutCard
      localTheme={theme}
      handleChange={handleChange}
      updateGallerySettings={updateGallerySettings}
      isBetaLayout={false}
      isThumbnailTooSmall={false}
      thumbnailWidth={0}
      thumbnailHeight={0}
      minRecommendedThumbnailSize={0}
    />
  );
  return { handleChange, updateGallerySettings };
};

describe('GalleryLayoutCard — layout pickers', () => {
  it('offers every gallery layout as a named wireframe tile and stores the pick', () => {
    const { handleChange } = renderCard({ galleryLayout: 'grid' });
    const group = screen.getByRole('radiogroup', { name: 'Gallery Layout' });
    const radios = within(group).getAllByRole('radio');
    expect(radios).toHaveLength(Object.keys(layoutWireframes).length);
    radios.forEach((radio) => expect(radio.querySelector('svg')).not.toBeNull());
    expect(screen.getByRole('radio', { name: 'Grid' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'Story Beta' })).toHaveAccessibleDescription(
      en.branding.layoutDescriptions['gallery-story'],
    );

    fireEvent.click(screen.getByRole('radio', { name: 'Mosaic' }));
    expect(handleChange).toHaveBeenCalledWith('galleryLayout', 'mosaic');
  });

  it('offers the masonry modes as tiles, Quilted included, and stores the pick', () => {
    const { updateGallerySettings } = renderCard({ galleryLayout: 'masonry', gallerySettings: { masonryMode: 'flickr' } });
    const group = screen.getByRole('radiogroup', { name: 'Layout Mode' });
    const radios = within(group).getAllByRole('radio');
    expect(radios).toHaveLength(Object.keys(masonryModeWireframes).length);
    expect(within(group).getByRole('radio', { name: 'Flickr rows' }).getAttribute('aria-checked')).toBe('true');

    fireEvent.click(within(group).getByRole('radio', { name: 'Quilted' }));
    expect(updateGallerySettings).toHaveBeenCalledWith('masonryMode', 'quilted');
  });

  it('defaults to Columns and shows a stored justified as Rows, which is how it renders', () => {
    renderCard({ galleryLayout: 'masonry' });
    let group = screen.getByRole('radiogroup', { name: 'Layout Mode' });
    expect(within(group).getByRole('radio', { name: 'Columns' }).getAttribute('aria-checked')).toBe('true');

    document.body.innerHTML = '';
    renderCard({ galleryLayout: 'masonry', gallerySettings: { masonryMode: 'justified' } });
    group = screen.getByRole('radiogroup', { name: 'Layout Mode' });
    expect(within(group).getByRole('radio', { name: 'Rows' }).getAttribute('aria-checked')).toBe('true');
    // The Rows settings apply to it, as they do to a stored rows.
    expect(screen.getByText('Target Row Height')).toBeTruthy();
    expect(screen.getByText('Last Row Alignment')).toBeTruthy();
    expect(screen.queryByText('Thumbnail Scale')).toBeNull();
  });

  it('does not show the masonry modes for another layout', () => {
    renderCard({ galleryLayout: 'grid' });
    expect(screen.queryByRole('radiogroup', { name: 'Layout Mode' })).toBeNull();
  });
});
