import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../../../i18n/locales/en.json';

const query = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-query', () => ({ useQuery: query }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, fallback?: unknown) => {
  const value = key.split('.').reduce<unknown>((value, segment) => (
    value && typeof value === 'object' ? (value as Record<string, unknown>)[segment] : undefined
  ), en);
  return typeof value === 'string' ? value : typeof fallback === 'string' ? fallback : key;
} }) }));
vi.mock('../../../components/common', () => ({
  Card: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  Loading: () => <span>Loading</span>,
}));
vi.mock('../../../hooks', () => ({ useMutationWithToast: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock('../../../hooks/useLocalizedDate', () => ({ useLocalizedDate: () => ({ formatDateTime: String }) }));
vi.mock('../../../contexts/FeatureFlagsContext', () => ({ useFeatureFlags: () => ({ flags: {} }) }));
vi.mock('../../../services/systemHealth.service', () => ({ systemHealthService: {} }));

import { SystemHealthPage } from '../SystemHealthPage';

describe('System Health backup authenticity', () => {
  beforeEach(() => query.mockReturnValue({ isLoading: false, data: {
    stuckEmails: [], waitingEmails: [], counts: { stuckEmails: 0, waitingEmails: 0 },
  } }));
  afterEach(cleanup);
  const show = (ready: boolean, authenticated: boolean) => {
    query.mockReturnValue({ isLoading: false, data: {
      stuckEmails: [], waitingEmails: [], counts: { stuckEmails: 0, waitingEmails: 0 },
      backupAuthentication: {
        signingKey: { ready, source: ready ? 'env' : 'missing', keyId: ready ? '1234567890abcdef' : null },
        latestManifest: { authenticated },
      },
    } });
    render(<SystemHealthPage />);
  };

  it('shows retained key readiness and separately authenticated latest manifest', () => {
    show(true, true);
    expect(screen.getByText(en.systemHealth.backupAuthentication.title)).toBeInTheDocument();
    expect(screen.getByText(en.systemHealth.backupAuthentication.verified)).toBeInTheDocument();
    expect(screen.getByText(/1234567890abcdef/)).toBeInTheDocument();
  });

  it('does not treat a ready signing key or completed run as proof of latest artifact authenticity', () => {
    show(true, false);
    expect(screen.getByText(en.systemHealth.backupAuthentication.unverified)).toBeInTheDocument();
    expect(screen.queryByText(en.systemHealth.backupAuthentication.verified)).not.toBeInTheDocument();
  });

  it('reports missing/invalid key readiness without offering a normal force bypass', () => {
    show(false, false);
    expect(screen.getByText(en.systemHealth.backupAuthentication.keyMissing)).toBeInTheDocument();
    expect(screen.getByText(en.systemHealth.backupAuthentication.hint)).toBeInTheDocument();
  });

  it('remains compatible with an older server response without the optional field', () => {
    render(<SystemHealthPage />);
    expect(screen.queryByText(en.systemHealth.backupAuthentication.title)).not.toBeInTheDocument();
  });
});
