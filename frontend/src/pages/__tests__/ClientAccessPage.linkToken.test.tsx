import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ clientLogin: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('../../contexts', () => ({
  useGalleryAuth: () => ({
    isAuthenticated: false,
    isClient: false,
    clientLogin: mocks.clientLogin,
    isLoading: false,
  }),
}));
vi.mock('../../hooks/useGallery', () => ({
  useGalleryInfo: () => ({ data: { event_name: 'Private gallery' }, isLoading: false, error: null }),
}));
vi.mock('../../hooks/usePublicSettings', () => ({
  usePublicSettings: () => ({ data: { branding_hide_powered_by: true } }),
}));
vi.mock('../../hooks/usePublicDarkMode', () => ({
  usePublicDarkMode: () => ({ isDark: false }),
}));

import { ClientAccessPage } from '../ClientAccessPage';

function renderPage(query = '') {
  return render(
    <MemoryRouter initialEntries={[`/gallery/private-client/client-access${query}`]}>
      <Routes>
        <Route path="/gallery/:slug/client-access" element={<ClientAccessPage />} />
        <Route path="/gallery/:slug" element={<div>gallery</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

async function submitPin() {
  fireEvent.change(screen.getByLabelText('clientAccess.pinLabel'), { target: { value: '2468' } });
  fireEvent.click(screen.getByRole('button', { name: 'clientAccess.loginButton' }));
}

describe('ClientAccessPage private-link binding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.clientLogin.mockResolvedValue({});
  });

  it('submits the current link token with the PIN', async () => {
    const token = 'a'.repeat(64);
    renderPage(`?token=${token}`);

    await submitPin();

    await waitFor(() => expect(mocks.clientLogin).toHaveBeenCalledWith('private-client', '2468', token));
  });

  it('does not submit a tokenless client-access URL', async () => {
    renderPage();

    await submitPin();

    expect(mocks.clientLogin).not.toHaveBeenCalled();
    // A missing link is named as such, not as a wrong PIN to retry.
    expect(screen.getByText('clientAccess.linkInvalid')).toBeInTheDocument();
    expect(screen.queryByText('clientAccess.invalidPin')).toBeNull();
  });
});
