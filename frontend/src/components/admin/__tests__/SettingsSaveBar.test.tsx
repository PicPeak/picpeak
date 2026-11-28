/**
 * The shared settings save bar (discussion 1541, point 3) and the leave guard
 * behind it.
 *
 * Pins:
 *  - Save and Discard are disabled while the draft equals the server state,
 *    and the "unsaved changes" hint appears only when it does not
 *  - canSave gates Save on top of dirty (validation errors)
 *  - a dirty bar arms the leave guard: confirmLeave asks, and on "discard"
 *    runs the form's discard before resolving true; on "stay" resolves false
 *  - with nothing dirty, confirmLeave resolves true without asking
 *  - inside AdminLayout (a slot in BottomBarSlotContext) the bar renders into
 *    the slot, the path every page takes; without one it renders in place
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

import { SettingsSaveBar } from '../SettingsSaveBar';
import { BottomBarSlotContext } from '../bottomBarSlot';
import { UnsavedChangesProvider, useLeaveGuard } from '../../../contexts/UnsavedChangesContext';

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

const LeaveButton = ({ onResult }: { onResult: (ok: boolean) => void }) => {
  const { confirmLeave, isAnyDirty } = useLeaveGuard();
  return (
    <button onClick={() => { void confirmLeave().then(onResult); }}>
      leave {isAnyDirty ? '(dirty)' : '(clean)'}
    </button>
  );
};

const renderBar = (ui: ReactElement) => render(<UnsavedChangesProvider>{ui}</UnsavedChangesProvider>);

describe('SettingsSaveBar', () => {
  it('disables both buttons and hides the hint while clean', () => {
    renderBar(<SettingsSaveBar isDirty={false} onSave={vi.fn()} onDiscard={vi.fn()} />);
    expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /discard/i })).toBeDisabled();
    expect(screen.queryByText(/unsaved changes/i)).not.toBeInTheDocument();
  });

  it('says what is unsaved in the page\'s own words when the page gives them, in place of the general hint', () => {
    renderBar(<SettingsSaveBar isDirty unsavedHint="Contact form settings are not saved yet." onSave={vi.fn()} onDiscard={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('Contact form settings are not saved yet.');
    expect(screen.queryByText(/You have unsaved changes/i)).not.toBeInTheDocument();
  });

  it('saveClean offers Save on a clean draft, and nothing else', () => {
    // A fallback reminder template is seeded from the default, so the draft
    // reads clean; saving it is what creates the dedicated copy. Discard and
    // the hint still follow isDirty, so nothing claims there are edits.
    renderBar(
      <>
        <SettingsSaveBar isDirty={false} saveClean onSave={vi.fn()} onDiscard={vi.fn()} />
        <LeaveButton onResult={vi.fn()} />
      </>
    );
    expect(screen.getByRole('button', { name: /save changes/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /discard/i })).toBeDisabled();
    expect(screen.queryByText(/unsaved changes/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^leave/ })).toHaveTextContent('(clean)');
  });

  it('enables Save and Discard and shows the hint when dirty', async () => {
    const onSave = vi.fn();
    const onDiscard = vi.fn();
    const user = userEvent.setup();
    renderBar(<SettingsSaveBar isDirty onSave={onSave} onDiscard={onDiscard} />);

    expect(screen.getByText(/unsaved changes/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /save changes/i }));
    expect(onSave).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: /discard/i }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it('keeps Save disabled while canSave is false, Discard stays available', () => {
    renderBar(<SettingsSaveBar isDirty canSave={false} onSave={vi.fn()} onDiscard={vi.fn()} />);
    expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /discard/i })).toBeEnabled();
  });
});

describe('leave guard', () => {
  it('lets navigation through without asking when nothing is dirty', async () => {
    const onResult = vi.fn();
    const user = userEvent.setup();
    renderBar(
      <>
        <SettingsSaveBar isDirty={false} onSave={vi.fn()} onDiscard={vi.fn()} />
        <LeaveButton onResult={onResult} />
      </>
    );
    await user.click(screen.getByText(/leave \(clean\)/));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it('asks when dirty, and runs the form discard when the user leaves', async () => {
    confirmMock.mockResolvedValueOnce(true);
    const onDiscard = vi.fn();
    const onResult = vi.fn();
    const user = userEvent.setup();
    renderBar(
      <>
        <SettingsSaveBar isDirty onSave={vi.fn()} onDiscard={onDiscard} />
        <LeaveButton onResult={onResult} />
      </>
    );
    await user.click(screen.getByText(/leave \(dirty\)/));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it('keeps the user on the page when they choose to stay', async () => {
    confirmMock.mockResolvedValueOnce(false);
    const onDiscard = vi.fn();
    const onResult = vi.fn();
    const user = userEvent.setup();
    renderBar(
      <>
        <SettingsSaveBar isDirty onSave={vi.fn()} onDiscard={onDiscard} />
        <LeaveButton onResult={onResult} />
      </>
    );
    await user.click(screen.getByText(/leave \(dirty\)/));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it('renders into the layout slot when there is one, and still works there', async () => {
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    const onSave = vi.fn();
    const user = userEvent.setup();
    const { container } = renderBar(
      <BottomBarSlotContext.Provider value={slot}>
        <SettingsSaveBar isDirty onSave={onSave} onDiscard={vi.fn()} />
      </BottomBarSlotContext.Provider>
    );

    const bar = screen.getByTestId('settings-save-bar');
    expect(slot).toContainElement(bar);
    expect(container).not.toContainElement(bar);
    // In the slot the layout positions it; the in-page sticky classes are only for the fallback.
    expect(bar.className).not.toMatch(/sticky/);
    await user.click(screen.getByRole('button', { name: /save changes/i }));
    expect(onSave).toHaveBeenCalledTimes(1);
    slot.remove();
  });

  it('renders in place with its own sticky classes outside the layout', () => {
    const { container } = renderBar(<SettingsSaveBar isDirty={false} onSave={vi.fn()} onDiscard={vi.fn()} />);
    const bar = screen.getByTestId('settings-save-bar');
    expect(container).toContainElement(bar);
    expect(bar.className).toMatch(/sticky bottom-0/);
  });
});
