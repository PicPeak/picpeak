/**
 * The annotation preview asks for the preview of the photo's applied edit
 * revision (issue 2619): the admin preview route keeps an answer only under
 * that revision, so a preview cached before an edit landed is not shown
 * under a drawing made on the edited photo.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../AdminAuthenticatedImage', () => ({
  AdminAuthenticatedImage: ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} />,
}));
vi.mock('../../gallery/annotation/ImageAnnotationOverlay', () => ({ ImageAnnotationOverlay: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, fallback?: string) => fallback || key }) }));

import { AnnotatedPhotoPreview } from '../AnnotatedPhotoPreview';

const annotation = { v: 1, strokes: [{ t: 'free', c: 0, p: [[0.1, 0.1], [0.2, 0.2]] }] };

describe('AnnotatedPhotoPreview', () => {
  it('names the applied edit revision, and nothing for a photo never edited', () => {
    const { rerender } = render(<AnnotatedPhotoPreview eventId={7} photoId={42} annotation={annotation} alt="shot" editAppliedRev={3} />);
    expect(screen.getByRole('img', { name: 'shot' })).toHaveAttribute('src', '/admin/photos/7/preview/42?e=3');
    rerender(<AnnotatedPhotoPreview eventId={7} photoId={42} annotation={annotation} alt="shot" editAppliedRev={0} />);
    expect(screen.getByRole('img', { name: 'shot' })).toHaveAttribute('src', '/admin/photos/7/preview/42');
  });
});
