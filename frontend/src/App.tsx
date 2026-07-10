import { lazy, Suspense, useEffect, useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastContainer } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import { analyticsService } from './services/analytics.service';

import { GalleryAuthProvider, MaintenanceProvider } from './contexts';
import { ThemeProvider } from './contexts/ThemeContext';
import { GalleryPage } from './pages/GalleryPage';
import { ClientAccessPage } from './pages/ClientAccessPage';
import { PreviewPage } from './pages/gallery/PreviewPage';
const SlideshowPage = lazy(() => import('./pages/gallery/SlideshowPage').then((m) => ({ default: m.SlideshowPage })));
import { LegalPage } from './pages/public/LegalPage';
import {
  AdminLoginPage,
  AdminDashboard,
  EventsListPage,
  CreateEventPage,
  EventDetailsPage,
  EventFeedbackPage,
  ArchivesPage,
  AnalyticsPage,
  SettingsPage,
  SystemHealthPage,
  UserManagementPage,
  CustomerManagementPage,
  CustomerDetailPage,
  WebhookDeliveriesPage,
  // CRM routes (#TBD) — feature-flagged at the route layer via RequireFeature.
  QuotesListPage,
  QuoteEditorPage,
  QuoteDetailPage,
  BillsListPage,
  BillEditorPage,
  BillDetailPage,
} from './pages/admin';
import { CrmDevelopmentPage } from './pages/admin/clients/CrmDevelopmentPage';
import { TaxReportPage } from './pages/admin/clients/TaxReportPage';
import { HoursLoggingPage } from './pages/admin/clients/HoursLoggingPage';
// E.6 — Calendar page lazy-loaded so the ~200 KB FullCalendar bundle
// (carved into its own chunk in vite.config.ts) doesn't ship with the
// main app. Only pages that visit /admin/clients/calendar fetch it.
const CalendarPage = lazy(() => import('./pages/admin/clients/CalendarPage').then((m) => ({ default: m.CalendarPage })));
import { QuoteResponsePage } from './pages/public/QuoteResponsePage';
import { ContractResponsePage } from './pages/public/ContractResponsePage';
import { ProjectsListPage } from './pages/admin/projects/ProjectsListPage';
import { ProjectCockpitPage } from './pages/admin/projects/ProjectCockpitPage';
import { WorkflowsListPage } from './pages/admin/workflows/WorkflowsListPage';
import { WorkflowApprovalsPage } from './pages/admin/workflows/WorkflowApprovalsPage';
import { WorkflowEditorPage } from './pages/admin/workflows/WorkflowEditorPage';
import { ContractsListPage } from './pages/admin/contracts/ContractsListPage';
import { ContractEditorPage } from './pages/admin/contracts/ContractEditorPage';
import { ContractDetailPage } from './pages/admin/contracts/ContractDetailPage';
import { BlockLibraryPage } from './pages/admin/contracts/BlockLibraryPage';
import { PaymentCheckPage } from './pages/public/PaymentCheckPage';
import { AcceptInvitePage } from './pages/public/AcceptInvitePage';
import {
  CustomerLoginPage,
  CustomerDashboardPage,
  CustomerAcceptInvitePage,
  CustomerLayout,
  CustomerProfilePage,
  CustomerCalendarPage,
  CustomerQuotesPage,
  CustomerBillsPage,
  CustomerContractsPage,
  CustomerResetPasswordPage,
} from './pages/customer';
import { CustomerAuthProvider } from './contexts/CustomerAuthContext';
import { AdminLayout, AdminAuthWrapper } from './components/admin';
import { ClientsLayout } from './components/admin/ClientsLayout';
import { AccountingLayout, AccountingIndex } from './components/admin/AccountingLayout';
import { AccountingInboxPage } from './pages/admin/accounting/AccountingInboxPage';
import { ExpensesLedgerPage } from './pages/admin/accounting/ExpensesLedgerPage';
import { RequireFeature } from './components/admin/RequireFeature';
import { PageErrorBoundary, OfflineIndicator, SkipLink, DynamicFavicon, RobotsMetaTags, CMSContentBlock, Loading } from './components/common';
import { MaintenanceWrapper } from './components/MaintenanceWrapper';
import { GlobalThemeProvider } from './components/GlobalThemeProvider';
import { ConfirmDialogProvider } from './components/common';
import { usePublicSettings } from './hooks/usePublicSettings';
import { SetupPage } from './pages/SetupPage';
import { AdminAuthProvider } from './contexts';

