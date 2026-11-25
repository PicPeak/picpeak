import React, { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * The lightbox reads the gallery's feedback settings through React Query, as
 * under GalleryView: a client of its own per rendered tree.
 */
export function LightboxQueryWrapper({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
