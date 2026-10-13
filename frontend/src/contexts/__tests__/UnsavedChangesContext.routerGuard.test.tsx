/**
 * The router-level leave guard (issue 1733, fork survey).
 *
 * Pins:
 *  - browser Back with a dirty form asks; "Stay" keeps the page AND the
 *    history position, "Discard and leave" goes to the entry Back pointed at
 *  - a navigate() and a plain <Link> are caught, and go on to their own
 *    target once confirmed
 *  - a clean page never asks; saving, then navigating, does not ask
 *  - a guarded link (useGuardedLinkClick) still asks exactly once
 *  - a page syncing its own query string is left alone, a Settings tab
 *    change is not
 *  - the page's own exits (unguarded, the save bar's Discard) do not ask
 */
import { useState } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, Link, Outlet, RouterProvider, useLocation, useNavigate } from 'react-router-dom';

import { ConfirmDialogProvider } from '../../components/common/ConfirmDialog';
import { SettingsSaveBar } from '../../components/admin/SettingsSaveBar';
import {
  UnsavedChangesProvider,
  useGuardedLinkClick,
  useLeaveGuard,
  useUnsavedChanges,
} from '../UnsavedChangesContext';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({ t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : k) }),
  };
});

const discard = vi.fn();

/** A form that is dirty when asked to be, with every way out of the page. */
const Form = ({ dirty: initial = true }: { dirty?: boolean }) => {
  const [dirty, setDirty] = useState(initial);
  useUnsavedChanges(dirty, discard);
  const navigate = useNavigate();
  const guardedClick = useGuardedLinkClick();
  const { unguarded } = useLeaveGuard();
  return (
    <div>
      <p>form page</p>
      <button onClick={() => setDirty(false)}>save</button>
      <button onClick={() => navigate('/admin/other')}>navigate</button>
      <button onClick={() => navigate('/admin/form?section=two')}>same page</button>
      <button onClick={() => unguarded(() => navigate('/admin/other'))}>cancel</button>
      <Link to="/admin/other">plain link</Link>
      <a href="/admin/other" onClick={(e) => guardedClick(e, '/admin/other')}>guarded link</a>
    </div>
  );
};

const Where = () => {
  const { pathname, search } = useLocation();
  return <p data-testid="where">{pathname + search}</p>;
};

const Shell = () => (
  <UnsavedChangesProvider>
    <Where />
    <Outlet />
  </UnsavedChangesProvider>
);

function renderApp(formElement: React.ReactElement, initialEntries = ['/admin/start', '/admin/form']) {
  const router = createMemoryRouter(
    [{
      element: <Shell />,
      children: [
        { path: '/admin/start', element: <p>start page</p> },
        { path: '/admin/form', element: formElement },
        { path: '/admin/other', element: <p>other page</p> },
        { path: '/admin/settings', element: formElement },
      ],
    }],
    { initialEntries },
  );
  render(
    <ConfirmDialogProvider>
      <RouterProvider router={router} />
    </ConfirmDialogProvider>,
  );
  return router;
}

const dialog = () => screen.queryByText('Discard unsaved changes?');
const where = () => screen.getByTestId('where').textContent;

