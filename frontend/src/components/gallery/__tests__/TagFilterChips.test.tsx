import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { TagFilterChips, tagChipsFor } from '../TagFilterChips';
import type { Photo } from '../../../types';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      // Known names resolve; an unknown key falls back to its defaultValue.
      t: (key: string, options?: { defaultValue?: string }) =>
        (key === 'gallery.tags.names.surprise_tag' ? options?.defaultValue ?? key : key),
      i18n: { language: 'en' },
    }),
  };
});

const photo = (id: number, tag_keys?: string[]): Photo => ({
  id, filename: `${id}.jpg`, url: '', type: 'individual', size: 1, uploaded_at: '2026-09-01T00:00:00Z', tag_keys,
});

describe('tagChipsFor (issue 1733)', () => {
  const galleryTags = [{ key: 'cake', count: 9 }, { key: 'dancing', count: 5 }, { key: 'night', count: 2 }];

  it('keeps the gallery order and counts the photos in scope', () => {
    const scope = [photo(1, ['dancing', 'cake']), photo(2, ['dancing']), photo(3), photo(4, [])];
    expect(tagChipsFor(galleryTags, scope, [])).toEqual([
      { key: 'cake', count: 1 }, { key: 'dancing', count: 2 },
    ]);
  });

  it('keeps a selected tag with no photo in scope, so it can be cleared', () => {
    expect(tagChipsFor(galleryTags, [photo(1, ['cake'])], ['night'])).toEqual([
      { key: 'cake', count: 1 }, { key: 'night', count: 0 },
    ]);
  });

  it('keeps a selected tag the gallery no longer lists, so the filter stays visible', () => {
    // A refresh after the last "night" photo was deleted or re-tagged.
    const refreshed = [{ key: 'cake', count: 9 }];
    expect(tagChipsFor(refreshed, [photo(1, ['cake'])], ['night'])).toEqual([
      { key: 'cake', count: 1 }, { key: 'night', count: 0 },
    ]);
    expect(tagChipsFor([], [photo(1)], ['night'])).toEqual([{ key: 'night', count: 0 }]);
  });

  it('is empty for a gallery without tags', () => {
    expect(tagChipsFor(undefined, [photo(1, ['cake'])], [])).toEqual([]);
    expect(tagChipsFor([], [photo(1)], [])).toEqual([]);
  });
});

describe('TagFilterChips (issue 1733)', () => {
  const tags = [{ key: 'cake', count: 3 }, { key: 'dancing', count: 2 }];

  it('renders nothing when there are no tags', () => {
    const { container } = render(<TagFilterChips tags={[]} selectedKeys={[]} onToggle={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('offers each tag with its count and toggles it', async () => {
    const onToggle = vi.fn();
    render(<TagFilterChips tags={tags} selectedKeys={['dancing']} onToggle={onToggle} />);

    const cake = screen.getByRole('button', { name: 'gallery.tags.names.cake (3)' });
    expect(cake).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'gallery.tags.names.dancing (2)' })).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(cake);
    expect(onToggle).toHaveBeenCalledWith('cake');
  });

  it('says that several tags widen the result, once a second one is picked', () => {
    const { rerender } = render(<TagFilterChips tags={tags} selectedKeys={['cake']} onToggle={vi.fn()} />);
    expect(screen.queryByText('gallery.tags.matchAny')).not.toBeInTheDocument();

    rerender(<TagFilterChips tags={tags} selectedKeys={['cake', 'dancing']} onToggle={vi.fn()} />);
    expect(screen.getByText('gallery.tags.matchAny')).toBeInTheDocument();
  });

  it('labels a tag this build has no name for from its key', () => {
    render(<TagFilterChips tags={[{ key: 'surprise_tag', count: 1 }]} selectedKeys={[]} onToggle={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'surprise tag (1)' })).toBeInTheDocument();
  });

  it('stacks in the sidebar with the same toggles', async () => {
    const onToggle = vi.fn();
    render(<TagFilterChips variant="list" tags={tags} selectedKeys={[]} onToggle={onToggle} />);
    await userEvent.click(screen.getByRole('button', { name: /gallery\.tags\.names\.dancing/ }));
    expect(onToggle).toHaveBeenCalledWith('dancing');
  });
});
