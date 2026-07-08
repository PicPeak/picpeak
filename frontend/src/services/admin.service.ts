import { api } from '../config/api';
import i18n from '../i18n/config';

/**
 * Per-flag display labels for activity-log rendering. Values are
 * i18n keys; if a key is missing in the active locale we fall back
 * to a humanised version of the flag name. Kept in sync with
 * `FeatureKey` in services/featureFlags.service.ts.
 */
const FEATURE_FLAG_LABEL_KEY: Record<string, string> = {
  galleries: 'settings.features.galleries.title',
  reminderEmails: 'settings.features.reminderEmails.title',
  calendar: 'settings.features.calendar.title',
  calendarBooking: 'settings.features.calendarBooking.title',
  quotes: 'settings.features.quotes.title',
  bills: 'settings.features.bills.title',
  messaging: 'settings.features.messaging.title',
  analytics: 'settings.features.analytics.title',
  userManagement: 'settings.features.userManagement.title',
  clients: 'settings.features.clients.title',
  customerPortal: 'settings.features.customerPortal.title',
};

/**
 * Renders the `feature_flags_updated` activity row using the
 * `metadata.changed = { [flagKey]: { from, to } }` payload the
 * backend writes. One change → "Calendar enabled". Multiple →
 * "3 features updated: Calendar enabled, Quotes disabled, …".
 *
 * Used by both the Dashboard recent-activity widget (via
 * formatActivityMessage below) and the header notification
 * dropdown (via notifications.service.ts).
 */
export function formatFeatureFlagsChanged(
  changed: Record<string, { from: boolean; to: boolean }> | undefined,
): string {
  const t = i18n.t;
  const entries = Object.entries(changed || {});
  if (entries.length === 0) {
    return t('admin.activities.feature_flags_noop', 'Feature flags reviewed (no changes)');
  }
  const pieces = entries.map(([key, change]) => {
    const labelKey = FEATURE_FLAG_LABEL_KEY[key];
    // Humanise unknown keys (camelCase → "Camel Case") so a forward-
    // compat flag added in a newer release still renders something
    // readable on a frontend that doesn't know about it yet.
    const fallback = key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
    const label = labelKey ? (t(labelKey, fallback) as string) : fallback;
    return change.to
      ? (t('admin.activities.feature_enabled', '{{label}} enabled', { label }) as string)
      : (t('admin.activities.feature_disabled', '{{label}} disabled', { label }) as string);
  });
  if (pieces.length === 1) return pieces[0];
  return t('admin.activities.feature_flags_summary', '{{count}} features updated: {{summary}}', {
    count: pieces.length,
    summary: pieces.join(', '),
  }) as string;
}

export interface DashboardStats {
  activeEvents: number;
  expiringEvents: number;
  totalPhotos: number;
  storageUsed: number;
  totalViews: number;
  totalDownloads: number;
  viewsTrend: number;
  downloadsTrend: number;
  archivedEvents: number;
  totalEvents: number;
}

export interface SystemHealth {
  overall: 'healthy' | 'warning' | 'error';
  services: {
    database: 'healthy' | 'warning' | 'error';
    email: 'healthy' | 'warning' | 'error';
    storage: 'healthy' | 'warning' | 'error';
    memory: 'healthy' | 'warning' | 'error';
  };
  details: {
    emailQueue: {
      pending: number;
      processable: number;
      stuck: number;
      sent: number;
      failed: number;
    };
    memory: {
      total: number;
      free: number;
      used: number;
      percentage: number;
    };
  };
}

