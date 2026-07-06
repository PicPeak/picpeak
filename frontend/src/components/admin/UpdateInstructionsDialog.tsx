import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  X,
  ExternalLink,
  Copy,
  Check,
  AlertTriangle,
  Server,
  Terminal,
  CheckCircle2,
  Circle
} from 'lucide-react';
import { api } from '../../config/api';

interface UpdateStep {
  description: string;
  command: string;
  note?: string;
  optional?: boolean;
}

interface PreCheck {
  id: string;
  text: string;
  required: boolean;
}

interface UpdateInstructions {
  environmentName: string;
  preChecks: PreCheck[];
  steps: UpdateStep[];
  postChecks: string[];
  warnings: string[];
}

interface Environment {
  type: 'docker' | 'git' | 'standalone';
  isDocker: boolean;
  isGit: boolean;
  hasDockerCompose: boolean;
  platform: string;
  nodeVersion: string;
  appVersion: string;
}

interface UpdateInstructionsResponse {
  enabled?: boolean;
  updateAvailable: boolean;
  currentVersion: string;
  targetVersion?: string;
  channel?: string;
  environment?: Environment;
  instructions?: UpdateInstructions;
  releaseNotesUrl?: string;
  message?: string;
}

async function fetchUpdateInstructions(): Promise<UpdateInstructionsResponse> {
  const response = await api.get<UpdateInstructionsResponse>('/admin/system/updates/instructions');
  return response.data;
}

interface UpdateInstructionsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  targetVersion?: string;
}

