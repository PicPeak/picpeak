import React from 'react';
import { FileCode, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Card } from '../../common';
import type { EnabledTemplate } from '../../../services/cssTemplates.service';

interface CssTemplateCardProps {
  cssTemplates: EnabledTemplate[];
  cssTemplateId?: number | null;
  onCssTemplateChange: (templateId: number | null) => void;
}

export const CssTemplateCard: React.FC<CssTemplateCardProps> = ({
  cssTemplates,
  cssTemplateId,
  onCssTemplateChange
}) => {
  const { t } = useTranslation();

  return (
    <Card className="p-6">
      <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4 flex items-center gap-2">
        <FileCode className="w-5 h-5" />
        {t('branding.cssTemplate', 'CSS Template')}
      </h3>
      <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
        {t('branding.cssTemplateDescription', 'Select a pre-built CSS template to apply application-wide styling to this gallery. Templates can be managed in Settings > CSS Templates.')}
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {/* No template option */}
        <button
          type="button"
          onClick={() => onCssTemplateChange(null)}
          className={`relative p-4 rounded-lg border-2 transition-all text-left ${
            !cssTemplateId
              ? 'tile-selected'
              : 'border-neutral-200 dark:border-neutral-700 hover:border-neutral-300 dark:hover:border-neutral-600'
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="font-medium text-sm text-neutral-900 dark:text-neutral-100">{t('branding.noTemplate', 'No Template')}</span>
            {!cssTemplateId && (
              <Check className="w-4 h-4 text-accent-dark flex-shrink-0" />
            )}
          </div>
          <span className="text-xs text-neutral-600 dark:text-neutral-400 mt-1 block">
            {t('branding.noTemplateDescription', 'Use only theme settings without a CSS template')}
          </span>
        </button>
        {/* Template options */}
        {cssTemplates.map((template) => (
          <button
            type="button"
            key={template.id}
            onClick={() => onCssTemplateChange(template.id)}
            className={`relative p-4 rounded-lg border-2 transition-all text-left ${
              cssTemplateId === template.id
                ? 'tile-selected'
                : 'border-neutral-200 dark:border-neutral-700 hover:border-neutral-300 dark:hover:border-neutral-600'
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="font-medium text-sm text-neutral-900 dark:text-neutral-100">{template.name}</span>
              {cssTemplateId === template.id && (
                <Check className="w-4 h-4 text-accent-dark flex-shrink-0" />
              )}
            </div>
            <span className="text-xs text-neutral-600 dark:text-neutral-400 mt-1 block">
              {t('branding.templateSlot', 'Slot {{slot}}', { slot: template.slot_number })}
            </span>
          </button>
        ))}
      </div>
    </Card>
  );
};
