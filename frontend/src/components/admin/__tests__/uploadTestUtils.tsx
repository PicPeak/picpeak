import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';

import { UploadSessionProvider } from '../../../contexts/UploadSessionContext';
import { UploadProgressBar } from '../UploadProgressBar';

/**
 * The admin uploader is three parts: PhotoUpload picks files, the upload runs
 * in UploadSessionProvider, and UploadProgressBar shows progress and the
 * failure report. Tests that drive an upload need all three, wired the way
 * AdminLayout wires them.
 */
export const renderWithUploadSession = (ui: ReactElement, initialPath = '/admin/events/1') => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <UploadSessionProvider>
          <UploadProgressBar />
          {ui}
        </UploadSessionProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { ...result, queryClient };
};
