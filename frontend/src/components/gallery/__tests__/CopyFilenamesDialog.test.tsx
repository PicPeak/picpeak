import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CopyFilenamesDialog } from '../CopyFilenamesDialog';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (_key: string, defaultValue?: string, opts?: Record<string, unknown>) => {
        let text = defaultValue ?? _key;
        for (const [k, v] of Object.entries(opts || {})) text = text.replace(`{{${k}}}`, String(v));
        return text;
      },
    }),
  };
});

const photos = [
  { filename: 'b.jpg', original_filename: 'IMG_0002.JPG' },
  { filename: 'a.jpg', original_filename: 'IMG_0001.JPG' },
  { filename: 'c.jpg', original_filename: null },
];

const textarea = () => screen.getByRole('textbox') as HTMLTextAreaElement;

describe('CopyFilenamesDialog (issue 1733, A3d)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists the stems of the selected photos, comma joined, with the count', () => {
    render(<CopyFilenamesDialog photos={photos} source="selection" onClose={() => {}} />);
    expect(textarea().value).toBe('IMG_0001,IMG_0002,c');
    expect(screen.getByTestId('copy-filenames-count')).toHaveTextContent('Selected photos: 3');
  });

  it('says so when the list is the favourites', () => {
    render(<CopyFilenamesDialog photos={photos.slice(0, 1)} source="favorites" onClose={() => {}} />);
    expect(screen.getByTestId('copy-filenames-count')).toHaveTextContent('Favorited photos: 1');
  });

  it('switches the separator to a space and back', () => {
    render(<CopyFilenamesDialog photos={photos} source="selection" onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Space' }));
    expect(textarea().value).toBe('IMG_0001 IMG_0002 c');
    fireEvent.click(screen.getByRole('button', { name: 'Comma' }));
    expect(textarea().value).toBe('IMG_0001,IMG_0002,c');
  });

  it('copies the joined text to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(<CopyFilenamesDialog photos={photos} source="selection" onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Space' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('IMG_0001 IMG_0002 c');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument());
  });

  it('selects the text and says so when the clipboard refuses', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn().mockRejectedValue(new Error('blocked')) } });
    render(<CopyFilenamesDialog photos={photos} source="selection" onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Copying was blocked'));
    expect(document.activeElement).toBe(textarea());
    expect(textarea().selectionStart).toBe(0);
    expect(textarea().selectionEnd).toBe(textarea().value.length);
  });

  it('closes on Escape and on the backdrop', () => {
    const onClose = vi.fn();
    render(<CopyFilenamesDialog photos={photos} source="selection" onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
