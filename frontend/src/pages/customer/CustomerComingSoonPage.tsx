/**
 * Generic placeholder for customer-surface features that aren't built yet
 * but are surfaced in the sidebar so the maintainer can demo the layout
 * without the feature being live (Calendar, Quotes, Bills — #354 follow-ups).
 *
 * Single component re-used for all three; the calling page passes the title
 * + lucide icon so each route stays distinguishable in the address bar and
 * heading.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';

interface CustomerComingSoonPageProps {
  titleKey: string;
  titleFallback: string;
  bodyKey: string;
  bodyFallback: string;
  icon: React.ComponentType<{ className?: string }>;
}

export const CustomerComingSoonPage: React.FC<CustomerComingSoonPageProps> = ({
  titleKey, titleFallback, bodyKey, bodyFallback, icon: Icon,
}) => {
  const { t } = useTranslation();
  return (
    <div className="container py-8 sm:py-16">
      <div
        className="max-w-xl mx-auto rounded-xl border p-8 sm:p-12 text-center"
        style={{
          backgroundColor: 'var(--color-surface)',
          borderColor: 'var(--color-surface-border)',
        }}
      >
        <div
          className="mx-auto mb-4 w-14 h-14 rounded-full flex items-center justify-center"
          style={{ backgroundColor: 'color-mix(in srgb, var(--color-accent) 14%, transparent)' }}
        >
          <Icon className="w-7 h-7" style={{ color: 'var(--color-accent)' }} />
        </div>
        <span
          className="inline-block text-[10px] uppercase tracking-wider px-2 py-0.5 rounded font-semibold mb-3"
          style={{
            backgroundColor: 'color-mix(in srgb, var(--color-accent) 14%, transparent)',
            color: 'var(--color-accent)',
          }}
        >
          {t('customer.comingSoon.tag', 'Coming soon')}
        </span>
        <h1 className="text-2xl font-bold text-theme mb-2">
          {t(titleKey, titleFallback)}
        </h1>
        <p className="text-sm text-muted-theme leading-relaxed">
          {t(bodyKey, bodyFallback)}
        </p>
      </div>
    </div>
  );
};

export default CustomerComingSoonPage;
