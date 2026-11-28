import React from 'react';
import { useTranslation } from 'react-i18next';

export const SkipLink: React.FC = () => {
  const { t } = useTranslation();
  return (
    <a
      href="#main-content"
      className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 bg-accent-dark text-white px-4 py-2 rounded-lg z-50 focus:outline-none focus:ring-2 focus:ring-accent"
    >
      {t('common.skipToContent', 'Skip to main content')}
    </a>
  );
};