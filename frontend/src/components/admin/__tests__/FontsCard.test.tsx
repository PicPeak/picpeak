/**
 * Fonts in the branding settings (issue 2618): the families the galleries
 * and the website offer, an upload for new ones, and removing an uploaded one.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : k) }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../common/ConfirmDialog', () => ({ useConfirm: () => () => Promise.resolve(true) }));
vi.mock('../../../services/fonts.service', () => ({
  fontsService: {
    listAdmin: vi.fn().mockResolvedValue([
      { family: 'Inter', weights: [400, 700], generic: 'sans-serif', source: 'bundled' },
      { family: 'Studio Serif', weights: [400], generic: 'serif', source: 'uploaded' },
    ]),
    upload: vi.fn().mockResolvedValue({ family: 'New Face', weight: 700, format: 'woff2' }),
    remove: vi.fn().mockResolvedValue(undefined),
  },
}));

import { fontsService } from '../../../services/fonts.service';
import { FontsCard } from '../FontsCard';

describe('FontsCard', () => {
  it('lists the fonts, uploads one with its name and weight, and removes only uploaded ones', async () => {
    render(<QueryClientProvider client={new QueryClient()}><FontsCard /></QueryClientProvider>);
    expect(await screen.findByText('Studio Serif')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Remove/ })).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Font name'), { target: { value: 'New Face' } });
    fireEvent.change(screen.getByLabelText('Weight'), { target: { value: '700' } });
    const file = new File([new Uint8Array([0x77, 0x4f, 0x46, 0x32])], 'new.woff2', { type: 'font/woff2' });
    fireEvent.change(screen.getByLabelText('Font file'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Upload font' }));
    await waitFor(() => expect(fontsService.upload).toHaveBeenCalledWith(file, { family: 'New Face', weight: 700, generic: 'sans-serif' }));
    fireEvent.click(screen.getByRole('button', { name: /Remove/ }));
    await waitFor(() => expect(fontsService.remove).toHaveBeenCalledWith('Studio Serif'));
  });
});
