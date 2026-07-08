import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { Save, RotateCcw, Code, AlertTriangle, Check } from 'lucide-react';
import { Button, Card, Loading } from '../common';
import { cssTemplatesService, CssTemplate } from '../../services/cssTemplates.service';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { useMutationWithToast } from '../../hooks';

export const CssTemplateEditor: React.FC = () => {
  const { t } = useTranslation();
  const { formatDateTime: fmtDateTime } = useLocalizedDate();
  const queryClient = useQueryClient();
  const [activeSlot, setActiveSlot] = useState(1);
  const [localTemplates, setLocalTemplates] = useState<CssTemplate[]>([]);
  const [hasChanges, setHasChanges] = useState(false);

  // Fetch templates
  const { data: templates, isLoading } = useQuery({
    queryKey: ['css-templates'],
    queryFn: () => cssTemplatesService.getTemplates()
  });

  // Update local state when templates load
  useEffect(() => {
    if (templates) {
      setLocalTemplates(templates);
      setHasChanges(false);
    }
  }, [templates]);

  // Save mutation
  const saveMutation = useMutation({
    mutationFn: async () => {
      const template = localTemplates.find(t => t.slot_number === activeSlot);
      if (!template) throw new Error('Template not found');

      return cssTemplatesService.updateTemplate(activeSlot, {
        name: template.name,
        css_content: template.css_content,
        is_enabled: template.is_enabled
      });
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['css-templates'] });
      setHasChanges(false);

      if (result.warnings.length > 0) {
        toast.warning(t('cssTemplates.sanitizationWarning', 'Some CSS patterns were blocked for security'));
      } else {
        toast.success(t('cssTemplates.saved', 'Template saved successfully'));
      }
    },
    onError: (error: Error) => {
      toast.error(error.message || t('cssTemplates.saveFailed', 'Failed to save template'));
    }
  });

  // Reset mutation
  const resetMutation = useMutationWithToast({
    mutationFn: () => cssTemplatesService.resetToDefault(),
    invalidateKeys: [['css-templates']],
    successMessage: t('cssTemplates.reset', 'Template reset to default'),
    errorMessage: (error: Error) => error.message || t('cssTemplates.resetFailed', 'Failed to reset template')
  });

  const activeTemplate = localTemplates.find(t => t.slot_number === activeSlot);

  const updateLocalTemplate = (updates: Partial<CssTemplate>) => {
    setLocalTemplates(prev =>
      prev.map(t =>
        t.slot_number === activeSlot ? { ...t, ...updates } : t
      )
    );
    setHasChanges(true);
  };

  const handleReset = () => {
    if (!confirm(t('cssTemplates.resetConfirm', 'Reset this template to the default? Your changes will be lost.'))) {
      return;
    }
    resetMutation.mutate();
  };

  if (isLoading) {
    return <Loading size="lg" text={t('common.loading', 'Loading...')} />;
  }

  return (
    <Card>
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 flex items-center gap-2">
            <Code className="w-5 h-5" />
            {t('cssTemplates.title', 'Custom CSS Templates')}
          </h2>
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-neutral-200 dark:border-neutral-700 mb-6">
          {[1, 2, 3].map(slot => {
            const template = localTemplates.find(t => t.slot_number === slot);
            return (
              <button
                key={slot}
                onClick={() => setActiveSlot(slot)}
                className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                  activeSlot === slot
                    ? 'border-accent text-accent'
                    : 'border-transparent text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 hover:border-neutral-300 dark:hover:border-neutral-600'
                }`}
              >
                {t('cssTemplates.template', 'Template')} {slot}
                {template && (
                  <span className="ml-2 text-neutral-400">
                    ({template.name})
                  </span>
                )}
                {template?.is_enabled && (
                  <Check className="w-3 h-3 inline ml-1 text-green-500" />
                )}
              </button>
            );
          })}
        </div>

        {activeTemplate && (
          <div className="space-y-6">
            {/* Template Name */}
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 dark:text-neutral-300 mb-2">
                {t('cssTemplates.templateName', 'Template Name')}
              </label>
              <input
                type="text"
                value={activeTemplate.name}
                onChange={(e) => updateLocalTemplate({ name: e.target.value })}
                maxLength={50}
                className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-primary-500 focus:border-accent-dark"
              />
            </div>

            {/* Enable Toggle */}
            <div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={activeTemplate.is_enabled}
                  onChange={(e) => updateLocalTemplate({ is_enabled: e.target.checked })}
                  className="rounded border-neutral-300 text-accent focus:ring-primary-500"
                />
                <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                  {t('cssTemplates.enableTemplate', 'Enable this template')}
                </span>
              </label>
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1 ml-6">
                {t('cssTemplates.enableHint', 'Enabled templates can be selected when creating events')}
              </p>
            </div>

            {/* CSS Editor */}
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 dark:text-neutral-300 mb-2">
                {t('cssTemplates.cssContent', 'CSS Content')}
              </label>
              <div className="relative">
                <textarea
                  value={activeTemplate.css_content}
                  onChange={(e) => updateLocalTemplate({ css_content: e.target.value })}
                  className="w-full h-96 px-4 py-3 font-mono text-sm border border-neutral-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-accent-dark bg-neutral-900 text-green-400"
                  spellCheck={false}
                  placeholder="/* Enter your custom CSS here */"
                />
                <div className="absolute bottom-3 right-3 text-xs text-neutral-400">
                  {(activeTemplate.css_content?.length || 0).toLocaleString()} / 102,400 {t('common.characters', 'characters')}
                </div>
              </div>
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-2">
                {t('cssTemplates.cssHint', 'Use .gallery-page to scope styles to the gallery. Available variables: --gallery-bg, --gallery-text, --gallery-accent')}
              </p>
            </div>

            {/* Security Notice */}
            <div className="flex items-start gap-2 p-3 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
              <div className="text-xs text-amber-800 dark:text-amber-200">
                <strong>{t('cssTemplates.securityNotice', 'Security Notice')}:</strong>{' '}
                {t('cssTemplates.securityText', 'CSS is sanitized to prevent malicious code. External URLs, @import, and JavaScript expressions are blocked.')}
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex items-center justify-between pt-4 border-t border-neutral-100 dark:border-neutral-700">
              <div className="flex items-center gap-3">
                {activeSlot === 1 && activeTemplate.is_default && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleReset}
                    disabled={resetMutation.isPending}
                    leftIcon={<RotateCcw className="w-4 h-4" />}
                  >
                    {t('cssTemplates.resetToDefault', 'Reset to Default')}
                  </Button>
                )}
              </div>

              <div className="flex items-center gap-3">
                {hasChanges && (
                  <span className="text-sm text-amber-600">
                    {t('cssTemplates.unsavedChanges', 'Unsaved changes')}
                  </span>
                )}
                <Button
                  variant="primary"
                  onClick={() => saveMutation.mutate()}
                  disabled={saveMutation.isPending || !hasChanges}
                  isLoading={saveMutation.isPending}
                  leftIcon={<Save className="w-4 h-4" />}
                >
                  {t('cssTemplates.saveTemplate', 'Save Template')}
                </Button>
              </div>
            </div>

            {/* Last Updated */}
            {activeTemplate.updated_at && (
              <p className="text-xs text-neutral-400 dark:text-neutral-500 text-right">
                {t('cssTemplates.lastUpdated', 'Last updated')}: {fmtDateTime(activeTemplate.updated_at)}
              </p>
            )}
          </div>
        )}
      </div>
    </Card>
  );
};

export default CssTemplateEditor;
