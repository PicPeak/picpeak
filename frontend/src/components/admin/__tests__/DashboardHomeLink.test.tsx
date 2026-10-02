/**
 * The admin brand as the home button.
 *
 * Pins:
 *  - with nothing dirty it goes straight to the dashboard, no prompt
 *  - with a dirty form it asks first; "stay" keeps the page and the edits,
 *    "discard" runs the form's discard and then goes to the dashboard
 *  - onNavigate (closes the mobile drawer) runs only when navigation goes ahead
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { DashboardHomeLink } from '../DashboardHomeLink';
import { UnsavedChangesProvider, useUnsavedChanges } from '../../../contexts/UnsavedChangesContext';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({ t: (_k: string, fb?: any) => (typeof fb === 'string' ? fb : _k) }),
  };
});

// The confirm dialog is replaced by a controllable promise.
const confirmMock = vi.fn<() => Promise<boolean>>();
vi.mock('../../common/ConfirmDialog', () => ({
  useConfirm: () => confirmMock,
}));

const Form = ({ dirty, onDiscard }: { dirty: boolean; onDiscard: () => void }) => {
  useUnsavedChanges(dirty, onDiscard);
  return <p>settings page</p>;
};

const renderAt = (dirty: boolean, onDiscard = vi.fn(), onNavigate = vi.fn()) => {
  render(
    <MemoryRouter initialEntries={['/admin/settings']}>
      <UnsavedChangesProvider>
        <DashboardHomeLink onNavigate={onNavigate}>PicPeak</DashboardHomeLink>
        <Routes>
          <Route path="/admin/settings" element={<Form dirty={dirty} onDiscard={onDiscard} />} />
          <Route path="/admin/dashboard" element={<p>dashboard page</p>} />
        </Routes>
      </UnsavedChangesProvider>
    </MemoryRouter>
  );
  return { onDiscard, onNavigate };
};

describe('DashboardHomeLink', () => {
  beforeEach(() => confirmMock.mockReset());

  it('is a link to the dashboard named by the brand it renders', () => {
    renderAt(false);
    const link = screen.getByRole('link', { name: 'PicPeak' });
    expect(link).toHaveAttribute('href', '/admin/dashboard');
  });

  it('goes straight to the dashboard when nothing is dirty', async () => {
    const user = userEvent.setup();
    const { onNavigate } = renderAt(false);
    await user.click(screen.getByRole('link', { name: 'PicPeak' }));
    expect(await screen.findByText('dashboard page')).toBeInTheDocument();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it('stays on the page with the edits when the user chooses to stay', async () => {
    confirmMock.mockResolvedValue(false);
    const user = userEvent.setup();
    const { onDiscard, onNavigate } = renderAt(true);
    await user.click(screen.getByRole('link', { name: 'PicPeak' }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(screen.getByText('settings page')).toBeInTheDocument();
    expect(screen.queryByText('dashboard page')).not.toBeInTheDocument();
    expect(onDiscard).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('discards the edits and goes to the dashboard when the user confirms', async () => {
    confirmMock.mockResolvedValue(true);
    const user = userEvent.setup();
    const { onDiscard, onNavigate } = renderAt(true);
    await user.click(screen.getByRole('link', { name: 'PicPeak' }));
    expect(await screen.findByText('dashboard page')).toBeInTheDocument();
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});
