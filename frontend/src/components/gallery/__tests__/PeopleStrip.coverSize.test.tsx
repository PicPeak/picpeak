/**
 * The face boxes come with the size of the image they are measured in (the
 * applied edit's delivered image, issue 2619). The avatar crop uses that
 * size, not the listing's, which names a newer edit's shape while it is
 * still being applied.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { PeopleStrip } from '../PeopleStrip';
import { faceCropStyle } from '../faceCrop';
import type { GalleryPerson, Photo } from '../../../types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_key: string, opts?: any) => opts?.defaultValue ?? _key }) }));
vi.mock('../../common/AuthenticatedImage', () => ({
  AuthenticatedImage: (props: any) => <img alt={props.alt} data-testid="avatar-img" style={props.style} />,
}));

const cover = { face_id: 1, photo_id: 1, bbox: [100, 100, 60, 80] as [number, number, number, number], photo_width: 600, photo_height: 400 };
const people: GalleryPerson[] = [1, 2].map((id) => ({ id, label: null, face_count: 5, cover: { ...cover, face_id: id } }));
// The listing names the pending edit's turned shape.
const photos = [{ id: 1, filename: '1.jpg', url: '/p/1', thumbnail_url: '/t/1', type: 'individual', size: 1, uploaded_at: '2026-01-01T00:00:00Z', width: 400, height: 600 }] as Photo[];

describe('PeopleStrip avatar crop', () => {
  it('measures the box against the size it came with', () => {
    render(<PeopleStrip photos={photos} people={people} slug="g" selectedPersonIds={[]} onToggle={vi.fn()} onShowAll={vi.fn()} collapsed={false} onCollapsedChange={vi.fn()} />);
    const expected = faceCropStyle(cover, 600, 400, window.innerWidth < 640 ? 56 : 64)!;
    const img = screen.getAllByTestId('avatar-img')[0] as HTMLImageElement;
    expect(img.style.width).toBe(String(expected.width));
    expect(img.style.left).toBe(String(expected.left));
  });
});
