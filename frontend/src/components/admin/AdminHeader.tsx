import React, { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Menu, User, LogOut, Settings, Bell, Lock, CheckCircle, Trash2, Sun, Moon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import { useAdminAuth } from '../../contexts';
import { useAdminDarkMode } from '../../contexts/AdminDarkModeContext';
import { useOnClickOutside } from '../../hooks/useOnClickOutside';
import { usePublicSettings } from '../../hooks/usePublicSettings';
import { PasswordChangeModal } from './PasswordChangeModal';
import { LanguageSelector } from '../common';
import { notificationsService } from '../../services/notifications.service';
import { toast } from 'react-toastify';
import { buildResourceUrl } from '../../utils/url';

interface AdminHeaderProps {
  onMenuClick: () => void;
}

export const AdminHeader: React.FC<AdminHeaderProps> = ({ onMenuClick }) => {
  const navigate = useNavigate();
  const { user, logout } = useAdminAuth();
  const { isDark, toggle: toggleDarkMode, forcedMode } = useAdminDarkMode();
  const { t } = useTranslation();
  const { format, formatDistanceToNow } = useLocalizedDate();
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const queryClient = useQueryClient();
  
  const { data: brandingSettings } = usePublicSettings();

  const companyName = brandingSettings?.branding_company_name?.trim() || 'PicPeak';
  const logoUrl = brandingSettings?.branding_logo_url?.trim();
  const logoDisplayMode = brandingSettings?.branding_logo_display_mode || 'logo_and_text';
  const resolvedLogoUrl = logoUrl
    ? (logoUrl.startsWith('http') ? logoUrl : buildResourceUrl(logoUrl))
    : '/picpeak-kamera-transparent.png';

  const userMenuRef = useRef<HTMLDivElement>(null);
  const notificationRef = useRef<HTMLDivElement>(null);

  useOnClickOutside(userMenuRef, () => setShowUserMenu(false));
  useOnClickOutside(notificationRef, () => setShowNotifications(false));

  const handleLogout = () => {
    logout();
    navigate('/admin/login');
  };

  // Fetch notifications
  const { data: notificationsData } = useQuery({
    queryKey: ['notifications', showNotifications],
    queryFn: () => notificationsService.getNotifications(showNotifications, 20),
    refetchInterval: 60000, // Refetch every minute
  });

  // Mark all as read mutation
  const markAllAsReadMutation = useMutation({
    mutationFn: notificationsService.markAllAsRead,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      toast.success(t('admin.notificationToasts.markedAllRead'));
    },
  });

  // Clear notifications mutation
  const clearAllMutation = useMutation({
    mutationFn: notificationsService.clearAllNotifications,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      toast.success(t('admin.notificationToasts.clearedAll', { count: data.deletedCount }));
    },
  });

  const notifications = notificationsData?.notifications || [];
  const unreadCount = notificationsData?.unreadCount || 0;

  return (
    <header className="sticky top-0 z-30 bg-white dark:bg-neutral-900 border-b border-neutral-200 dark:border-neutral-700">
      <div className="px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Left side - Menu button, Logo, and Date */}
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={onMenuClick}
              className="lg:hidden text-neutral-500 hover:text-neutral-700"
            >
              <Menu className="w-6 h-6" />
            </button>

            {/* Logo - sticky to the left on all sizes */}
            <div className="flex items-center gap-2">
              {(logoDisplayMode === 'logo_only' || logoDisplayMode === 'logo_and_text') && (
                <img src={resolvedLogoUrl} alt={companyName} className="h-8 w-auto object-contain" />
              )}
              {(logoDisplayMode === 'text_only' || logoDisplayMode === 'logo_and_text') && (
                <span className="text-xl sm:text-2xl" style={{ fontFamily: 'Poppins, sans-serif', fontWeight: 600, color: '#145346' }}>{companyName}</span>
              )}
            </div>

            {/* Date display - hidden on smaller screens */}
            <div className="hidden xl:block pl-3 border-l border-neutral-200 dark:border-neutral-700 ml-1">
              <p className="text-base text-neutral-700 dark:text-neutral-300">
                {format(new Date(), 'PPPP')}
              </p>
            </div>
          </div>

          {/* Right side actions */}
          <div className="flex items-center gap-3">
            {/* Language Selector */}
            <LanguageSelector />

            {/* Dark Mode Toggle — hidden entirely when an admin has locked
                the instance to a specific mode via Branding > Force color mode. */}
            {!forcedMode && (
              <button
                onClick={toggleDarkMode}
                className="p-2 text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-lg transition-colors"
                title={isDark ? t('admin.lightMode', 'Switch to light mode') : t('admin.darkMode', 'Switch to dark mode')}
              >
                {isDark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
              </button>
            )}

            {/* Notifications */}
            <div className="relative" ref={notificationRef}>
              <button
                onClick={() => setShowNotifications(!showNotifications)}
                className="relative p-2 text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-lg transition-colors"
              >
                <Bell className="w-5 h-5" />
                {unreadCount > 0 && (
                  <span className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full" />
                )}
              </button>

              {/* Notifications dropdown */}
              {showNotifications && (
                <div className="absolute right-0 mt-2 w-96 bg-white dark:bg-neutral-800 rounded-lg shadow-lg border border-neutral-200 dark:border-neutral-700">
                  <div className="px-4 py-3 border-b border-neutral-100 dark:border-neutral-700 flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{t('admin.notifications')}</h3>
                    <div className="flex items-center gap-2">
                      {unreadCount > 0 && (
                        <button
                          onClick={() => markAllAsReadMutation.mutate()}
                          className="text-xs text-accent hover:opacity-80 flex items-center gap-1"
                          title={t('admin.markAllRead')}
                        >
                          <CheckCircle className="w-3 h-3" />
                          {t('admin.markAllRead')}
                        </button>
                      )}
                      <button
                        onClick={() => clearAllMutation.mutate()}
                        className="text-xs text-neutral-600 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300 flex items-center gap-1"
                        title={t('admin.clearAll')}
                      >
                        <Trash2 className="w-3 h-3" />
                        {t('admin.clearAll')}
                      </button>
                    </div>
                  </div>
                  <div className="max-h-96 overflow-y-auto">
                    {notifications.length === 0 ? (
                      <div className="px-4 py-8 text-center text-sm text-neutral-500 dark:text-neutral-400">
                        {t('admin.noNotificationsMessage')}
                      </div>
                    ) : (
                      notifications.map((notification) => {
                        const style = notificationsService.getNotificationStyle(notification.type);
                        return (
                          <div
                            key={notification.id}
                            className={`px-4 py-3 hover:bg-neutral-50 dark:hover:bg-neutral-700 cursor-pointer border-l-4 ${
                              notification.isRead ? 'border-transparent opacity-75' : 'border-accent-dark'
                            }`}
                          >
                            <div className="flex items-start gap-3">
                              <div className={`mt-0.5 ${style.color}`}>
                                <Bell className="w-4 h-4" />
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="text-sm text-neutral-900 dark:text-neutral-100">
                                  {notificationsService.formatNotificationMessage(notification)}
                                </p>
                                <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                                  {formatDistanceToNow(notification.createdAt, { addSuffix: true })}
                                </p>
                              </div>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                  {notifications.length > 0 && (
                    <div className="px-4 py-2 border-t border-neutral-100 dark:border-neutral-700 text-center">
                      <button
                        onClick={() => setShowNotifications(false)}
                        className="text-sm text-accent hover:opacity-80"
                      >
                        {t('admin.close')}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* User menu */}
            <div className="relative" ref={userMenuRef}>
              <button
                onClick={() => setShowUserMenu(!showUserMenu)}
                className="flex items-center gap-3 p-2 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-lg transition-colors"
              >
                <div className="text-right hidden sm:block">
                  <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{user?.username}</p>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400">{user?.email}</p>
                </div>
                <div className="w-8 h-8 bg-accent-dark rounded-full flex items-center justify-center">
                  <User className="w-5 h-5 text-white" />
                </div>
              </button>

              {/* User dropdown */}
              {showUserMenu && (
                <div className="absolute right-0 mt-2 w-56 bg-white dark:bg-neutral-800 rounded-lg shadow-lg border border-neutral-200 dark:border-neutral-700 py-1">
                  <div className="px-4 py-2 border-b border-neutral-100 dark:border-neutral-700 sm:hidden">
                    <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{user?.username}</p>
                    <p className="text-xs text-neutral-500 dark:text-neutral-400">{user?.email}</p>
                  </div>
                  <button
                    onClick={() => {
                      setShowUserMenu(false);
                      navigate('/admin/settings');
                    }}
                    className="w-full px-4 py-2 text-left text-sm text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-700 flex items-center gap-3"
                  >
                    <Settings className="w-4 h-4" />
                    {t('navigation.settings')}
                  </button>
                  <button
                    onClick={() => {
                      setShowUserMenu(false);
                      setShowPasswordModal(true);
                    }}
                    className="w-full px-4 py-2 text-left text-sm text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-700 flex items-center gap-3"
                  >
                    <Lock className="w-4 h-4" />
                    {t('admin.changePassword')}
                  </button>
                  <button
                    onClick={handleLogout}
                    className="w-full px-4 py-2 text-left text-sm text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-700 flex items-center gap-3"
                  >
                    <LogOut className="w-4 h-4" />
                    {t('common.logout')}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      
      {/* Password Change Modal */}
      <PasswordChangeModal 
        isOpen={showPasswordModal} 
        onClose={() => setShowPasswordModal(false)} 
      />
    </header>
  );
};
