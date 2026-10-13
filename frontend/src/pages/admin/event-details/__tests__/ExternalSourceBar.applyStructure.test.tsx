import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { ExternalSourceBar } from '../ExternalSourceBar';
import type { Event } from '../../../../types';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return { ...actual, useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) };
});
const { toastMock, applyMock } = vi.hoisted(() => ({
  toastMock: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
  applyMock: vi.fn(),
}));
vi.mock('react-toastify', () => ({ toast: toastMock }));
vi.mock('../../../../services/folders.service', async () => {
  const actual = await vi.importActual<typeof import('../../../../services/folders.service')>('../../../../services/folders.service');
  return { ...actual, foldersService: { applyExternalStructure: applyMock } };
});
vi.mock('../../../../hooks/usePermission', () => ({ usePermission: () => true }));
vi.mock('../useExternalImport', () => ({
  useExternalImport: () => ({ canImport: true, canRun: true, running: false, failed: false, failureText: '', statusText: '', buttonLabel: 'Rescan', run: vi.fn() }),
}));
vi.mock('../../../../components/common', async () => {
  const actual = await vi.importActual<typeof import('../../../../components/common')>('../../../../components/common');
  return { ...actual, useConfirm: () => async () => true };
});

const event = { id: 4, source_mode: 'reference', external_path: 'shoot', folder_structure: true, is_archived: false } as unknown as Event;

describe('ExternalSourceBar — apply folder structure', () => {
  it('warns when the folder limit made photos land in a parent folder', async () => {
    applyMock.mockResolvedValue({ moved: 3, limited: true, folders: [] });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ExternalSourceBar event={event} onChangeFolder={vi.fn()} />
      </QueryClientProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: /events.externalSource.applyStructure/ }));
    await waitFor(() => expect(toastMock.warning).toHaveBeenCalledWith('events.externalSource.structureLimited'));
    expect(toastMock.success).toHaveBeenCalled();
  });

  it('shows the translated reason for a refused change', async () => {
    toastMock.warning.mockClear();
    applyMock.mockRejectedValue({ response: { data: { error: 'English', code: 'FOLDER_LIMIT_REACHED', limit: 1000 } } });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ExternalSourceBar event={event} onChangeFolder={vi.fn()} />
      </QueryClientProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: /events.externalSource.applyStructure/ }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('photos.folders.errors.limitReached'));
  });
});
