import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-query', () => ({ useQuery: query }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: unknown) => (typeof options === 'string' ? options : key),
    i18n: { language: 'en' },
  }),
}));
vi.mock('../../common', () => ({
  Card: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
}));
const canManage = vi.hoisted(() => vi.fn(() => false));
vi.mock('../../../hooks', () => ({ useMutationWithToast: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock('../../../hooks/usePermission', () => ({ usePermission: canManage }));
vi.mock('../../../hooks/useLocalizedDate', () => ({ useLocalizedDate: () => ({ formatDateTime: String }) }));
vi.mock('../../../services/systemHealth.service', () => ({ systemHealthService: {} }));

import { DependencyStatusCard } from '../DependencyStatusCard';

describe('DependencyStatusCard', () => {
  afterEach(cleanup);

  it('renders nothing before the first probe has reported', () => {
    query.mockReturnValue({ data: undefined });
    const { container } = render(<DependencyStatusCard />);
    expect(container.textContent).toBe('');
  });

  it('shows a failing dependency with its detail and the paused feature', () => {
    query.mockReturnValue({ data: {
      enforcement: 'enforce',
      forcedOff: [],
      load: { level: 0, applied: true, throttlePercent: 70, resumePercent: 50 },
      dependencies: {
        storage: { state: 'down', since: '2026-11-01T10:00:00Z', detail: 'EIO', metrics: null },
        disk: { state: 'healthy', since: '2026-11-01T10:00:00Z', detail: null, metrics: { freeBytes: 2 * 1024 ** 3 } },
      },
      capabilities: [{ name: 'uploads.new', available: false, paused: true, forced: false, blockedBy: ['storage'] }],
    } });
    render(<DependencyStatusCard />);
    expect(screen.getByText('EIO')).toBeTruthy();
    expect(screen.getByText('systemHealth.dependencies.state.down')).toBeTruthy();
    expect(screen.getByText('systemHealth.dependencies.unavailable')).toBeTruthy();
    expect(screen.getByText('systemHealth.dependencies.metrics.free')).toBeTruthy();
  });

  it('offers the controls only with system.manage', () => {
    query.mockReturnValue({ data: {
      enforcement: 'observe',
      forcedOff: [],
      load: { level: 1, applied: false, throttlePercent: 70, resumePercent: 50 },
      dependencies: { disk: { state: 'healthy', since: '', detail: null, metrics: null } },
      capabilities: [{ name: 'uploads.new', available: false, paused: false, forced: false, blockedBy: ['storage'] }],
    } });
    const { unmount } = render(<DependencyStatusCard />);
    expect(screen.queryByText('systemHealth.dependencies.recheck')).toBeNull();
    expect(screen.getByText('systemHealth.dependencies.wouldPause')).toBeTruthy();
    expect(screen.queryByText('systemHealth.dependencies.unavailable')).toBeNull();
    unmount();
    canManage.mockReturnValue(true);
    render(<DependencyStatusCard />);
    expect(screen.getByText('systemHealth.dependencies.recheck')).toBeTruthy();
    expect(screen.getByText('systemHealth.dependencies.enforce')).toBeTruthy();
    expect(screen.getAllByText('systemHealth.dependencies.wouldThrottle').length).toBe(1);
  });
});