export type ActivityType =
  | "event_created"
  | "photos_uploaded"
  | "event_archived"
  | "archive_restored"
  | "archive_deleted"
  | "archive_downloaded"
  | "email_config_updated"
  | "email_template_updated"
  | "branding_updated"
  | "theme_updated"
  | "bulk_download"
  | "gallery_password_entry"
  | "expiration_warning_viewed"
  | "feedback_settings_updated"
  | "feedback_moderated"
  | "feedback_deleted"
  | "photo_like"
  | "photo_favorite"
  | "photo_rating"
  | "photo_comment"
  | "guest_feedback_like"
  | "guest_feedback_favorite"
  | "guest_feedback_rating"
  | "guest_feedback_comment"
  | "word_filter_added"
  | "external_import_completed"
  | "bulk_archive_completed"
  | "event_activated"
  | "event_deactivated"
  | "photo_deleted"
  | "photos_bulk_deleted"
  | "settings_updated"
  | "event_updated"
  | "event_renamed"
  | "event_deleted"
  | "password_changed"
  | "email_resent"
  | "category_created"
  | "category_updated"
  | "category_deleted"
  | "general_settings_updated"
  | "favicon_uploaded"
  | "analytics_settings_updated"
  | "cms_page_updated"
  | "security_settings_updated"
  | "password_reset"
  | "admin_logout"
  | "system_activity"
  | "unknown"
  // Feature flag toggles emit one row per save with the full
  // { changed: { key: { from, to } } } diff in metadata.
  | "feature_flags_updated"
  // Customer portal (#354).
  | "customer_login"
  | "customer_invitation_created"
  | "customer_invitation_accepted"
  | "customer_invitation_cancelled"
  | "customer_password_reset_requested"
  | "customer_password_reset_applied"
  | "customer_password_change"
  | "customer_self_profile_update"
  | "customer_event_access"
  | "customer_updated"
  | "customer_deactivated"
  | "customer_reactivated"
  | "customer_erased"
  // Admin user management (#350).
  | "admin_invitation_created"
  | "admin_invitation_accepted"
  | "admin_invitation_cancelled"
  | "admin_user_updated"
  | "admin_user_deactivated"
  | "admin_password_reset"
  | "admin_profile_updated"
  // Webhooks (#327) + API tokens (#322) + event types.
  | "webhook_created"
  | "webhook_updated"
  | "webhook_deleted"
  | "api_token_created"
  | "api_token_revoked"
  | "event_type_created"
  | "event_type_updated"
  | "event_type_deleted"
  | "event_types_reordered"
  // Other recent surfaces missing from the message map.
  | "event_published"
  | "event_logo_uploaded"
  | "event_logo_removed"
  | "bulk_delete_completed"
  | "photo_replaced"
  | "photo_uploaded"
  | "category_hero_updated"
  | "public_site_reset_to_default"
  | "cms_page_logo_uploaded"

export interface Activity {
  id: number;
  type: ActivityType;
  actorType: string;
  actorName: string;
  eventName?: string;
  metadata: Record<string, any>;
  createdAt: string;
}

// Backup-integrity verifier — diagnostic endpoint that walks every
// CRM document-artefact path column and confirms files exist on disk
// (plus SHA-256 match where the schema stores one). Mirrors the
// shape returned by backupIntegrityService.verifyDocumentArtefacts.
export type BackupIntegrityScope =
  | 'quote'
  | 'contract'
  | 'contract-signature'
  | 'invoice';

export interface BackupIntegrityMissingRow {
  table: string;
  rowId: number;
  column: string;
  expectedPath: string;
}

export interface BackupIntegrityHashMismatchRow extends BackupIntegrityMissingRow {
  expectedSha: string;
  actualSha: string;
}

export interface BackupIntegrityExistsButNoHashRow {
  table: string;
  rowId: number;
  column: string;
  path: string;
}

export interface BackupIntegrityReport {
  scannedAt: string;
  scopes: BackupIntegrityScope[];
  summary: {
    totalRows: number;
    verifiedOk: number;
    missingFiles: number;
    hashMismatches: number;
    existsButNoHash: number;
  };
  missing: BackupIntegrityMissingRow[];
  hashMismatches: BackupIntegrityHashMismatchRow[];
  existsButNoHash: BackupIntegrityExistsButNoHashRow[];
}

// ---- Backup-coverage (Stage C of backup-hardening plan) -----------------