export const UpdateInstructionsDialog: React.FC<UpdateInstructionsDialogProps> = ({
  isOpen,
  onClose,
  targetVersion
}) => {
  const { t } = useTranslation();
  const [checkedItems, setCheckedItems] = useState<Set<string>>(new Set());
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['update-instructions'],
    queryFn: fetchUpdateInstructions,
    enabled: isOpen,
    staleTime: 5 * 60 * 1000 // 5 minutes
  });

  if (!isOpen) return null;

  const handleCheckItem = (id: string) => {
    const newChecked = new Set(checkedItems);
    if (newChecked.has(id)) {
      newChecked.delete(id);
    } else {
      newChecked.add(id);
    }
    setCheckedItems(newChecked);
  };

  const copyToClipboard = async (command: string, id: string) => {
    try {
      await navigator.clipboard.writeText(command);
      setCopiedCommand(id);
      setTimeout(() => setCopiedCommand(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const copyAllCommands = async () => {
    if (!data?.instructions?.steps) return;
    const allCommands = data.instructions.steps
      .filter(step => !step.command.startsWith('#'))
      .map(step => step.command)
      .join('\n');
    try {
      await navigator.clipboard.writeText(allCommands);
      setCopiedCommand('all');
      setTimeout(() => setCopiedCommand(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const requiredChecks = data?.instructions?.preChecks.filter(c => c.required) || [];
  const allRequiredChecked = requiredChecks.every(check => checkedItems.has(check.id));

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:block sm:p-0">
        {/* Backdrop */}
        <div
          className="fixed inset-0 transition-opacity bg-gray-500 bg-opacity-75 dark:bg-gray-900 dark:bg-opacity-75"
          onClick={onClose}
        />

        {/* Dialog */}
        <div className="inline-block w-full max-w-2xl my-8 overflow-hidden text-left align-middle transition-all transform bg-white dark:bg-gray-800 rounded-lg shadow-xl">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              {t('admin.updates.updateDialog.title', 'Update PicPeak')}
              {data?.targetVersion && (
                <span className="ml-2 text-blue-600 dark:text-blue-400">
                  v{data.targetVersion}
                </span>
              )}
            </h3>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-500 dark:hover:text-gray-300"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Content */}
          <div className="px-6 py-4 max-h-[70vh] overflow-y-auto">
            {isLoading && (
              <div className="flex items-center justify-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
              </div>
            )}

            {error && (
              <div className="flex items-center p-4 bg-red-50 dark:bg-red-900/30 rounded-lg">
                <AlertTriangle className="w-5 h-5 text-red-500 mr-3" />
                <p className="text-red-700 dark:text-red-300">
                  {t('admin.updates.updateDialog.error', 'Failed to load update instructions')}
                </p>
              </div>
            )}

            {data && !data.updateAvailable && (
              <div className="flex items-center p-4 bg-green-50 dark:bg-green-900/30 rounded-lg">
                <CheckCircle2 className="w-5 h-5 text-green-500 mr-3" />
                <p className="text-green-700 dark:text-green-300">
                  {t('admin.updates.upToDate', "You're up to date")} (v{data.currentVersion})
                </p>
              </div>
            )}

            {data?.instructions && (
              <div className="space-y-6">
                {/* Environment Info */}
                <div className="flex items-center p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg">
                  <Server className="w-5 h-5 text-gray-500 dark:text-gray-400 mr-3" />
                  <span className="text-sm text-gray-600 dark:text-gray-300">
                    {t('admin.updates.updateDialog.detectedEnv', 'Detected Environment')}:{' '}
                    <strong>{data.instructions.environmentName}</strong>
                  </span>
                </div>

                {/* Warnings */}
                {data.instructions.warnings.length > 0 && (
                  <div className="space-y-2">
                    {data.instructions.warnings.map((warning, idx) => (
                      <div key={idx} className="flex items-start p-3 bg-amber-50 dark:bg-amber-900/30 rounded-lg">
                        <AlertTriangle className="w-5 h-5 text-amber-500 mr-3 flex-shrink-0 mt-0.5" />
                        <p className="text-sm text-amber-700 dark:text-amber-300">{warning}</p>
                      </div>
                    ))}
                  </div>
                )}

                {/* Pre-flight Checklist */}
                <div>
                  <h4 className="text-sm font-semibold text-gray-900 dark:text-white mb-3 flex items-center">
                    <AlertTriangle className="w-4 h-4 text-amber-500 mr-2" />
                    {t('admin.updates.updateDialog.beforeUpdating', 'Before updating:')}
                  </h4>
                  <div className="space-y-2">
                    {data.instructions.preChecks.map((check) => (
                      <label
                        key={check.id}
                        className="flex items-center p-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={checkedItems.has(check.id)}
                          onChange={() => handleCheckItem(check.id)}
                          className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                        />
                        <span className="ml-3 text-sm text-gray-700 dark:text-gray-300">
                          {check.text}
                          {check.required && (
                            <span className="text-red-500 ml-1">*</span>
                          )}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>

                {/* Divider */}
                <hr className="border-gray-200 dark:border-gray-700" />

                {/* Update Commands */}
                <div>
                  <h4 className="text-sm font-semibold text-gray-900 dark:text-white mb-3 flex items-center">
                    <Terminal className="w-4 h-4 text-blue-500 mr-2" />
                    {t('admin.updates.updateDialog.updateCommands', 'Update Commands:')}
                  </h4>
                  <div className="space-y-4">
                    {data.instructions.steps.map((step, idx) => (
                      <div key={idx} className={`${step.optional ? 'opacity-75' : ''}`}>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm text-gray-600 dark:text-gray-400">
                            {idx + 1}. {step.description}
                            {step.optional && (
                              <span className="ml-2 text-xs text-gray-400">
                                ({t('common.optional', 'optional')})
                              </span>
                            )}
                          </span>
                        </div>
                        <div className="flex items-center bg-gray-900 dark:bg-gray-950 rounded-lg overflow-hidden">
                          <code className="flex-1 px-4 py-3 text-sm text-green-400 font-mono overflow-x-auto">
                            {step.command}
                          </code>
                          <button
                            onClick={() => copyToClipboard(step.command, `step-${idx}`)}
                            className="px-3 py-3 text-gray-400 hover:text-white border-l border-gray-700"
                            title={t('common.copy', 'Copy')}
                          >
                            {copiedCommand === `step-${idx}` ? (
                              <Check className="w-4 h-4 text-green-500" />
                            ) : (
                              <Copy className="w-4 h-4" />
                            )}
                          </button>
                        </div>
                        {step.note && (
                          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                            {step.note}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Divider */}
                <hr className="border-gray-200 dark:border-gray-700" />

                {/* Post-update Checks */}
                <div>
                  <h4 className="text-sm font-semibold text-gray-900 dark:text-white mb-3 flex items-center">
                    <CheckCircle2 className="w-4 h-4 text-green-500 mr-2" />
                    {t('admin.updates.updateDialog.afterUpdating', 'After updating:')}
                  </h4>
                  <ul className="space-y-2">
                    {data.instructions.postChecks.map((check, idx) => (
                      <li key={idx} className="flex items-center text-sm text-gray-600 dark:text-gray-400">
                        <Circle className="w-2 h-2 mr-3 flex-shrink-0" />
                        {check}
                      </li>
                    ))}
                  </ul>
                </div>

                {/* Release Notes Link */}
                {data.releaseNotesUrl && (
                  <a
                    href={data.releaseNotesUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center text-sm text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
                  >
                    <ExternalLink className="w-4 h-4 mr-2" />
                    {t('admin.updates.viewReleaseNotes', 'View Release Notes')}
                  </a>
                )}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between px-6 py-4 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
            <div className="text-xs text-gray-500 dark:text-gray-400">
              {!allRequiredChecked && data?.instructions && (
                <span className="text-amber-600 dark:text-amber-400">
                  {t('admin.updates.updateDialog.completeChecklist', 'Complete the checklist before updating')}
                </span>
              )}
            </div>
            <div className="flex items-center space-x-3">
              {data?.instructions && (
                <button
                  onClick={copyAllCommands}
                  className="inline-flex items-center px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-600"
                >
                  {copiedCommand === 'all' ? (
                    <>
                      <Check className="w-4 h-4 mr-2 text-green-500" />
                      {t('common.copied', 'Copied!')}
                    </>
                  ) : (
                    <>
                      <Copy className="w-4 h-4 mr-2" />
                      {t('admin.updates.updateDialog.copyAllCommands', 'Copy All Commands')}
                    </>
                  )}
                </button>
              )}
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700"
              >
                {t('common.close', 'Close')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
