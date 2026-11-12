/**
 * Settings → Appearance → Crop focus (issue 2377): "Detect again" queues the
 * gallery's photos at once, says how many, and is off for an archived
 * gallery or an admin who may not edit it.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { Event } from '../../../../../types';

const { redetect, success, error } = vi.hoisted(() => ({ redetect: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('../../../../../services/photos.service', () => ({ photosService: { redetectFocalPoints: redetect } }));
vi.mock('react-toastify', () => ({ toast: { success, error } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => {
      if (typeof fallback === 'string') return fallback;
      const opts = fallback as { count?: number; defaultValue_other?: string } | undefined;
      return opts?.defaultValue_other ? opts.defaultValue_other.replace('{{count}}', String(opts.count)) : key;
    },
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

import { CropFocusRedetect } from '../AppearanceSection';

const event = { id: 7, is_archived: false } as unknown as Event;
const button = () => screen.getByRole('button', { name: /Detect again/ });

describe('Crop focus: Detect again', () => {
  beforeEach(() => { redetect.mockReset(); success.mockReset(); error.mockReset(); });

  it('queues the gallery and says how many photos', async () => {
    redetect.mockResolvedValue({ queued: 12 });
    render(<CropFocusRedetect event={event} disabled={false} />);
    fireEvent.click(button());
    await waitFor(() => expect(success).toHaveBeenCalledWith('12 photos queued. Their thumbnails are cut again in the background.'));
    expect(redetect).toHaveBeenCalledWith(7);
  });

  it('says so when the request fails', async () => {
    redetect.mockRejectedValue(new Error('500'));
    render(<CropFocusRedetect event={event} disabled={false} />);
    fireEvent.click(button());
    await waitFor(() => expect(error).toHaveBeenCalledWith('The photos could not be queued.'));
  });

  it('is off when the gallery cannot be changed', () => {
    render(<CropFocusRedetect event={event} disabled />);
    expect(button()).toBeDisabled();
  });
});
