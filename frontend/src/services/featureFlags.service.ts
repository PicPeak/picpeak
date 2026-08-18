import { api } from '../config/api';

export type FeatureKey =
  | 'galleries'
  | 'reminderEmails'
  | 'calendar'
  | 'calendarBooking'
  | 'quotes'
  | 'bills'
  | 'messaging'
  // Incoming mail (migration 128) — IMAP polling into the incoming-invoices
  // inbox. Standalone toggle.
  | 'incomingMail'
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
  | 'customerPortal'
  // CRM developer tools — hidden by default. When enabled, surfaces
  // a "Development" sub-tab under Clients with internal-use buttons
  // (test the payment-check email flow, fire dev-only side effects,
  // etc.). Strictly opt-in; toggled from Features.
  | 'crmDevelopment'
  // Tax / Steuer report — period-scoped revenue export under
  // Clients. Independent of `bills` so admins who already use the
  // billing surface don't get a new menu entry automatically; they
  // opt in when they're ready to generate tax reports.
  | 'taxReport'
  // Hours logging (migration 129). Master switch for the per-customer
  // Hours card on the customer detail page. Independent of `bills`
  // so admin can log hours without enabling the broader billing
  // surface yet.
  | 'hoursLogging'
  // Contracts (migration 130). Standalone legal-document type alongside
  // quotes / bills, composed from a library of reusable blocks and
  // signed in-browser (canvas + checkbox) or via wet-signed PDF
  // upload. Independent of quotes / bills — contracts can be sent on
  // their own. Seeded block bodies are examples only; admins must
  // have their lawyer review before sending. See https://docs.picpeak.app/features/crm/disclaimers.
  | 'contracts'
  // Accounting (migration 122). Top-level MASTER for the Accounting
  // section (separate from CRM). Its sub-features (tax export, incoming
  // invoices) require it. Strictly opt-in.
  | 'accounting'
  // Incoming invoices (migration 124) — external supplier-invoice capture +
  // re-bill. Accounting sub-feature; requires `accounting`.
  | 'incomingInvoices'
  // Expenses (migration 127) — internal expenses (mileage / per-diem / cash).
  // Separate Accounting sub-feature; requires `accounting`.
  | 'expenses'
  // Projects (migration 120). Admin-only grouping layer above events with the
  // 360° Project Overview cockpit + the "book to project" hours control. Off
  // by default; gates the CRM → Overview area entirely.
  | 'projects'
  // WhatsApp Business API delivery channel (migration 136, #640D).
  // Strictly opt-in — requires a Meta Business Account, an approved
  // message template, and a Meta access token. Independent of email; both
  // can fire on the same event.
  | 'whatsapp'
  // Live Slideshow ("Diashow") — per-event fullscreen kiosk link + presets +
  // global watermark settings tab. Strictly opt-in; gates all slideshow UI.
  | 'slideshow'
  // PicTransfer (migration 170) — cross-event file transfers:
  // a token-protected recipient download link plus an optional client-upload
  // channel. Strictly opt-in; gates the sidebar entry, the /admin/transfers
  // area and every transfer route (admin + public).
  | 'transfers'
  // Workflow / automation engine — admin-configurable visual flows (triggers,
  // conditions, branches, loops, approval gates) built on a canvas. Strictly
  // opt-in; gates the Workflows admin area and the engine runtime.
  | 'workflows'
  // Face recognition — "People in this gallery" (migration 177, #1074).
  // Requires the optional picpeak-ml sidecar container. THIS FLAG IS THE
  // GATE for the whole feature: the backend's FACE_ML_URL has a working
  // default, so the sidecar's presence can't be detected from config alone.
  // While this is off, no face UI renders anywhere — no admin panel, no
  // people strip, no lightbox chips — and the backend never contacts the
  // sidecar. Face embeddings are biometric data (GDPR Art. 9); turning this
  // on is only the first of two deliberate actions, since detection is still
  // enabled per event.
  | 'faces';

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
