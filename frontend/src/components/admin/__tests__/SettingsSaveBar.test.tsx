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
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

import { SettingsSaveBar } from '../SettingsSaveBar';
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
});
