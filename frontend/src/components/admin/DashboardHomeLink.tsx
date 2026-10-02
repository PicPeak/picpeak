import React from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useGuardedLinkClick } from '../../contexts/UnsavedChangesContext';

const DASHBOARD_HREF = '/admin/dashboard';

interface DashboardHomeLinkProps {
  className?: string;
  /** Runs once the navigation is going ahead (e.g. close the mobile drawer). */
  onNavigate?: () => void;
  children: React.ReactNode;
}

/**
 * The admin brand (logo or wordmark) doubles as the way home. A form with
 * unsaved edits gets to say no first, the same as every other way out of a
 * page (UnsavedChangesProvider). The link's accessible name stays the brand
 * the children render; the tooltip says where it goes.
 */
export const DashboardHomeLink: React.FC<DashboardHomeLinkProps> = ({ className = '', onNavigate, children }) => {
  const { t } = useTranslation();
  const guardedLinkClick = useGuardedLinkClick();

  return (
    <Link
      to={DASHBOARD_HREF}
      onClick={(e) => guardedLinkClick(e, DASHBOARD_HREF, { after: onNavigate })}
      title={t('navigation.dashboard', 'Dashboard')}
      className={`focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 ${className}`}
    >
      {children}
    </Link>
  );
};
