import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';

import { ThemeCustomizerEnhanced } from '../ThemeCustomizerEnhanced';
import type { ThemeConfig } from '../../../types/theme.types';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (_key: string, fallback?: string) => fallback ?? _key
    })
  };
});

// Component uses useQuery for admin-settings + fonts; tests don't exercise
// those data paths, so just give them a client that won't retry on the
// (intentionally absent) network.
const renderWithQueryClient = (ui: ReactElement) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
};

describe('ThemeCustomizerEnhanced', () => {
  const baseTheme: ThemeConfig = {
    primaryColor: '#000000',
    accentColor: '#ffffff',
    backgroundColor: '#eeeeee',
    textColor: '#111111',
    galleryLayout: 'grid',
    gallerySettings: {
      spacing: 'normal'
    }
  };

  it('invokes onApply when Apply Theme is clicked', async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();
    const handleApply = vi.fn().mockResolvedValue(undefined);

    renderWithQueryClient(
      <ThemeCustomizerEnhanced
        value={baseTheme}
        onChange={handleChange}
        presetName="default"
        onApply={handleApply}
      />
    );

    const applyButton = screen.getByRole('button', { name: /branding\.applyTheme/i });
    await user.click(applyButton);

    expect(handleChange).toHaveBeenCalled();
    expect(handleApply).toHaveBeenCalledTimes(1);
    expect(handleApply).toHaveBeenCalledWith(
      expect.objectContaining({ primaryColor: '#000000' }),
      expect.objectContaining({ presetName: 'default' })
    );
  });

  it('disables the Apply button while applying', () => {
    const handleChange = vi.fn();

    renderWithQueryClient(
      <ThemeCustomizerEnhanced
        value={baseTheme}
        onChange={handleChange}
        presetName="default"
        isApplying={true}
      />
    );

    const applyButton = screen.getByRole('button', { name: /applying/i });
    expect(applyButton).toBeDisabled();
  });
});
