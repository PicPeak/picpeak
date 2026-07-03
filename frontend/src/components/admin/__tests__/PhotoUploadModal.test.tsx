/**
 * The upload modal must keep itself open when an upload partially fails, so
 * the failure report stays visible; a clean upload still auto-closes. We stub
 * PhotoUpload with buttons that fire its onUploadSettled callback both ways.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { PhotoUploadModal } from '../PhotoUploadModal';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({ t: (_k: string, fb?: any) => (typeof fb === 'string' ? fb : _k) }),
  };
});

// Stub PhotoUpload: expose buttons that settle clean vs. with failures.
vi.mock('../PhotoUpload', () => ({
  PhotoUpload: ({ onUploadSettled }: any) => (
    <div>
      <button onClick={() => onUploadSettled?.({ hasFailures: false })}>settle-clean</button>
      <button onClick={() => onUploadSettled?.({ hasFailures: true })}>settle-failed</button>
    </div>
  ),
}));

describe('PhotoUploadModal auto-close behaviour', () => {
  it('closes after a clean upload', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<PhotoUploadModal isOpen eventId={1} onClose={onClose} />);

    await user.click(screen.getByText('settle-clean'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stays open when some files failed', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<PhotoUploadModal isOpen eventId={1} onClose={onClose} />);

    await user.click(screen.getByText('settle-failed'));
    expect(onClose).not.toHaveBeenCalled();
  });
});
