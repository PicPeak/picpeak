import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { ExpirationBanner } from '../ExpirationBanner';

const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();

function bannerClass(daysRemaining: number) {
  render(<ExpirationBanner daysRemaining={daysRemaining} expiresAt={expiresAt} />);
  return screen.getByTestId('expiration-banner').className;
}

afterEach(cleanup);

describe('ExpirationBanner urgency', () => {
  it('uses three distinct tiers over the last week', () => {
    const lastDay = bannerClass(1);
    cleanup();
    const threeDays = bannerClass(3);
    cleanup();
    const week = bannerClass(7);
    expect(lastDay).toContain('bg-danger');
    expect(threeDays).toContain('bg-warning');
    expect(week).toContain('bg-warning-soft');
    expect(new Set([lastDay, threeDays, week]).size).toBe(3);
  });
});