describe('router-level leave guard', () => {
  it('Back with a dirty form asks, and "Stay" keeps the page and the history position', async () => {
    const user = userEvent.setup();
    const router = renderApp(<Form />);

    await act(() => router.navigate(-1));
    expect(await screen.findByText('Discard unsaved changes?')).toBeInTheDocument();
    expect(screen.getAllByText('Discard unsaved changes?')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Stay' }));
    await waitFor(() => expect(dialog()).not.toBeInTheDocument());
    expect(screen.getByText('form page')).toBeInTheDocument();
    expect(where()).toBe('/admin/form');
    expect(discard).not.toHaveBeenCalled();

    // Still one step from the start: Back was undone, not swallowed.
    await act(() => router.navigate(-1));
    await user.click(await screen.findByRole('button', { name: 'Discard and leave' }));
    expect(await screen.findByText('start page')).toBeInTheDocument();
    expect(where()).toBe('/admin/start');
  });

  it('catches a navigate() and goes on to its target once confirmed', async () => {
    const user = userEvent.setup();
    renderApp(<Form />);

    await user.click(screen.getByRole('button', { name: 'navigate' }));
    expect(await screen.findByText('Discard unsaved changes?')).toBeInTheDocument();
    expect(screen.getByText('form page')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Stay' }));
    expect(where()).toBe('/admin/form');

    await user.click(screen.getByRole('button', { name: 'navigate' }));
    await user.click(await screen.findByRole('button', { name: 'Discard and leave' }));
    expect(await screen.findByText('other page')).toBeInTheDocument();
  });

  it('catches a plain <Link>', async () => {
    const user = userEvent.setup();
    renderApp(<Form />);

    await user.click(screen.getByRole('link', { name: 'plain link' }));
    expect(await screen.findByText('Discard unsaved changes?')).toBeInTheDocument();
    expect(where()).toBe('/admin/form');
  });

  it('never asks on a clean page', async () => {
    const user = userEvent.setup();
    const router = renderApp(<Form dirty={false} />);

    await user.click(screen.getByRole('button', { name: 'navigate' }));
    expect(await screen.findByText('other page')).toBeInTheDocument();
    await act(() => router.navigate(-1));
    await act(() => router.navigate(-1));
    expect(await screen.findByText('start page')).toBeInTheDocument();
    expect(dialog()).not.toBeInTheDocument();
  });

  it('does not ask when the form was saved first', async () => {
    const user = userEvent.setup();
    renderApp(<Form />);

    await user.click(screen.getByRole('button', { name: 'save' }));
    await user.click(screen.getByRole('button', { name: 'navigate' }));
    expect(await screen.findByText('other page')).toBeInTheDocument();
    expect(dialog()).not.toBeInTheDocument();
  });

  it('a guarded link asks once, not once per layer', async () => {
    const user = userEvent.setup();
    discard.mockClear();
    renderApp(<Form />);

    await user.click(screen.getByRole('link', { name: 'guarded link' }));
    expect(screen.getAllByText('Discard unsaved changes?')).toHaveLength(1);
    // The mock discard leaves the form dirty, as a slow re-render would: the
    // blocker must still let the confirmed navigation through.
    await user.click(screen.getByRole('button', { name: 'Discard and leave' }));
    expect(await screen.findByText('other page')).toBeInTheDocument();
    expect(dialog()).not.toBeInTheDocument();
    expect(discard).toHaveBeenCalledTimes(1);
  });

  it('leaves a page alone that changes only its own query string', async () => {
    const user = userEvent.setup();
    renderApp(<Form />);

    await user.click(screen.getByRole('button', { name: 'same page' }));
    await waitFor(() => expect(where()).toBe('/admin/form?section=two'));
    expect(dialog()).not.toBeInTheDocument();
  });

  it('closes the question when a navigation that needs none overtakes it', async () => {
    // The dialog is open and the admin presses Back to an entry of this same
    // page: that goes through, and the router drops the held navigation. The
    // dialog must not stay behind with buttons that no longer do anything.
    const user = userEvent.setup();
    const router = renderApp(<Form />, ['/admin/form?section=one', '/admin/form']);

    await user.click(screen.getByRole('button', { name: 'navigate' }));
    expect(await screen.findByText('Discard unsaved changes?')).toBeInTheDocument();

    await act(() => router.navigate(-1));
    await waitFor(() => expect(where()).toBe('/admin/form?section=one'));
    await waitFor(() => expect(dialog()).not.toBeInTheDocument());
    expect(screen.getByText('form page')).toBeInTheDocument();
  });

  it('asks when Back changes the Settings tab', async () => {
    const user = userEvent.setup();
    const router = renderApp(<Form />, ['/admin/settings?tab=email', '/admin/settings?tab=general']);

    await act(() => router.navigate(-1));
    await user.click(await screen.findByRole('button', { name: 'Stay' }));
    expect(where()).toBe('/admin/settings?tab=general');
  });

  it('asks on a Settings URL with a trailing slash too', async () => {
    const user = userEvent.setup();
    const router = renderApp(<Form />, ['/admin/settings/?tab=email', '/admin/settings/?tab=general']);

    await act(() => router.navigate(-1));
    await user.click(await screen.findByRole('button', { name: 'Stay' }));
    expect(where()).toBe('/admin/settings/?tab=general');
  });

  it('discards the draft of a Settings tab left with Back: the page stays mounted', async () => {
    // SettingsPage holds the General / Security / ... drafts above its tabs,
    // so they outlive the tab. Leaving one behind would bring the edits back,
    // unasked for, on Forward.
    const user = userEvent.setup();
    discard.mockClear();
    const router = renderApp(<Form />, ['/admin/settings?tab=email', '/admin/settings?tab=general']);

    await act(() => router.navigate(-1));
    await user.click(await screen.findByRole('button', { name: 'Stay' }));
    expect(discard).not.toHaveBeenCalled();

    await act(() => router.navigate(-1));
    await user.click(await screen.findByRole('button', { name: 'Discard and leave' }));
    await waitFor(() => expect(where()).toBe('/admin/settings?tab=email'));
    expect(discard).toHaveBeenCalledTimes(1);
  });

  it('does not run discard when the route itself is left: the form unmounts', async () => {
    const user = userEvent.setup();
    discard.mockClear();
    const router = renderApp(<Form />, ['/admin/start', '/admin/settings?tab=general']);

    await act(() => router.navigate(-1));
    await user.click(await screen.findByRole('button', { name: 'Discard and leave' }));
    expect(await screen.findByText('start page')).toBeInTheDocument();
    expect(discard).not.toHaveBeenCalled();
  });

  it("does not question the page's own Cancel", async () => {
    const user = userEvent.setup();
    renderApp(<Form />);

    await user.click(screen.getByRole('button', { name: 'cancel' }));
    expect(await screen.findByText('other page')).toBeInTheDocument();
    expect(dialog()).not.toBeInTheDocument();
  });

  it('does not question a save-bar Discard that leaves the page', async () => {
    // The "new document" editors: dirty until created, Discard goes to the list.
    const Editor = () => {
      const navigate = useNavigate();
      return <SettingsSaveBar isDirty onSave={vi.fn()} onDiscard={() => navigate('/admin/other')} />;
    };
    const user = userEvent.setup();
    renderApp(<Editor />);

    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(await screen.findByText('other page')).toBeInTheDocument();
    expect(dialog()).not.toBeInTheDocument();
  });
});
