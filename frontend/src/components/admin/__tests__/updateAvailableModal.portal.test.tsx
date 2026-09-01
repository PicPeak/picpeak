/**
 * UpdateAvailableModal is opened from VersionInfo, which lives inside
 * AdminSidebar. The sidebar's root carries Tailwind's `transform` utility for
 * its mobile slide-in, and a transformed ancestor becomes the containing block
 * for `position: fixed` descendants — so the modal's `fixed inset-0` backdrop
 * used to size itself to the 256px sidebar column instead of the viewport
 * (QA B.07). The modal must portal to document.body to escape that.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({ t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : k) }),
  };
});

vi.mock('../../../config/api', () => ({
  api: { get: vi.fn().mockResolvedValue({ data: {} }) },
}));

import { UpdateAvailableModal } from '../UpdateAvailableModal';

const renderModal = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    // Stand-in for AdminSidebar's transformed root.
    <div className="transform" style={{ transform: 'translateX(0)' }}>
      <QueryClientProvider client={client}>
        <UpdateAvailableModal
          currentVersion="1.0.0"
          latestVersion="1.1.0"
          onClose={() => {}}
          onDismiss={() => {}}
        />
      </QueryClientProvider>
    </div>
  );
};

describe('UpdateAvailableModal portal (QA B.07)', () => {
  it('renders the backdrop as a direct child of document.body', () => {
    renderModal();

    const backdrop = document.querySelector('.fixed.inset-0');
    expect(backdrop).not.toBeNull();
    expect(backdrop!.parentElement).toBe(document.body);
  });

  it('does not render the backdrop inside the transformed sidebar subtree', () => {
    const { container } = renderModal();

    const transformed = container.querySelector('.transform');
    expect(transformed).not.toBeNull();
    expect(transformed!.querySelector('.fixed.inset-0')).toBeNull();
    expect(container.querySelector('.fixed.inset-0')).toBeNull();
  });
});
