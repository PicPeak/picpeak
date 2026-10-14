import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const settingsState: { data?: { expiry_time_zone?: string | null }; isPending: boolean } = { isPending: true };
vi.mock('../../../../hooks/usePublicSettings', () => ({
  usePublicSettings: () => settingsState,
}));

import { useDeliveryDue } from '../deliveryStatus';

// The badge must not show the UTC day's tone first and flip once the
// instance zone arrives.
describe('useDeliveryDue', () => {
  afterEach(() => {
    vi.useRealTimers();
    settingsState.data = undefined;
    settingsState.isPending = true;
  });

  it('answers nothing while the settings are loading', () => {
    const { result } = renderHook(() => useDeliveryDue());
    expect(result.current('2026-12-24T12:00:00.000Z')).toBeNull();
  });

  it('reads the promised day in the instance zone once they have answered', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-12-25T01:00:00Z'));
    settingsState.isPending = false;
    settingsState.data = { expiry_time_zone: 'Pacific/Honolulu' };
    const { result } = renderHook(() => useDeliveryDue());
    expect(result.current('2026-12-24T12:00:00.000Z')?.tone).toBe('soon');
  });

  it('falls back to the UTC day when the settings failed', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-12-25T01:00:00Z'));
    settingsState.isPending = false;
    const { result } = renderHook(() => useDeliveryDue());
    expect(result.current('2026-12-24T12:00:00.000Z')?.tone).toBe('overdue');
  });
});
