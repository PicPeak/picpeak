import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { PeopleStrip } from '../PeopleStrip';
import type { GalleryPerson, Photo } from '../../../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: any) => opts?.defaultValue ?? _key,
  }),
}));

vi.mock('../../common/AuthenticatedImage', () => ({
  AuthenticatedImage: (props: any) => <img alt={props.alt} data-testid="avatar-img" />,
}));

function person(id: number, over: Partial<GalleryPerson> = {}): GalleryPerson {
  return {
    id,
    label: null,
    face_count: 10,
    cover: { face_id: id, photo_id: id, bbox: [10, 10, 50, 50] },
    ...over,
  };
}

const photos: Photo[] = [1, 2, 3].map((id) => ({
  id,
  filename: `${id}.jpg`,
  url: `/p/${id}`,
  thumbnail_url: `/t/${id}`,
  type: 'individual',
  size: 100,
  uploaded_at: '2026-01-01T00:00:00Z',
  width: 1000,
  height: 800,
})) as Photo[];

const baseProps = {
  photos,
  slug: 'test-gallery',
  selectedPersonIds: [],
  onToggle: vi.fn(),
  onShowAll: vi.fn(),
  collapsed: false,
  onCollapsedChange: vi.fn(),
};

describe('PeopleStrip (#1074)', () => {
  it('renders nothing for fewer than two people', () => {
    // One face taking up a whole row is not a "people in this gallery"
    // feature, it's clutter.
    const { container } = render(<PeopleStrip {...baseProps} people={[person(1)]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('still renders during a scan even with too few people yet', () => {
    render(
      <PeopleStrip
        {...baseProps}
        people={[person(1)]}
        scan={{ in_progress: true, scanned: 40, total: 200 }}
      />
    );
    expect(screen.getByText(/Finding people/)).toBeInTheDocument();
  });

  it('shows a photo count for unnamed people, never an invented name', () => {
    render(<PeopleStrip {...baseProps} people={[person(1, { face_count: 42 }), person(2)]} />);
    expect(screen.getByText('42 photos')).toBeInTheDocument();
    // The thing we specifically refuse to do.
    expect(screen.queryByText(/Person \d/)).not.toBeInTheDocument();
  });

  it('shows the name and the count when a person has been named', () => {
    render(
      <PeopleStrip
        {...baseProps}
        people={[person(1, { label: 'Anna', face_count: 97 }), person(2)]}
      />
    );
    expect(screen.getByText('Anna')).toBeInTheDocument();
    expect(screen.getByText('97')).toBeInTheDocument();
  });

  it('marks the selected person as pressed for assistive tech', () => {
    render(
      <PeopleStrip
        {...baseProps}
        people={[person(1, { label: 'Anna' }), person(2, { label: 'Ben' })]}
        selectedPersonIds={[1]}
      />
    );
    const buttons = screen.getAllByRole('button', { pressed: true });
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAttribute('aria-label', expect.stringContaining('Anna'));
  });

  it('collapses to a one-line summary when dismissed', () => {
    render(
      <PeopleStrip
        {...baseProps}
        people={[person(1), person(2), person(3)]}
        collapsed
      />
    );
    expect(screen.getByText('3 people found')).toBeInTheDocument();
    expect(screen.queryByTestId('avatar-img')).not.toBeInTheDocument();
  });

  it('offers "show all" only when people overflow the inline strip', () => {
    const many = Array.from({ length: 14 }, (_, i) => person(i + 1));
    const { rerender } = render(<PeopleStrip {...baseProps} people={many} maxInline={12} />);
    expect(screen.getByText('Show all 14')).toBeInTheDocument();

    rerender(<PeopleStrip {...baseProps} people={many.slice(0, 5)} maxInline={12} />);
    expect(screen.queryByText(/Show all/)).not.toBeInTheDocument();
  });

  it('falls back to an uncropped thumbnail when photo dimensions are unknown', () => {
    // Without width/height the bbox ratios can't be computed; rendering a
    // wrongly-offset crop would be worse than not cropping.
    const noDims = [{ ...photos[0], width: undefined, height: undefined }] as Photo[];
    render(
      <PeopleStrip
        {...baseProps}
        photos={noDims}
        people={[person(1), person(2)]}
      />
    );
    expect(screen.getAllByTestId('avatar-img').length).toBeGreaterThan(0);
  });
});
