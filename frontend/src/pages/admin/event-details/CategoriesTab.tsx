import React from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '../../../components/common';
import { EventCategoryManager } from '../../../components/admin';

interface CategoriesTabProps {
  id: string | undefined;
}

export const CategoriesTab: React.FC<CategoriesTabProps> = ({ id }) => {
  const { t } = useTranslation();

  return (
    <div>
      <Card padding="md">
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-2">{t('events.photoCategories')}</h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {t('events.organizeCategoriesInfo')}
          </p>
        </div>

        <EventCategoryManager
          eventId={parseInt(id!)}
        />

        <div className="mt-6 p-4 bg-blue-50 dark:bg-blue-900/30 rounded-lg">
          <p className="text-sm text-blue-800 dark:text-blue-300">
            {t('events.categoriesTip')}
          </p>
        </div>
      </Card>
    </div>
  );
};
