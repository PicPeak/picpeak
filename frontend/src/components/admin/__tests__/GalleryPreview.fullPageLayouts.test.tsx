/**
 * The admin theme preview had no case for the full-page layouts, so picking
 * Gallery Premium or Story left an empty box under the "layout" bar.
 */
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { GalleryPreview } from '../GalleryPreview';
import type { GalleryLayoutType } from '../../../types/theme.types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const layouts: GalleryLayoutType[] = ['grid', 'masonry', 'carousel', 'timeline', 'mosaic', 'gallery-premium', 'gallery-story'];

describe('GalleryPreview', () => {
  it.each(layouts)('draws sample photos for the %s layout', (layoutType) => {
    const { getByTestId } = render(<GalleryPreview theme={{}} layoutType={layoutType} />);
    expect(getByTestId('gallery-preview-content').querySelectorAll('.lucide-camera').length).toBeGreaterThan(0);
  });
});
