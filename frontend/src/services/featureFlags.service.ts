import { api } from '../config/api';

export type FeatureKey =
  | 'galleries'
  | 'reminderEmails'
  | 'calendar'
  | 'calendarBooking'
  | 'quotes'
  | 'bills'
  | 'messaging'
  | 'analytics'
  | 'userManagement'
  // Top-level "Clients" section (#354 follow-up). Parent flag that
  // gates the /admin/clients/* sidebar entry. customerPortal,
  // calendar, quotes, bills and messaging are conceptually its
  // children — when `clients` is off none of them surface in the
  // admin UI even if their individual flags are on.
  | 'clients'
  // Customer-side portal surface (#354). Gates /customer/* routes
  // (login, dashboard, profile, accept-invite, reset-password) and
  // the Accounts sub-page under Clients in the admin UI.
  | 'customerPortal';

export type FeatureFlags = Record<FeatureKey, boolean>;

export const featureFlagsService = {
  async get(): Promise<FeatureFlags> {
    const response = await api.get<FeatureFlags>('/admin/feature-flags');
    return response.data;
  },

  async update(flags: Partial<FeatureFlags>): Promise<FeatureFlags> {
    const response = await api.put<FeatureFlags>('/admin/feature-flags', flags);
    return response.data;
  },
};