// Create a client
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

// Bootstraps the analytics tracker from /public/settings. Lives inside
// QueryClientProvider so it shares the public-settings cache with every
// other consumer of usePublicSettings. Dispatches based on the
// `analytics_tracker_provider` switch (#663 Phase 1) — Umami / Rybbit /
// Custom / None. Back-compat: when the provider field is missing or unset,
// falls through to the legacy `umami_enabled`-based behaviour so installs
// that haven't picked yet keep working.
function AnalyticsBootstrap() {
  const { data: settings, isError } = usePublicSettings();

  useEffect(() => {
    if (!settings && !isError) return;

    const envUmamiUrl = import.meta.env.VITE_UMAMI_URL;
    const envUmamiWebsiteId = import.meta.env.VITE_UMAMI_WEBSITE_ID;
    const provider = settings?.analytics_tracker_provider;

    if (provider === 'rybbit' && settings?.rybbit_url && settings.rybbit_website_id) {
      analyticsService.initialize({
        provider: 'rybbit',
        hostUrl: settings.rybbit_url,
        websiteId: settings.rybbit_website_id,
        autoTrack: true,
        doNotTrack: true,
      });
      return;
    }

    if (provider === 'custom') {
      analyticsService.initialize({
        provider: 'custom',
        customHeadHtml: settings?.analytics_custom_head_html || '',
      });
      return;
    }

    // Umami: explicit provider OR legacy umami_enabled path.
    if (
      (provider === 'umami' || settings?.umami_enabled)
      && settings?.umami_url && settings?.umami_website_id
    ) {
      analyticsService.initialize({
        provider: 'umami',
        hostUrl: settings.umami_url,
        websiteId: settings.umami_website_id,
        autoTrack: true,
        doNotTrack: true,
      });
      return;
    }

    // Env-var fallback (legacy deploys). Only when no DB config and
    // analytics aren't disabled at the public-site level.
    if (envUmamiUrl && envUmamiWebsiteId && (isError || settings?.enable_analytics !== false)) {
      analyticsService.initialize({
        provider: 'umami',
        hostUrl: envUmamiUrl,
        websiteId: envUmamiWebsiteId,
        autoTrack: true,
        doNotTrack: true,
      });
    }
  }, [settings, isError]);

  return null;
}

/**
 * Backward-compat redirect for /admin/customers/:id → /admin/clients/accounts/:id.
 * Needed because <Navigate to="..."> can't interpolate route params and we
 * want stale bookmarks / email links to keep working after the Clients
 * section reorg.
 */
function RedirectCustomerDetail() {
  const { id } = useParams();
  return <Navigate to={`/admin/clients/accounts/${id}`} replace />;
}

