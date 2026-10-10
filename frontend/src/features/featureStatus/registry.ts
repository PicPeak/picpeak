import type { FeatureKey } from '../../services/featureFlags.service';

/**
 * How far along each feature is — the one list the Features page, the
 * feature's own page header and the customer record read (STYLING.md ›
 * Feature state). Change a feature's state here and nowhere else.
 *
 * - `stable`        done; no label. With `newSince` it shows **New** for
 *                   NEW_FOR_DAYS days after that date, then nothing.
 * - `beta`          in development: usable for real work, may still change.
 * - `experimental`  may break or go away; not for a production studio.
 * - `roadmap`       not built yet; its toggle stays locked.
 */
export type FeatureMaturity = 'stable' | 'beta' | 'experimental' | 'roadmap';

/** What is shown: the maturity, or `new` while a stable feature is fresh. */
export type FeatureState = FeatureMaturity | 'new';

export interface FeatureStatusEntry {
  maturity: FeatureMaturity;
  /** YYYY-MM-DD the feature became stable; drives the New label. */
  newSince?: string;
}

/** Customer-portal tabs that are not features of their own. */
export type PortalFeatureKey = 'portalCalendar';

export const NEW_FOR_DAYS = 30;

export const FEATURE_STATUS: Record<FeatureKey | PortalFeatureKey, FeatureStatusEntry> = {
  // Core
  galleries: { maturity: 'stable' },
  slideshow: { maturity: 'beta' },
  transfers: { maturity: 'beta' },
  faces: { maturity: 'beta' },
  // Automation
  workflows: { maturity: 'beta' },
  // CRM
  clients: { maturity: 'stable' },
  customerPortal: { maturity: 'beta' },
  documents: { maturity: 'beta' },
  calendar: { maturity: 'beta' },
  calendarBooking: { maturity: 'roadmap' },
  quotes: { maturity: 'beta' },
  contracts: { maturity: 'beta' },
  bills: { maturity: 'beta' },
  newsletters: { maturity: 'beta' },
  hoursLogging: { maturity: 'beta' },
  projects: { maturity: 'beta' },
  crmDevelopment: { maturity: 'experimental' },
  // Communication
  reminderEmails: { maturity: 'beta' },
  incomingMail: { maturity: 'beta' },
  whatsapp: { maturity: 'beta' },
  messaging: { maturity: 'beta' },
  // Accounting
  accounting: { maturity: 'beta' },
  taxReport: { maturity: 'beta' },
  incomingInvoices: { maturity: 'beta' },
  expenses: { maturity: 'beta' },
  // Insights & access
  analytics: { maturity: 'stable' },
  userManagement: { maturity: 'stable' },
  // Customer portal tabs
  portalCalendar: { maturity: 'roadmap' },
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** The state to show for a feature today. */
export function featureState(key: FeatureKey | PortalFeatureKey, now: Date = new Date()): FeatureState {
  const entry = FEATURE_STATUS[key];
  if (!entry) return 'stable';
  if (entry.maturity !== 'stable' || !entry.newSince) return entry.maturity;
  const since = Date.parse(`${entry.newSince}T00:00:00`);
  if (Number.isNaN(since)) return 'stable';
  return now.getTime() < since + NEW_FOR_DAYS * DAY_MS ? 'new' : 'stable';
}
