/**
 * An install can hold a cron expression in backup_schedule itself. The form
 * showed it as "Every hour", and saving sent the default backup_schedule_cron
 * (0 3 * * *), which the backend then ran instead: the backup moved without
 * anyone choosing it. The form now shows the schedule that is in effect.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { BackupConfiguration } from '../BackupConfiguration';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
      i18n: { language: 'en' },
    }),
  };
});

const base = { backup_destination_type: 'local' as const, backup_destination_path: '/srv/backups' };

const renderForm = (config: Record<string, unknown>) => {
  const onSave = vi.fn();
  render(<BackupConfiguration config={{ ...base, ...config }} onSave={onSave} isSaving={false} />);
  return onSave;
};

const scheduleSelect = () => screen.getByDisplayValue(/backup.configuration.schedule.options/) as HTMLSelectElement;
const save = () => userEvent.click(screen.getByRole('button', { name: /backup.configuration.saveSettings/ }));

describe('BackupConfiguration schedule', () => {
  it('shows a cron stored in backup_schedule as Custom, and saves the same schedule', async () => {
    const onSave = renderForm({ backup_schedule: '0 2 * * *' });

    expect(scheduleSelect().value).toBe('custom');
    expect(screen.getByDisplayValue('0 2 * * *')).toBeInTheDocument();

    await save();
    expect(onSave.mock.calls[0][0]).toEqual(expect.objectContaining({
      backup_schedule: 'custom',
      backup_schedule_cron: '0 2 * * *',
    }));
  });

  it('shows the cron field when it is set, because that is the one the backend runs', async () => {
    renderForm({ backup_schedule: '0 2 * * *', backup_schedule_cron: '0 3 * * *' });

    expect(scheduleSelect().value).toBe('custom');
    expect(screen.getByDisplayValue('0 3 * * *')).toBeInTheDocument();
  });

  it('leaves a named schedule alone', async () => {
    const onSave = renderForm({ backup_schedule: 'weekly', backup_schedule_cron: '0 3 * * *' });

    expect(scheduleSelect().value).toBe('weekly');
    await save();
    expect(onSave.mock.calls[0][0]).toEqual(expect.objectContaining({ backup_schedule: 'weekly' }));
  });
});

describe('BackupConfiguration schedule: every stored shape saves back what runs', () => {
  // Backend order (resolveScheduleCron): named label, then a five-field
  // backup_schedule_cron, then a cron in backup_schedule, else daily 02:00.
  it.each([
    ['custom label, no cron', { backup_schedule: 'custom' }, { backup_schedule: 'daily' }],
    ['unknown label, no cron', { backup_schedule: 'yearly' }, { backup_schedule: 'daily' }],
    ['unknown label with a cron', { backup_schedule: 'yearly', backup_schedule_cron: '0 6 * * *' }, { backup_schedule: 'custom', backup_schedule_cron: '0 6 * * *' }],
    ['a cron and no label', { backup_schedule_cron: '0 5 * * *' }, { backup_schedule: 'custom', backup_schedule_cron: '0 5 * * *' }],
    ['a named label in another case', { backup_schedule: ' Weekly ' }, { backup_schedule: 'weekly' }],
    ['monthly', { backup_schedule: 'monthly', backup_schedule_cron: '0 3 * * *' }, { backup_schedule: 'monthly' }],
  ])('%s', async (_name, stored, expected) => {
    const onSave = renderForm(stored);
    await save();
    expect(onSave.mock.calls[0][0]).toEqual(expect.objectContaining(expected));
  });

  it('shows monthly as monthly', () => {
    renderForm({ backup_schedule: 'monthly' });
    expect(scheduleSelect().value).toBe('monthly');
  });
});

describe('BackupConfiguration destination highlight', () => {
  it('marks the selected destination with classes Tailwind actually emits', () => {
    renderForm({});
    const selected = screen.getByRole('button', { name: /destinationTypes.local.name/ });
    const other = screen.getByRole('button', { name: /destinationTypes.s3.name/ });

    expect(selected.className).toContain('border-primary-600');
    expect(selected.querySelector('svg')?.getAttribute('class')).toContain('text-primary-600');
    expect(other.className).not.toContain('border-primary-600');
    expect(selected.className).not.toMatch(/border-primary(\s|$)|accent-dark\//);
  });
});