function App() {
  // Track dark mode for toast theming
  const [toastTheme, setToastTheme] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setToastTheme(document.documentElement.classList.contains('dark') ? 'dark' : 'light');
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  return (
    <PageErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <AnalyticsBootstrap />
        <MaintenanceProvider>
          <ThemeProvider>
            <GlobalThemeProvider>
              <ConfirmDialogProvider>
              <DynamicFavicon />
              <RobotsMetaTags />
              <Router>
                <MaintenanceWrapper>
                  <SkipLink />
                  <Routes>
                  {/* Public gallery routes */}
                  <Route path="/gallery/preview" element={<PreviewPage />} />
                  {/* Live Slideshow ("Diashow") — token-only fullscreen kiosk.
                      Self-manages its session token; no GalleryAuthProvider. */}
                  <Route path="/gallery/:slug/show/:token" element={
                    <Suspense fallback={<Loading />}>
                      <SlideshowPage />
                    </Suspense>
                  } />
                  <Route path="/gallery/:slug/client-access" element={
                    <GalleryAuthProvider>
                      <ClientAccessPage />
                    </GalleryAuthProvider>
                  } />
                  <Route path="/gallery/:slug/:token?" element={
                    <GalleryAuthProvider>
                      <GalleryPage />
                    </GalleryAuthProvider>
                  } />

                  {/* First-run setup — public, self-closes once an admin exists */}
                  <Route path="/setup" element={
                    <AdminAuthProvider>
                      <SetupPage />
                    </AdminAuthProvider>
                  } />

                  {/* Admin routes - wrap with AdminAuthProvider */}
                  <Route path="/admin" element={<AdminAuthWrapper />}>
                    <Route path="login" element={<AdminLoginPage />} />
                    <Route element={<AdminLayout />}>
                      <Route path="dashboard" element={<AdminDashboard />} />
                      <Route path="events" element={<EventsListPage />} />
                      <Route path="events/new" element={<CreateEventPage />} />
                      <Route path="events/:id" element={<EventDetailsPage />} />
                      <Route path="events/:id/feedback" element={<EventFeedbackPage />} />
                      <Route path="archives" element={<ArchivesPage />} />

                      {/* Feature-gated surfaces — redirect to /admin/dashboard when flag is off. */}
                      <Route element={<RequireFeature flag="analytics" />}>
                        <Route path="analytics" element={<AnalyticsPage />} />
                      </Route>
                      <Route element={<RequireFeature flag="userManagement" />}>
                        <Route path="users" element={<UserManagementPage />} />
                      </Route>
                      {/* Clients section (#354 follow-up). Parent route
                          gated by the top-level `clients` flag — when off
                          the sidebar entry is hidden and every /admin/clients/*
                          URL redirects to /admin/dashboard. Inside, the
                          ClientsLayout renders a Settings-style sub-nav
                          and the active sub-feature's page through an
                          Outlet. Each sub-route is feature-flagged
                          independently. */}
                      <Route element={<RequireFeature flag="clients" />}>
                        <Route path="clients" element={<ClientsLayout />}>
                          <Route element={<RequireFeature flag="customerPortal" />}>
                            <Route path="accounts" element={<CustomerManagementPage />} />
                            <Route path="accounts/:id" element={<CustomerDetailPage />} />
                          </Route>
                          {/* Quotes (CRM) — gated by `quotes`. */}
                          <Route element={<RequireFeature flag="quotes" />}>
                            <Route path="quotes" element={<QuotesListPage />} />
                            <Route path="quotes/new" element={<QuoteEditorPage />} />
                            <Route path="quotes/:id" element={<QuoteDetailPage />} />
                            <Route path="quotes/:id/edit" element={<QuoteEditorPage />} />
                          </Route>
                          {/* Project Overview (CRM) — admin-only grouping
                              layer above events, gated by `projects`. */}
                          <Route element={<RequireFeature flag="projects" />}>
                            <Route path="projects" element={<ProjectsListPage />} />
                            <Route path="projects/:id" element={<ProjectCockpitPage />} />
                          </Route>
                          {/* Bills / invoices (CRM) — gated by `bills`. */}
                          <Route element={<RequireFeature flag="bills" />}>
                            <Route path="bills" element={<BillsListPage />} />
                            <Route path="bills/new" element={<BillEditorPage />} />
                            <Route path="bills/:id" element={<BillDetailPage />} />
                            <Route path="bills/:id/edit" element={<BillEditorPage />} />
                          </Route>

                          {/* Contracts (CRM) — gated by `contracts`. Independent
                              of quotes/bills; a free-standing legal document
                              type composed from a library of reusable blocks. */}
                          <Route element={<RequireFeature flag="contracts" />}>
                            <Route path="contracts" element={<ContractsListPage />} />
                            <Route path="contracts/new" element={<ContractEditorPage />} />
                            <Route path="contracts/blocks" element={<BlockLibraryPage />} />
                            <Route path="contracts/:id" element={<ContractDetailPage />} />
                            <Route path="contracts/:id/edit" element={<ContractEditorPage />} />
                          </Route>

                          {/* Hour logging (standalone surface) — gated by
                              `hoursLogging`. Independent of `bills` so admin
                              can log hours before the full billing surface
                              is enabled. */}
                          <Route element={<RequireFeature flag="hoursLogging" />}>
                            <Route path="hours" element={<HoursLoggingPage />} />
                          </Route>

                          {/* Admin calendar (migration 137) — gated by
                              `calendar`. Lazy-loaded so the FullCalendar
                              bundle stays out of the main chunk. */}
                          <Route element={<RequireFeature flag="calendar" />}>
                            <Route
                              path="calendar"
                              element={
                                <Suspense fallback={<Loading />}>
                                  <CalendarPage />
                                </Suspense>
                              }
                            />
                          </Route>

                          {/* Tax export moved permanently to the Accounting
                              section. Keep this path as a redirect so old
                              bookmarks / links don't 404. */}
                          <Route path="tax-report" element={<Navigate to="/admin/accounting/tax-report" replace />} />
                          {/* Developer tools — gated by `crmDevelopment`. */}
                          <Route element={<RequireFeature flag="crmDevelopment" />}>
                            <Route path="development" element={<CrmDevelopmentPage />} />
                          </Route>
                          {/* Default: send /admin/clients (no sub-path) to
                              the first enabled sub-feature. accounts comes
                              first because it predates the others. The empty
                              state inside ClientsLayout handles "parent on,
                              all children off". */}
                          <Route index element={<Navigate to="/admin/clients/accounts" replace />} />
                        </Route>
                      </Route>

                      {/* Accounting section (migration 122). Parent gated by
                          the `accounting` flag. Hosts the Tax report — which
                          relocates here from the CRM sub-nav when accounting
                          is on — plus the future inbound-invoice / expenses
                          pages. Each sub-route is independently flagged. */}
                      <Route element={<RequireFeature flag="accounting" />}>
                        <Route path="accounting" element={<AccountingLayout />}>
                          <Route element={<RequireFeature flag="incomingInvoices" />}>
                            <Route path="inbox" element={<AccountingInboxPage />} />
                          </Route>
                          <Route element={<RequireFeature flag="expenses" />}>
                            <Route path="expenses" element={<ExpensesLedgerPage />} />
                          </Route>
                          <Route element={<RequireFeature flag="taxReport" />}>
                            <Route path="tax-report" element={<TaxReportPage />} />
                            {/* Treuhänder export moved onto the Tax page; keep
                                the old path working for bookmarks. */}
                            <Route path="export" element={<Navigate to="/admin/accounting/tax-report" replace />} />
                          </Route>
                          {/* Chart of accounts (Layer A) moved into Settings →
                              Accounting; keep the old path working for bookmarks. */}
                          <Route path="ledger" element={<Navigate to="/admin/settings?tab=accounting" replace />} />
                          <Route index element={<AccountingIndex />} />
                        </Route>
                      </Route>

                      {/* Old /admin/customers paths now live under
                          /admin/clients/accounts. Kept indefinitely as
                          redirects so existing bookmarks and email links
                          don't 404. */}
                      <Route path="customers"     element={<Navigate to="/admin/clients/accounts" replace />} />
                      <Route path="customers/:id" element={<RedirectCustomerDetail />} />

                      {/* Workflows (automation engine) — top-level area gated
                          by the `workflows` flag. */}
                      <Route element={<RequireFeature flag="workflows" />}>
                        <Route path="workflows" element={<WorkflowsListPage />} />
                        <Route path="workflows/approvals" element={<WorkflowApprovalsPage />} />
                        <Route path="workflows/:id" element={<WorkflowEditorPage />} />
                      </Route>

                      <Route path="settings" element={<SettingsPage />} />
                      <Route path="system-health" element={<SystemHealthPage />} />
                      <Route path="webhooks/:id/deliveries" element={<WebhookDeliveriesPage />} />

                      {/* Old top-level routes — these surfaces now live as
                          Settings tabs (#feature-flags-settings-reorg).
                          Kept indefinitely as redirects so existing bookmarks
                          and external links don't 404. */}
                      <Route path="email"        element={<Navigate to="/admin/settings?tab=email"      replace />} />
                      <Route path="branding"     element={<Navigate to="/admin/settings?tab=branding"   replace />} />
                      <Route path="event-types"  element={<Navigate to="/admin/settings?tab=eventTypes" replace />} />
                      <Route path="backup"       element={<Navigate to="/admin/settings?tab=backup"     replace />} />
                      <Route path="cms"          element={<Navigate to="/admin/settings?tab=cms"        replace />} />

                      <Route index element={<Navigate to="/admin/dashboard" replace />} />
                    </Route>
                  </Route>

                  {/* Public invitation acceptance page */}
                  <Route path="/invite/:token" element={<AcceptInvitePage />} />

                  {/* Public quote accept/decline page (CRM). Token-only,
                      no auth required. */}
                  <Route path="/quote/:token" element={<QuoteResponsePage />} />
                  <Route path="/contract/:token" element={<ContractResponsePage />} />

                  {/* Admin payment-check page (CRM) — token only,
                      no auth. Reached from the "Paid in full /
                      Partial / Not paid" buttons in the payment-
                      check email. */}
                  <Route path="/payment-check/:token" element={<PaymentCheckPage />} />

                  {/* Customer surface (#354). Strictly separate provider /
                      cookie / API surface from /admin/*. The customerPortal
                      feature flag hides the *admin-side* surfaces (sidebar
                      entry, /admin/customers routes, CustomerAccountPicker)
                      via RequireFeature. The customer-side /customer/*
                      tree stays publicly reachable so existing customers
                      can still log in even if the admin temporarily flips
                      the flag off — and because RequireFeature reads from
                      FeatureFlagsProvider (admin-only context), gating
                      these routes here would crash unauthenticated
                      visitors with an unmounted-provider error. */}
                  <Route path="/customer/*" element={
                    <CustomerAuthProvider>
                      <Routes>
                        {/* Public surfaces: login, accept-invite, reset —
                            no CustomerLayout (their own branded shells). */}
                        <Route path="login" element={<CustomerLoginPage />} />
                        <Route path="invite/:token" element={<CustomerAcceptInvitePage />} />
                        <Route path="reset-password/:token" element={<CustomerResetPasswordPage />} />

                        {/* Authenticated surfaces share the sidebar layout
                            (Outlet pattern, mirrors AdminLayout). The
                            CustomerLayout itself enforces auth — bouncing
                            unauthenticated visitors to /customer/login. */}
                        <Route element={<CustomerLayout />}>
                          <Route path="dashboard" element={<CustomerDashboardPage />} />
                          <Route path="calendar" element={<CustomerCalendarPage />} />
                          <Route path="quotes" element={<CustomerQuotesPage />} />
                          <Route path="contracts" element={<CustomerContractsPage />} />
                          <Route path="bills" element={<CustomerBillsPage />} />
                          <Route path="profile" element={<CustomerProfilePage />} />
                        </Route>

                        <Route index element={<Navigate to="/customer/dashboard" replace />} />
                      </Routes>
                    </CustomerAuthProvider>
                  } />

                  {/* Public legal pages */}
                  <Route path="/impressum" element={<LegalPage />} />
                  <Route path="/datenschutz" element={<LegalPage />} />
                  <Route path="/:slug" element={<LegalPage />} />

                  {/* Default redirect */}
                  <Route path="/" element={<Navigate to="/admin/login" replace />} />

                  {/* Customisable 404 (#324) — caught here for any path that
                      didn't match. Top-level `/:slug` is consumed above by
                      LegalPage; this picks up deeper unknown paths. */}
                  <Route path="*" element={<CMSContentBlock slug="not-found" />} />
                </Routes>
              </MaintenanceWrapper>
            </Router>

            {/* Offline indicator */}
            <OfflineIndicator />

            {/* Toast notifications */}
            <ToastContainer
              position="bottom-right"
              autoClose={5000}
              hideProgressBar={false}
              newestOnTop
              closeOnClick
              rtl={false}
              pauseOnFocusLoss
              draggable
              pauseOnHover
              theme={toastTheme}
            />
              </ConfirmDialogProvider>
            </GlobalThemeProvider>
          </ThemeProvider>
        </MaintenanceProvider>
      </QueryClientProvider>
    </PageErrorBoundary>
  );
}

export default App;
