import React from 'react';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';

import { DownloadQuotaNotice } from '../DownloadQuotaNotice';
import { DownloadQuotaProvider } from '../../../contexts/DownloadQuotaContext';

vi.mock('react-toastify', () => ({ toast: { error: vi.fn() } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: any) => {
      let text = opts?.defaultValue ?? _key;
      for (const [k, v] of Object.entries(opts || {})) text = text.replace(`{{${k}}}`, String(v));
      return text;
    },
  }),
}));

const renderWith = (event: Record<string, unknown> | null, ui: React.ReactElement) => render(
  <QueryClientProvider client={new QueryClient()}>
    <DownloadQuotaProvider slug="g" event={event as any}>{ui}</DownloadQuotaProvider>
  </QueryClientProvider>
);

describe('DownloadQuotaNotice (issue 1560)', () => {
  it('renders nothing on an unlimited gallery', () => {
    const { container } = renderWith({ download_limit: null }, <DownloadQuotaNotice />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the counter', () => {
    renderWith({ download_limit: 10, downloads_used: 3, downloads_remaining: 7 }, <DownloadQuotaNotice />);
    expect(screen.getByTestId('download-quota-counter')).toHaveTextContent('3 of 10 downloads used');
  });

  it('flags a selection that needs more than is left, before the click', () => {
    const selection = Array.from({ length: 11 }, (_, i) => ({ id: i + 1 }));
    renderWith({ download_limit: 10, downloads_used: 0, downloads_remaining: 10 }, <DownloadQuotaNotice photos={selection} />);
    const notice = screen.getByRole('alert');
    expect(notice).toHaveTextContent('this selection needs 11 downloads, only 10 left');
  });

  it('prices already-downloaded photos at nothing', () => {
    const selection = [{ id: 1, download_granted: true }, { id: 2 }];
    renderWith({ download_limit: 10, downloads_used: 9, downloads_remaining: 1 }, <DownloadQuotaNotice photos={selection} />);
    expect(screen.getByRole('status')).toHaveTextContent('Uses 1 of your 1 remaining downloads');
  });
});