export type BackupPathCoverage =
  | 'will-scan'
  | 'skipped-by-toggle'
  | 'skipped-by-feature-flag'
  | 'missing-on-disk';

export interface BackupCoveragePath {
  path: string;
  includeInDefault: boolean;
  featureFlag: string | null;
  featureFlagValue: boolean | null;
  displayOrder: number;
  description: string | null;
  existsOnDisk: boolean;
  coverage: BackupPathCoverage;
}

export interface BackupCoverageDatabase {
  mode: 'inline' | 'scheduled-only';
  inlineDumpExplicitlyDisabled: boolean;
  lastDumpAt: string | null;
  lastDumpType: string | null;
  lastDumpSizeBytes: number;
  lastDumpFilePath: string | null;
  lastDumpAgeMs: number | null;
  lastDumpStale: boolean | null;
  ok: boolean;
}

export interface BackupCoverageReport {
  generatedAt: string;
  database: BackupCoverageDatabase;
  paths: BackupCoveragePath[];
  drift: {
    unconfiguredOnDisk: string[];
    expectedNonBackupDirs: string[];
  };
  summary: {
    configuredCount: number;
    willScanCount: number;
    skippedByToggleCount: number;
    skippedByFeatureFlagCount: number;
    missingOnDiskCount: number;
    driftCount: number;
    tableMissingFallbackInUse: boolean;
    databaseOk: boolean;
    overallOk: boolean;
  };
}

