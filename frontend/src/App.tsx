import { useEffect, useState } from 'react';
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
  UserManagementPage,
  CustomerManagementPage,
  CustomerDetailPage,
  WebhookDeliveriesPage
} from './pages/admin';
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
  CustomerResetPasswordPage,
} from './pages/customer';
import { CustomerAuthProvider } from './contexts/CustomerAuthContext';
import { AdminLayout, AdminAuthWrapper } from './components/admin';
import { ClientsLayout } from './components/admin/ClientsLayout';
import { RequireFeature } from './components/admin/RequireFeature';
import { PageErrorBoundary, OfflineIndicator, SkipLink, DynamicFavicon, RobotsMetaTags, CMSContentBlock } from './components/common';
import { MaintenanceWrapper } from './components/MaintenanceWrapper';
import { GlobalThemeProvider } from './components/GlobalThemeProvider';
import { usePublicSettings } from './hooks/usePublicSettings';

// Create a client
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

// Bootstraps Umami analytics from /public/settings. Lives inside QueryClientProvider
// so it shares the public-settings cache with every other consumer of usePublicSettings.
function AnalyticsBootstrap() {
  const { data: settings, isError } = usePublicSettings();

  useEffect(() => {
    if (!settings && !isError) return;

    const envUmamiUrl = import.meta.env.VITE_UMAMI_URL;
    const envUmamiWebsiteId = import.meta.env.VITE_UMAMI_WEBSITE_ID;

    if (settings?.umami_enabled && settings.umami_url && settings.umami_website_id) {
      analyticsService.initialize({
        websiteId: settings.umami_website_id,
        hostUrl: settings.umami_url,
        autoTrack: true,
        doNotTrack: true,
      });
      return;
    }

    if (envUmamiUrl && envUmamiWebsiteId && (isError || settings?.enable_analytics !== false)) {
      analyticsService.initialize({
        websiteId: envUmamiWebsiteId,
        hostUrl: envUmamiUrl,
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
              <DynamicFavicon />
              <RobotsMetaTags />
              <Router>
                <MaintenanceWrapper>
                  <SkipLink />
                  <Routes>
                  {/* Public gallery routes */}
                  <Route path="/gallery/preview" element={<PreviewPage />} />
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
                          {/* Default: send /admin/clients (no sub-path) to
                              the first available sub-feature. Today that's
                              always accounts; when calendar/quotes ship they
                              get their own routes here and the empty-state
                              in ClientsLayout handles the rare "parent on,
                              all children off" case. */}
                          <Route index element={<Navigate to="/admin/clients/accounts" replace />} />
                        </Route>
                      </Route>

                      {/* Old /admin/customers paths now live under
                          /admin/clients/accounts. Kept indefinitely as
                          redirects so existing bookmarks and email links
                          don't 404. */}
                      <Route path="customers"     element={<Navigate to="/admin/clients/accounts" replace />} />
                      <Route path="customers/:id" element={<RedirectCustomerDetail />} />

                      <Route path="settings" element={<SettingsPage />} />
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
            </GlobalThemeProvider>
          </ThemeProvider>
        </MaintenanceProvider>
      </QueryClientProvider>
    </PageErrorBoundary>
  );
}

export default App;
