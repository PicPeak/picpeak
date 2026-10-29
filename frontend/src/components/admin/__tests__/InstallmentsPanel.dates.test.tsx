/**
 * The "Send on" preview adds an offset to the event date, a bare
 * 'YYYY-MM-DD' day (issue 2333). Read as UTC midnight and stepped with local
 * setDate, it lost a day across a DST change west of UTC. The suite pins the
 * browser's TZ itself, so it holds on a UTC CI runner too.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({ t: (k: string, d?: string) => d ?? k }),
}));
vi.mock('../../../hooks/useInstallmentDefaults', () => ({ useInstallmentDefaults: () => [] }));
vi.mock('../../common', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  LocalizedDateInput: ({ value }: { value: string }) => <input data-testid="send-on" readOnly value={value} />,
}));

import { InstallmentsPanel } from '../InstallmentsPanel';

let previousTz: string | undefined;
beforeAll(() => { previousTz = process.env.TZ; process.env.TZ = 'America/Los_Angeles'; });
afterAll(() => { if (previousTz === undefined) delete process.env.TZ; else process.env.TZ = previousTz; });

const plan = (trigger: 'after_event', offset: number) => [
  { label: 'Balance', percent: 100, trigger, offset_days: offset },
];

describe('InstallmentsPanel send-on preview, browser in Los Angeles', () => {
  it('adds days across the spring DST change', () => {
    // 8 March 2026: Los Angeles springs forward.
    render(<InstallmentsPanel value={plan('after_event', 2)} onChange={() => {}} eventDate="2026-03-07" />);
    expect((screen.getByTestId('send-on') as HTMLInputElement).value).toBe('2026-03-09');
  });

  it('adds days across the autumn DST change', () => {
    // 1 November 2026: Los Angeles falls back.
    render(<InstallmentsPanel value={plan('after_event', 2)} onChange={() => {}} eventDate="2026-10-31" />);
    expect((screen.getByTestId('send-on') as HTMLInputElement).value).toBe('2026-11-02');
  });
});
