/**
 * The upload modal is only the picker: it closes the moment the files are
 * handed to the upload session (discussion 1541 — users were held in a modal
 * that did nothing until processing finished). Progress and the failure
 * report live in UploadProgressBar, covered in UploadProgressBar.test.tsx.
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

// Stub PhotoUpload: a button that reports the upload as started.
vi.mock('../PhotoUpload', () => ({
  PhotoUpload: ({ onUploadStarted }: any) => (
    <button onClick={() => onUploadStarted?.()}>start-upload</button>
  ),
}));

describe('PhotoUploadModal', () => {
  it('closes as soon as the upload starts', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<PhotoUploadModal isOpen eventId={1} onClose={onClose} />);

    await user.click(screen.getByText('start-upload'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders nothing while closed', () => {
    render(<PhotoUploadModal isOpen={false} eventId={1} onClose={vi.fn()} />);
    expect(screen.queryByText('start-upload')).not.toBeInTheDocument();
  });
});
