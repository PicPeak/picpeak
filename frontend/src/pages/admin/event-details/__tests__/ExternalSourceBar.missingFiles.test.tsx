/**
 * Photos whose file is gone from the external folder (issue 2121): the
 * source line counts them and filters the grid to them, so the admin can
 * find and delete them.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { ExternalSourceBar } from '../ExternalSourceBar';
import type { Event } from '../../../../types';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, ...args: unknown[]) => {
        const opts = args.find((a): a is { count: number } => typeof a === 'object' && a !== null && 'count' in a);
        return opts ? `${key}:${opts.count}` : key;
      },
      i18n: { language: 'en' },
    }),
  };
});
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));
vi.mock('../../../../hooks/usePermission', () => ({ usePermission: () => true }));
const { importState } = vi.hoisted(() => ({ importState: { missingFiles: 0 } }));
vi.mock('../useExternalImport', () => ({
  useExternalImport: () => ({
    canImport: true, canRun: true, running: false, failed: false, failureText: '', statusText: '',
    buttonLabel: 'Rescan', run: vi.fn(), missingFiles: importState.missingFiles,
  }),
}));

const event = { id: 4, source_mode: 'reference', external_path: 'shoot', folder_structure: false, is_archived: false } as unknown as Event;

const renderBar = (props: Partial<React.ComponentProps<typeof ExternalSourceBar>>) => render(
  <QueryClientProvider client={new QueryClient()}>
    <ExternalSourceBar event={event} onChangeFolder={vi.fn()} {...props} />
  </QueryClientProvider>,
);

describe('ExternalSourceBar — missing files', () => {
  it('offers no filter while every file is there', () => {
    importState.missingFiles = 0;
    renderBar({ onToggleMissing: vi.fn() });
    expect(screen.queryByRole('button', { name: /missingFiles/ })).not.toBeInTheDocument();
  });

  it('counts the missing files and toggles the filter', async () => {
    importState.missingFiles = 3;
    const toggle = vi.fn();
    renderBar({ onToggleMissing: toggle });
    const button = screen.getByRole('button', { name: 'events.externalSource.missingFiles:3' });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(button);
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('stays while the filter is on, so it can be switched off', () => {
    importState.missingFiles = 0;
    renderBar({ onToggleMissing: vi.fn(), missingFilter: true });
    expect(screen.getByRole('button', { name: /missingFiles/ })).toHaveAttribute('aria-pressed', 'true');
  });
});
