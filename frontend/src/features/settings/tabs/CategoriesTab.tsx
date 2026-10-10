import React from 'react';
import { Image } from 'lucide-react';
import { Card } from '../../../components/common';
import { CategoryManager } from '../../../components/admin/CategoryManager';
import { useTranslation } from 'react-i18next';

export const CategoriesTab: React.FC = () => {
  const { t } = useTranslation();

  return (
    <div className="space-y-6">
      <Card padding="md">
        <CategoryManager />
      </Card>

      <Card padding="md">
        <div className="flex items-start gap-3">
          <Image className="w-5 h-5 text-info-text flex-shrink-0" />
          <div>
            <h3 className="text-sm font-semibold text-info-text">{t('settings.categories.about')}</h3>
            <p className="text-sm text-info-text mt-1">
              {t('settings.categories.aboutText')}
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
};