export interface AdminProfile {
  id: number;
  username: string;
  email: string;
  mustChangePassword?: boolean;
  last_login?: string | null;
  last_login_ip?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface AnalyticsData {
  chartData: Array<{
    date: string;
    views: number;
    downloads: number;
    uniqueVisitors: number;
  }>;
  topGalleries: Array<{
    event_name: string;
    slug: string;
    views: number;
    downloads?: number;
    uniqueVisitors?: number;
  }>;
  devices: {
    desktop: number;
    mobile: number;
    tablet: number;
  };
  // Period totals computed via dedicated COUNT queries on the backend
  // (#661 Bug A). Postgres returns these as strings, so callers should
  // coerce via Number() before display. Optional on the type because
  // older backends (pre-#661) didn't always emit it.
  totals?: {
    views: number | string;
    downloads: number | string;
    uniqueVisitors: number | string;
  };
  // Source of the device breakdown — `umami` when API-key auth succeeded,
  // `access_logs` for the local user-agent heuristic fallback (#661 Bug C).
  devicesSource?: 'umami' | 'access_logs';
}

export interface WhatsNewVersion {
  version: string;
  name: string;
  htmlUrl: string;
  publishedAt: string;
  bullets: string[];
}

export interface WhatsNewResponse {
  enabled: boolean;
  hasNews: boolean;
  fromVersion?: string;
  toVersion?: string;
  versions?: WhatsNewVersion[];
}

export const adminService = {
  // Dashboard statistics
  async getDashboardStats(): Promise<DashboardStats> {
    const response = await api.get<DashboardStats>('/admin/dashboard/stats');
    return response.data;
  },

  // Recent activity
  async getRecentActivity(limit: number = 10): Promise<Activity[]> {
    const response = await api.get<Activity[]>('/admin/dashboard/activity', {
      params: { limit }
    });
    return response.data;
  },

  // Analytics data
  async getAnalytics(days: number = 7): Promise<AnalyticsData> {
    const response = await api.get<AnalyticsData>('/admin/dashboard/analytics', {
      params: { days }
    });
    return response.data;
  },

  // System health check
  async getSystemHealth(): Promise<SystemHealth> {
    const response = await api.get<SystemHealth>('/admin/dashboard/health');
    return response.data;
  },

  // After-update "What's New" highlights (per-instance acknowledgement).
  async getWhatsNew(): Promise<WhatsNewResponse> {
    const response = await api.get<WhatsNewResponse>('/admin/system/updates/whatsnew');
    return response.data;
  },

  async markWhatsNewSeen(): Promise<void> {
    await api.post('/admin/system/updates/whatsnew/seen');
  },

  // Backup-integrity verifier (read-only diagnostic). `scope` filters
  // which document classes to walk; omit for a full scan.
  async getBackupIntegrity(
    scope?: BackupIntegrityScope[],
  ): Promise<BackupIntegrityReport> {
    const params = scope && scope.length > 0 ? { scope: scope.join(',') } : undefined;
    const response = await api.get<{ report: BackupIntegrityReport }>(
      '/admin/system-health/backup-integrity',
      { params },
    );
    return response.data.report;
  },

  // Backup-coverage diagnostic (Stage C). Answers "what will the
  // next backup actually include / skip / silently miss?" — read-only,
  // no parameters. See backupCoverageService.js for the full report shape.
  async getBackupCoverage(): Promise<BackupCoverageReport> {
    const response = await api.get<{ report: BackupCoverageReport }>(
      '/admin/system-health/backup-coverage',
    );
    return response.data.report;
  },

  // Format activity message
  formatActivityMessage(activity: Activity): string {
    // Feature-flag toggles carry a `changed` diff in metadata. Render
    // it inline so the activity row says what actually flipped, not
    // just "feature_flags_updated".
    if (activity.type === 'feature_flags_updated') {
      return formatFeatureFlagsChanged(activity.metadata?.changed);
    }
    const md = activity.metadata || {};
    const messages: Record<string, string> = {
      'event_created': `New event created: ${activity.eventName || 'Unknown'}`,
      'photos_uploaded': `${md.count || 0} photos uploaded to ${activity.eventName || 'Unknown'}`,
      'event_archived': `Event archived: ${activity.eventName || 'Unknown'}`,
      'event_published': `Event published: ${activity.eventName || md.event_name || 'Unknown'}`,
      'event_logo_uploaded': `Event logo uploaded for ${activity.eventName || 'Unknown'}`,
      'event_logo_removed': `Event logo removed for ${activity.eventName || 'Unknown'}`,
      'archive_restored': `Archive restored: ${activity.eventName || 'Unknown'}`,
      'archive_deleted': `Archive deleted: ${md.event_name || 'Unknown'}`,
      'archive_downloaded': `Archive downloaded: ${activity.eventName || 'Unknown'}`,
      'email_config_updated': 'Email configuration updated',
      'email_template_updated': `Email template updated: ${md.template_key || ''}`,
      'branding_updated': 'Branding settings updated',
      'theme_updated': 'Theme settings updated',
      'bulk_download': `${md.photo_count || 0} photos downloaded from ${activity.eventName || 'Unknown'}`,
      'bulk_delete_completed': `${md.deleted || md.count || 0} events deleted`,
      'gallery_password_entry': `Password entered for ${activity.eventName || 'Unknown'}`,
      'expiration_warning_viewed': `Expiration warning viewed for ${activity.eventName || 'Unknown'}`,
      'photo_replaced': `Photo replaced in ${activity.eventName || 'Unknown'}`,
      'photo_uploaded': `Photo uploaded to ${activity.eventName || 'Unknown'}`,
      'category_hero_updated': `Category hero photo updated`,
      'public_site_reset_to_default': 'Public site reset to default',
      'cms_page_logo_uploaded': `CMS page logo uploaded: ${md.slug || ''}`,
      // Customer portal (#354).
      'customer_login': `Customer logged in: ${md.email || activity.actorName || ''}`,
      'customer_invitation_created': `Customer invitation sent to ${md.email || ''}`,
      'customer_invitation_accepted': `Customer accepted invitation: ${md.email || ''}`,
      'customer_invitation_cancelled': `Customer invitation cancelled: ${md.email || ''}`,
      'customer_password_reset_requested': `Password reset requested for customer ${md.email || ''}`,
      'customer_password_reset_applied': `Customer password reset by admin: ${md.email || ''}`,
      'customer_password_change': `Customer changed their password`,
      'customer_self_profile_update': `Customer updated their profile`,
      'customer_event_access': `Customer opened ${activity.eventName || md.event_slug || 'a gallery'}`,
      'customer_updated': `Customer account updated: ${md.email || ''}`,
      'customer_deactivated': `Customer account deactivated: ${md.email || ''}`,
      'customer_reactivated': `Customer account reactivated: ${md.email || ''}`,
      'customer_erased': `Customer account erased (GDPR): ${md.email || ''}`,
      // Admin user management (#350).
      'admin_invitation_created': `Admin invitation sent to ${md.email || ''}`,
      'admin_invitation_accepted': `Admin accepted invitation: ${md.email || md.username || ''}`,
      'admin_invitation_cancelled': `Admin invitation cancelled: ${md.email || ''}`,
      'admin_user_updated': `Admin user updated: ${md.username || md.email || ''}`,
      'admin_user_deactivated': `Admin user deactivated: ${md.username || md.email || ''}`,
      'admin_password_reset': `Admin password reset by another admin: ${md.username || md.email || ''}`,
      'admin_profile_updated': `Admin ${activity.actorName || ''} updated their profile`,
      // Webhooks (#327) + API tokens (#322) + event types.
      'webhook_created': `Webhook created: ${md.name || ''}`,
      'webhook_updated': `Webhook updated: ${md.name || ''}`,
      'webhook_deleted': `Webhook deleted: ${md.name || ''}`,
      'api_token_created': `API token created: ${md.name || ''}`,
      'api_token_revoked': `API token revoked: ${md.name || ''}`,
      'event_type_created': `Event type created: ${md.name || ''}`,
      'event_type_updated': `Event type updated: ${md.name || ''}`,
      'event_type_deleted': `Event type deleted: ${md.name || ''}`,
      'event_types_reordered': 'Event types reordered',
      // CRM — Contracts.
      'contract_created': `Contract created: ${md.contractNumber || ''}`,
      'contract_created_from_quote': `Contract created from quote: ${md.contractNumber || ''}`,
      'contract_updated': `Contract updated: ${md.contractNumber || ''}`,
      'contract_sent': `Contract sent: ${md.contractNumber || ''}`,
      'contract_resent_signed': `Signed contract resent: ${md.contractNumber || ''}`,
      'contract_signed_by_customer': `Contract signed by customer: ${md.contractNumber || ''}`,
      'contract_signed_pdf_uploaded': `Signed contract PDF uploaded: ${md.contractNumber || ''}`,
      'contract_signatures_restamped': `Contract signatures re-stamped: ${md.contractNumber || ''}`,
      'contract_cancelled': `Contract cancelled: ${md.contractNumber || ''}`,
      'contract_converted_to_event': `Contract converted to event: ${md.contractNumber || ''}`,
      'contract_converted_to_empty_event': `Contract converted to empty event: ${md.contractNumber || ''}`,
      'contract_converted_to_invoices': `Contract converted to invoices: ${md.contractNumber || ''}`,
      'contract_converted_to_empty_invoice': `Contract converted to empty invoice: ${md.contractNumber || ''}`,
      // CRM — Quotes.
      'quote_created': `Quote created: ${md.quoteNumber || ''}`,
      'quote_sent': `Quote sent: ${md.quoteNumber || ''}`,
      'quote_updated': `Quote updated: ${md.quoteNumber || ''}`,
      'quote_accepted_by_admin': `Quote accepted: ${md.quoteNumber || ''}`,
      'quote_declined_by_admin': `Quote declined: ${md.quoteNumber || ''}`,
      'quote_converted': `Quote converted: ${md.quoteNumber || ''}`,
      'quote_converted_invoices_only': `Quote converted to invoices: ${md.quoteNumber || ''}`,
      // CRM — Invoices / Storno.
      'invoice_created': `Invoice created: ${md.invoiceNumber || ''}`,
      'invoice_sent': `Invoice sent: ${md.invoiceNumber || ''}`,
      'invoice_scheduled': `Invoice scheduled: ${md.invoiceNumber || ''}`,
      'invoice_cancelled': `Invoice cancelled: ${md.invoiceNumber || ''}`,
      'invoice_cancelled_via_storno': `Invoice cancelled via Storno: ${md.invoiceNumber || ''}`,
      'invoice_reissued': `Invoice reissued: ${md.invoiceNumber || ''}`,
      'invoice_paid_admin_notified': `Invoice marked paid: ${md.invoiceNumber || ''}`,
      'invoice_payment_check_recorded': `Payment-check recorded for invoice: ${md.invoiceNumber || ''}`,
      'invoice_payment_check_sent': `Payment-check sent for invoice: ${md.invoiceNumber || ''}`,
      'invoice_released_for_delivery': `Invoice released for delivery: ${md.invoiceNumber || ''}`,
      'invoice_reminder_sent': `Invoice reminder sent: ${md.invoiceNumber || ''}`,
      'storno_sent': `Storno sent: ${md.invoiceNumber || ''}`,
      // CRM — Monthly billing.
      'monthly_bill_issued': 'Monthly bill issued for customer',
      'monthly_bill_skipped_empty': 'Monthly bill skipped (no entries)',
      'monthly_bill_triggered_manually': 'Monthly bill triggered manually',
      'monthly_billing_items_queued': 'Monthly billing items queued',
      'installment_plan_updated': 'Installment plan updated',
      // Accounting — Expenses + Hours + Incoming invoices.
      'expense_created': 'Expense created',
      'expense_updated': 'Expense updated',
      'expense_paid': 'Expense marked paid',
      'expense_invoiced': 'Expense invoiced',
      'hour_entry_logged': 'Hour entry logged',
      'hour_entry_updated': 'Hour entry updated',
      'hour_entry_deleted': 'Hour entry deleted',
      'hour_entry_logged_to_monthly_draft': 'Hour entry logged to monthly draft',
      'hour_entries_billed': 'Hour entries billed to customer',
      'incoming_invoice_captured': 'Incoming invoice captured',
      'incoming_invoice_categorized': 'Incoming invoice categorised',
      'incoming_invoice_updated': 'Incoming invoice updated',
      'incoming_invoice_rebilled': 'Incoming invoice re-billed to customer',
      'incoming_invoice_supplier_payment': 'Supplier payment recorded',
      'incoming_mail_config_updated': 'Incoming mail configuration updated',
      // Customers + Admin user mgmt.
      'customer_created_passive': `Passive customer created: ${md.email || ''}`,
      'admin_user_activated': `Admin user activated: ${md.username || ''}`,
      'admin_user_deleted': `Admin user deleted: ${md.username || ''}`,
      'admin_password_reset': `Admin password reset: ${md.username || ''}`,
      // Misc / legacy.
      'bulk_archive_completed': `Bulk archive completed: ${md.count || 0} events archived`,
      'email_queue_flushed': 'Email queue flushed',
      'email_resent': `Creation email resent for ${activity.eventName || ''}`,
      'email_template_created': `Email template created: ${md.template_key || ''}`,
      'event_duplicated': `Event duplicated from ${md.source_event_name || ''}`,
      'feedback_deleted': 'Feedback deleted',
      'feedback_moderated': 'Feedback moderated',
      'feedback_settings_updated': `Feedback settings updated for ${activity.eventName || ''}`,
      'word_filter_added': `Word filter added: ${md.word || ''}`,
    };

    return messages[activity.type] || activity.type;
  },

  // Format bytes to human readable
  formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  },

  // Change password
  async changePassword(data: { currentPassword: string; newPassword: string }): Promise<void> {
    await api.post('/admin/auth/change-password', data);
  },

  async getAdminProfile(): Promise<AdminProfile> {
    const response = await api.get<AdminProfile>('/admin/auth/profile');
    return response.data;
  },

  async updateAdminProfile(data: { username: string; email: string }): Promise<AdminProfile> {
    const response = await api.put<{ user: AdminProfile }>('/admin/auth/profile', data);
    return response.data.user;
  }
};
