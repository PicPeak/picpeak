/**
 * "Forget me" says what it removes (#1561).
 *
 * In guest identity mode the identity carries the guest's feedback, so its
 * name and selections go. Outside it the identity is only an uploader name:
 * feedback is anonymous and never belonged to it, so the confirmation must
 * not promise the selections are removed.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { GalleryLayout } from '../GalleryLayout';

const identityState: { identityMode: 'simple' | 'guest' } = { identityMode: 'guest' };
const forget = vi.fn();

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, second?: any) => (typeof second === 'string' ? second : key),
      i18n: { language: 'en' },
    }),
  };
});

vi.mock('../../../contexts/ThemeContext', async () => {
  const actual = await vi.importActual<typeof import('../../../contexts/ThemeContext')>(
    '../../../contexts/ThemeContext'
  );
  return { ...actual, useTheme: () => ({ theme: {} }) };
});

vi.mock('../../../services/cms.service', () => ({
  cmsService: { getPublicPage: vi.fn().mockRejectedValue(new Error('no cms')) },
}));

vi.mock('../../../contexts/GuestIdentityContext', () => ({
  useGuestIdentityOptional: () => ({
    identityMode: identityState.identityMode,
    identity: { id: 1, name: 'Anna', email: null, identifier: 'x' },
    forget,
    signOut: vi.fn(),
  }),
}));

function confirmTextFor(identityMode: 'simple' | 'guest') {
  identityState.identityMode = identityMode;
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { unmount } = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <GalleryLayout event={{ event_name: 'ZZTEST Wedding' }}>
          <div>photos</div>
        </GalleryLayout>
      </MemoryRouter>
    </QueryClientProvider>
  );
  fireEvent.click(screen.getByRole('button', { name: 'Forget me ({{name}})' }));
  const text = confirm.mock.calls[0]?.[0];
  unmount();
  return text;
}

describe('GalleryLayout "Forget me"', () => {
  afterEach(() => vi.restoreAllMocks());

  it('promises the selections go only in guest identity mode', () => {
    expect(confirmTextFor('guest')).toBe('Your name and selections will be removed from this gallery.');
  });

  it('names only the uploads for an uploader-only identity', () => {
    expect(confirmTextFor('simple')).toBe('Your name will be removed from the photos you uploaded to this gallery.');
    expect(forget).not.toHaveBeenCalled();
  });
});
