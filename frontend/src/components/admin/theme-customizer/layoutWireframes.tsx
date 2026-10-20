import React from 'react';
import { useTranslation } from 'react-i18next';
import type { GalleryLayoutType, GalleryLayoutSettings } from '../../../types/theme.types';
import type { LayoutPickerOption } from './LayoutPicker';

/**
 * Small wireframes of the gallery layouts for the layout picker (issue 1733,
 * section E). Abstract boxes on a 48×36 page, drawn in `currentColor`, so the
 * tile's text colour paints them: the UI tokens at rest, the accent's
 * foreground on the selected tile, both modes without a `dark:` variant.
 */

type Box = [x: number, y: number, w: number, h: number];

// The masonry modes the picker offers. A stored 'justified' renders as rows
// (MasonryGalleryLayout) and is shown as Rows.
export type MasonryPickerMode = Exclude<NonNullable<GalleryLayoutSettings['masonryMode']>, 'justified'>;

const Wireframe: React.FC<{ boxes: Box[]; children?: React.ReactNode }> = ({ boxes, children }) => (
  <svg viewBox="0 0 48 36" className="block w-full h-auto" aria-hidden="true" focusable="false">
    <rect x="0.5" y="0.5" width="47" height="35" rx="2" fill="none" stroke="currentColor" strokeOpacity="0.35" />
    <g fill="currentColor" fillOpacity="0.55">
      {boxes.map(([x, y, w, h], i) => (
        <rect key={i} x={x} y={y} width={w} height={h} rx="1" />
      ))}
    </g>
    {children}
  </svg>
);

const columnsBoxes: Box[] = [
  [3, 3, 12.5, 13], [3, 18, 12.5, 15],
  [17.75, 3, 12.5, 8], [17.75, 13, 12.5, 11], [17.75, 26, 12.5, 7],
  [32.5, 3, 12.5, 10], [32.5, 15, 12.5, 18],
];

const rowsBoxes: Box[] = [
  [3, 3, 16, 9], [21, 3, 10, 9], [33, 3, 12, 9],
  [3, 13.5, 9, 9], [14, 13.5, 18, 9], [34, 13.5, 11, 9],
  [3, 24, 13, 9], [18, 24, 11, 9], [31, 24, 14, 9],
];

export const layoutWireframes: Record<GalleryLayoutType, React.ReactNode> = {
  grid: (
    <Wireframe
      boxes={[
        [3, 3, 12.5, 9], [17.75, 3, 12.5, 9], [32.5, 3, 12.5, 9],
        [3, 13.5, 12.5, 9], [17.75, 13.5, 12.5, 9], [32.5, 13.5, 12.5, 9],
        [3, 24, 12.5, 9], [17.75, 24, 12.5, 9], [32.5, 24, 12.5, 9],
      ]}
    />
  ),
  masonry: <Wireframe boxes={columnsBoxes} />,
  carousel: (
    <Wireframe boxes={[[9, 3, 30, 23]]}>
      <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 12.5 L3.5 14.5 L6 16.5" />
        <path d="M42 12.5 L44.5 14.5 L42 16.5" />
      </g>
      <g fill="currentColor">
        <circle cx="20" cy="30.5" r="1.2" fillOpacity="0.4" />
        <circle cx="24" cy="30.5" r="1.2" />
        <circle cx="28" cy="30.5" r="1.2" fillOpacity="0.4" />
      </g>
    </Wireframe>
  ),
  timeline: (
    <Wireframe
      boxes={[
        [10, 3, 12, 2.5], [10, 7, 10.5, 8], [22.5, 7, 10.5, 8], [35, 7, 10, 8],
        [10, 19, 9, 2.5], [10, 23, 10.5, 8], [22.5, 23, 10.5, 8],
      ]}
    >
      <g fill="currentColor">
        <rect x="4.5" y="4" width="1" height="28" fillOpacity="0.4" />
        <circle cx="5" cy="4.25" r="1.75" />
        <circle cx="5" cy="20.25" r="1.75" />
      </g>
    </Wireframe>
  ),
  mosaic: (
    <Wireframe
      boxes={[
        [3, 3, 20, 19], [25, 3, 9, 8.5], [36, 3, 9, 8.5], [25, 13.5, 20, 8.5],
        [3, 24, 13, 9], [18, 24, 13, 9], [33, 24, 12, 9],
      ]}
    />
  ),
  'gallery-premium': (
    <Wireframe
      boxes={[
        [3, 16, 12.5, 10], [3, 28, 12.5, 5],
        [17.75, 16, 12.5, 6], [17.75, 24, 12.5, 9],
        [32.5, 16, 12.5, 12], [32.5, 30, 12.5, 3],
      ]}
    >
      {/* The hero: a wide image with the gallery title on it. */}
      <rect x="3" y="3" width="42" height="11" rx="1" fill="currentColor" fillOpacity="0.3" />
      <rect x="15" y="7.5" width="18" height="2" rx="1" fill="currentColor" />
    </Wireframe>
  ),
  'gallery-story': (
    <Wireframe
      boxes={[
        [3, 3, 42, 10],
        [3, 18, 12.5, 7], [17.75, 18, 12.5, 7], [32.5, 18, 12.5, 7],
        [3, 27, 42, 6],
      ]}
    >
      {/* A scene title between the full-width scene images. */}
      <rect x="3" y="14.5" width="16" height="2" rx="1" fill="currentColor" />
    </Wireframe>
  ),
};

export const masonryModeWireframes: Record<MasonryPickerMode, React.ReactNode> = {
  columns: <Wireframe boxes={columnsBoxes} />,
  rows: <Wireframe boxes={rowsBoxes} />,
  // Flickr's justified-layout: every row has its own height.
  flickr: (
    <Wireframe
      boxes={[
        [3, 3, 20, 13], [25, 3, 20, 13],
        [3, 18, 9, 6], [14, 18, 12, 6], [28, 18, 7, 6], [37, 18, 8, 6],
        [3, 26, 15, 7], [20, 26, 11, 7], [33, 26, 12, 7],
      ]}
    />
  ),
  // Square cells; a landscape spans two columns, a portrait two rows.
  quilted: (
    <Wireframe
      boxes={[
        [3, 3, 20.25, 9], [24.75, 3, 9.375, 9], [35.625, 3, 9.375, 19.5],
        [3, 13.5, 9.375, 19.5], [13.875, 13.5, 9.375, 9], [24.75, 13.5, 9.375, 9],
        [13.875, 24, 20.25, 9], [35.625, 24, 9.375, 9],
      ]}
    />
  ),
};

const BETA_LAYOUTS: GalleryLayoutType[] = ['gallery-premium', 'gallery-story'];

/** The gallery layouts as LayoutPicker options, in the picker's order. */
export function useGalleryLayoutOptions(): LayoutPickerOption<GalleryLayoutType>[] {
  const { t } = useTranslation();
  return (Object.keys(layoutWireframes) as GalleryLayoutType[]).map((layout) => ({
    value: layout,
    label: t(`branding.layoutNames.${layout}`),
    description: t(`branding.layoutDescriptions.${layout}`),
    tag: BETA_LAYOUTS.includes(layout) ? t('branding.layoutBetaTag', 'Beta') : undefined,
    wireframe: layoutWireframes[layout],
  }));
}
