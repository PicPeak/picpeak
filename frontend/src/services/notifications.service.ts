import { api } from '../config/api';
import i18n from '../i18n/config';
import { formatFeatureFlagsChanged } from './admin.service';

export interface Notification {
  id: number;
  type: string;
  actorType: string;
  actorName: string;
  eventName?: string;
  eventId?: number;
  metadata: Record<string, any>;
  createdAt: string;
  readAt?: string;
  isRead: boolean;
}

export interface NotificationsResponse {
  notifications: Notification[];
  unreadCount: number;
}

export const notificationsService = {
  // Get notifications
  async getNotifications(includeRead: boolean = false, limit: number = 20): Promise<NotificationsResponse> {
    const response = await api.get('/admin/notifications', {
      params: { includeRead, limit }
    });
    return response.data;
  },

  // Mark single notification as read
  async markAsRead(notificationId: number): Promise<void> {
    await api.put(`/admin/notifications/${notificationId}/read`);
  },

  // Mark all notifications as read
  async markAllAsRead(): Promise<void> {
    await api.put('/admin/notifications/read-all');
  },

  // Clear all notifications
  async clearAllNotifications(): Promise<{ deletedCount: number }> {
    const response = await api.delete('/admin/notifications/clear-all');
    return response.data;
  },

  // Format notification message
  formatNotificationMessage(notification: Notification): string {
    const t = i18n.t;
    switch (notification.type) {
      case 'event_created':
        return t('admin.notificationMessages.eventCreated', { eventName: notification.eventName });
      case 'event_archived':
        return t('admin.notificationMessages.eventArchived', { eventName: notification.eventName });
      case 'event_updated':
        return t('admin.notificationMessages.eventUpdated', { 
          eventName: notification.eventName || notification.metadata.eventName 
        });
      case 'event_deleted':
        return t('admin.notificationMessages.eventDeleted', { 
          eventName: notification.metadata.event_name 
        });
      case 'photos_uploaded':
        return t('admin.notificationMessages.photosUploaded', { 
          count: notification.metadata.count || 0, 
          eventName: notification.eventName 
        });
      case 'photo_deleted':
        return t('admin.notificationMessages.photoDeleted', { eventName: notification.eventName });
      case 'photos_bulk_deleted':
        return t('admin.notificationMessages.photosBulkDeleted', { 
          count: notification.metadata.count || 0, 
          eventName: notification.eventName 
        });
      case 'event_expiring':
        return t('admin.notificationMessages.eventExpiring', { 
          eventName: notification.eventName, 
          days: notification.metadata.days || 0 
        });
      case 'event_expired':
        return t('admin.notificationMessages.eventExpired', { eventName: notification.eventName });
      case 'password_changed':
        return t('admin.notificationMessages.passwordChanged', { actorName: notification.actorName });
      case 'password_reset':
        return t('admin.notificationMessages.passwordReset', { 
          eventName: notification.metadata.eventName 
        });
      case 'settings_updated':
        return t('admin.notificationMessages.settingsUpdated', { 
          type: notification.metadata.type || 'System' 
        });
      case 'email_template_updated':
        return t('admin.notificationMessages.emailTemplateUpdated', { 
          template: notification.metadata.template 
        });
      case 'bulk_download':
        return t('admin.notificationMessages.bulkDownload', { 
          count: notification.metadata.count || 0, 
          eventName: notification.eventName 
        });
      case 'storage_warning':
        return t('admin.notificationMessages.storageWarning', { 
          percentage: notification.metadata.percentage || 0 
        });
      case 'admin_logout':
        return t('admin.notificationMessages.adminLogout', { actorName: notification.actorName });
      case 'category_created':
        return t('admin.notificationMessages.categoryCreated', { 
          name: notification.metadata.name, 
          eventName: notification.eventName 
        });
      case 'category_updated':
        return t('admin.notificationMessages.categoryUpdated', { 
          name: notification.metadata.name, 
          eventName: notification.eventName 
        });
      case 'category_deleted':
        return t('admin.notificationMessages.categoryDeleted', { 
          name: notification.metadata.name, 
          eventName: notification.eventName 
        });
      case 'cms_page_updated':
        return t('admin.notificationMessages.cmsPageUpdated', { 
          slug: notification.metadata.slug 
        });
      case 'email_config_updated':
        return t('admin.notificationMessages.emailConfigUpdated');
      case 'favicon_uploaded':
        return t('admin.notificationMessages.faviconUploaded');
      case 'branding_updated':
        return t('admin.notificationMessages.brandingUpdated');
      case 'general_settings_updated':
        return t('admin.notificationMessages.generalSettingsUpdated');
      case 'security_settings_updated':
        return t('admin.notificationMessages.securitySettingsUpdated');
      case 'admin_profile_updated':
        return t('admin.notificationMessages.adminProfileUpdated', {
          actorName: notification.actorName,
        });
      case 'theme_updated':
        return t('admin.notificationMessages.themeUpdated');
      case 'archive_downloaded':
        return t('admin.notificationMessages.archiveDownloaded', { 
          eventName: notification.metadata.event_name 
        });
      case 'archive_deleted':
        return t('admin.notificationMessages.archiveDeleted', { 
          eventName: notification.metadata.event_name 
        });
      case 'archive_restored':
        return t('admin.notificationMessages.archiveRestored', {
          eventName: notification.metadata.event_name
        });

      // ---- Feature flags --------------------------------------------------
      // Smart-formatted from metadata.changed so the row says what
      // actually flipped (e.g. "Customer Portal enabled") instead of
      // the raw activity type. Helper is shared with the Dashboard
      // recent-activity widget.
      case 'feature_flags_updated':
        return formatFeatureFlagsChanged(notification.metadata?.changed);

      // ---- Customer portal (#354) -----------------------------------------
      case 'customer_login':
        return t('admin.notificationMessages.customerLogin', {
          email: notification.metadata.email || notification.actorName,
        });
      case 'customer_invitation_created':
        return t('admin.notificationMessages.customerInvitationCreated', {
          email: notification.metadata.email,
        });
      case 'customer_invitation_accepted':
        return t('admin.notificationMessages.customerInvitationAccepted', {
          email: notification.metadata.email,
        });
      case 'customer_invitation_cancelled':
        return t('admin.notificationMessages.customerInvitationCancelled', {
          email: notification.metadata.email,
        });
      case 'customer_password_reset_requested':
        return t('admin.notificationMessages.customerPasswordResetRequested', {
          email: notification.metadata.email,
        });
      case 'customer_password_reset_applied':
        return t('admin.notificationMessages.customerPasswordResetApplied', {
          email: notification.metadata.email,
        });
      case 'customer_password_change':
        return t('admin.notificationMessages.customerPasswordChange', {
          email: notification.metadata.email || notification.actorName,
        });
      case 'customer_self_profile_update':
        return t('admin.notificationMessages.customerSelfProfileUpdate', {
          email: notification.metadata.email || notification.actorName,
        });
      case 'customer_event_access':
        return t('admin.notificationMessages.customerEventAccess', {
          email: notification.metadata.email || notification.actorName,
          eventName: notification.eventName || notification.metadata.event_slug || '',
        });
      case 'customer_updated':
        return t('admin.notificationMessages.customerUpdated', {
          email: notification.metadata.email,
        });
      case 'customer_deactivated':
        return t('admin.notificationMessages.customerDeactivated', {
          email: notification.metadata.email,
        });
      case 'customer_reactivated':
        return t('admin.notificationMessages.customerReactivated', {
          email: notification.metadata.email,
        });
      case 'customer_erased':
        return t('admin.notificationMessages.customerErased', {
          email: notification.metadata.email,
        });

      // ---- Admin user management (#350) -----------------------------------
      case 'admin_invitation_created':
        return t('admin.notificationMessages.adminInvitationCreated', {
          email: notification.metadata.email,
        });
      case 'admin_invitation_accepted':
        return t('admin.notificationMessages.adminInvitationAccepted', {
          email: notification.metadata.email || notification.metadata.username,
        });
      case 'admin_invitation_cancelled':
        return t('admin.notificationMessages.adminInvitationCancelled', {
          email: notification.metadata.email,
        });
      case 'admin_user_updated':
        return t('admin.notificationMessages.adminUserUpdated', {
          username: notification.metadata.username || notification.metadata.email,
        });
      case 'admin_user_deactivated':
        return t('admin.notificationMessages.adminUserDeactivated', {
          username: notification.metadata.username || notification.metadata.email,
        });
      case 'admin_password_reset':
        return t('admin.notificationMessages.adminPasswordResetByAdmin', {
          username: notification.metadata.username || notification.metadata.email,
        });

      // ---- Webhooks (#327) + API tokens (#322) + event types --------------
      case 'webhook_created':
        return t('admin.notificationMessages.webhookCreated', { name: notification.metadata.name });
      case 'webhook_updated':
        return t('admin.notificationMessages.webhookUpdated', { name: notification.metadata.name });
      case 'webhook_deleted':
        return t('admin.notificationMessages.webhookDeleted', { name: notification.metadata.name });
      case 'api_token_created':
        return t('admin.notificationMessages.apiTokenCreated', { name: notification.metadata.name });
      case 'api_token_revoked':
        return t('admin.notificationMessages.apiTokenRevoked', { name: notification.metadata.name });
      case 'event_type_created':
        return t('admin.notificationMessages.eventTypeCreated', { name: notification.metadata.name });
      case 'event_type_updated':
        return t('admin.notificationMessages.eventTypeUpdated', { name: notification.metadata.name });
      case 'event_type_deleted':
        return t('admin.notificationMessages.eventTypeDeleted', { name: notification.metadata.name });
      case 'event_types_reordered':
        return t('admin.notificationMessages.eventTypesReordered');

      // ---- Other recent surfaces ------------------------------------------
      case 'event_published':
        return t('admin.notificationMessages.eventPublished', {
          eventName: notification.eventName || notification.metadata.event_name,
        });
      case 'event_logo_uploaded':
        return t('admin.notificationMessages.eventLogoUploaded', { eventName: notification.eventName });
      case 'event_logo_removed':
        return t('admin.notificationMessages.eventLogoRemoved', { eventName: notification.eventName });
      case 'bulk_delete_completed':
        return t('admin.notificationMessages.bulkDeleteCompleted', {
          count: notification.metadata.deleted || notification.metadata.count || 0,
        });
      case 'photo_replaced':
        return t('admin.notificationMessages.photoReplaced', { eventName: notification.eventName });
      case 'photo_uploaded':
        return t('admin.notificationMessages.photoUploaded', { eventName: notification.eventName });
      case 'category_hero_updated':
        return t('admin.notificationMessages.categoryHeroUpdated');
      case 'public_site_reset_to_default':
        return t('admin.notificationMessages.publicSiteResetToDefault');
      case 'cms_page_logo_uploaded':
        return t('admin.notificationMessages.cmsPageLogoUploaded', {
          slug: notification.metadata.slug,
        });

      default: {
        // Smart fallback: try to resolve admin.notificationMessages.<camelCase>
        // directly before giving up to the systemActivity template. Most CRM
        // and accounting activity types follow a stable shape (a doc number /
        // customer email / count interpolated into a short sentence), so we
        // add their translation entries to the locale files and rely on this
        // default to pick them up — no per-type switch case needed.
        const camelCase = notification.type.replace(/_(\w)/g, (_match, c) => c.toUpperCase());
        const key = `admin.notificationMessages.${camelCase}`;
        const translated = t(key, {
          eventName: notification.eventName,
          actorName: notification.actorName,
          ...notification.metadata,
        });
        if (translated && translated !== key) return translated as string;
        // Truly unknown — log and render the legacy systemActivity template.
        console.warn('Unknown notification type:', notification.type, notification);
        return notification.metadata.message || t('admin.notificationMessages.systemActivity', {
          type: notification.type.replace(/_/g, ' ')
        });
      }
    }
  },

  // Get notification icon and color
  getNotificationStyle(type: string): { icon: string; color: string } {
    switch (type) {
      case 'event_created':
        return { icon: 'Calendar', color: 'text-blue-600' };
      case 'event_archived':
        return { icon: 'Archive', color: 'text-green-600' };
      case 'event_updated':
      case 'event_deleted':
        return { icon: 'Calendar', color: 'text-gray-600' };
      case 'photos_uploaded':
        return { icon: 'Image', color: 'text-purple-600' };
      case 'photo_deleted':
      case 'photos_bulk_deleted':
        return { icon: 'Image', color: 'text-red-600' };
      case 'event_expiring':
        return { icon: 'AlertCircle', color: 'text-amber-600' };
      case 'event_expired':
        return { icon: 'Clock', color: 'text-red-600' };
      case 'password_changed':
      case 'password_reset':
        return { icon: 'Lock', color: 'text-indigo-600' };
      case 'settings_updated':
      case 'branding_updated':
      case 'general_settings_updated':
      case 'security_settings_updated':
      case 'theme_updated':
        return { icon: 'Settings', color: 'text-gray-600' };
      case 'admin_profile_updated':
        return { icon: 'User', color: 'text-primary-600' };
      case 'email_template_updated':
      case 'email_config_updated':
        return { icon: 'Mail', color: 'text-teal-600' };
      case 'bulk_download':
        return { icon: 'Download', color: 'text-cyan-600' };
      case 'storage_warning':
        return { icon: 'Database', color: 'text-orange-600' };
      case 'admin_logout':
        return { icon: 'LogOut', color: 'text-gray-600' };
      case 'category_created':
      case 'category_updated':
      case 'category_deleted':
        return { icon: 'Folder', color: 'text-indigo-600' };
      case 'cms_page_updated':
        return { icon: 'FileText', color: 'text-green-600' };
      case 'favicon_uploaded':
        return { icon: 'Globe', color: 'text-purple-600' };
      case 'archive_downloaded':
      case 'archive_deleted':
      case 'archive_restored':
        return { icon: 'Archive', color: 'text-blue-600' };

      // Feature flag toggles + customer / admin / webhook surfaces. Icon
      // choices favour the tone of the action (settings / users / network)
      // over per-event-type cleverness.
      case 'feature_flags_updated':
        return { icon: 'ToggleRight', color: 'text-amber-600' };
      case 'customer_login':
      case 'customer_event_access':
      case 'customer_self_profile_update':
      case 'customer_password_change':
        return { icon: 'User', color: 'text-blue-600' };
      case 'customer_invitation_created':
      case 'customer_invitation_accepted':
      case 'customer_invitation_cancelled':
        return { icon: 'Mail', color: 'text-teal-600' };
      case 'customer_password_reset_requested':
      case 'customer_password_reset_applied':
        return { icon: 'Lock', color: 'text-indigo-600' };
      case 'customer_updated':
      case 'customer_deactivated':
      case 'customer_reactivated':
        return { icon: 'UserCog', color: 'text-gray-600' };
      case 'customer_erased':
        return { icon: 'Trash2', color: 'text-red-600' };
      case 'admin_invitation_created':
      case 'admin_invitation_accepted':
      case 'admin_invitation_cancelled':
        return { icon: 'Mail', color: 'text-teal-600' };
      case 'admin_user_updated':
      case 'admin_user_deactivated':
        return { icon: 'UserCog', color: 'text-gray-600' };
      case 'admin_password_reset':
        return { icon: 'Lock', color: 'text-indigo-600' };
      case 'webhook_created':
      case 'webhook_updated':
      case 'webhook_deleted':
        return { icon: 'Webhook', color: 'text-purple-600' };
      case 'api_token_created':
      case 'api_token_revoked':
        return { icon: 'Key', color: 'text-orange-600' };
      case 'event_type_created':
      case 'event_type_updated':
      case 'event_type_deleted':
      case 'event_types_reordered':
        return { icon: 'Tag', color: 'text-violet-600' };
      case 'event_published':
        return { icon: 'CheckCircle', color: 'text-green-600' };
      case 'event_logo_uploaded':
      case 'event_logo_removed':
        return { icon: 'Image', color: 'text-pink-600' };
      case 'bulk_delete_completed':
        return { icon: 'Trash2', color: 'text-red-600' };
      case 'photo_replaced':
      case 'photo_uploaded':
        return { icon: 'Image', color: 'text-purple-600' };
      case 'category_hero_updated':
        return { icon: 'Folder', color: 'text-indigo-600' };
      case 'public_site_reset_to_default':
        return { icon: 'Globe', color: 'text-gray-600' };
      case 'cms_page_logo_uploaded':
        return { icon: 'FileText', color: 'text-green-600' };

      default:
        return { icon: 'Bell', color: 'text-gray-600' };
    }
  }
};
