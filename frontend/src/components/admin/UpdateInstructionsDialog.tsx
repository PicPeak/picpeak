import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
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
import { Button, Modal, Notice } from '../common';
import { SelfUpdatePanel, ManualUpdateSteps, useSelfUpdateActive } from './SelfUpdatePanel';

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
  // Mounted closed on every admin page; only ask while it is open.
  const selfUpdateActive = useSelfUpdateActive(isOpen);

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
    <Modal
      open={isOpen}
      onClose={onClose}
      size="lg"
      title={
        <>
          {t('admin.updates.updateDialog.title', 'Update PicPeak')}
          {/* The server response is authoritative; the prop covers the
              window before the query resolves. */}
          {(data?.targetVersion || targetVersion) && (
            <span className="ml-2 text-info-text">
              v{data?.targetVersion || targetVersion}
            </span>
          )}
        </>
      }
      footer={
        <>
          <div className="mr-auto self-center text-xs text-muted">
            {!allRequiredChecked && data?.instructions && !selfUpdateActive && (
              <span className="text-warning-text">
                {t('admin.updates.updateDialog.completeChecklist', 'Complete the checklist before updating')}
              </span>
            )}
          </div>
          {data?.instructions && (
            <Button
              variant="outline"
              onClick={copyAllCommands}
              leftIcon={copiedCommand === 'all'
                ? <Check className="w-4 h-4 text-success" />
                : <Copy className="w-4 h-4" />}
            >
              {copiedCommand === 'all'
                ? t('common.copied', 'Copied!')
                : t('admin.updates.updateDialog.copyAllCommands', 'Copy All Commands')}
            </Button>
          )}
          <Button variant="primary" onClick={onClose}>
            {t('common.close', 'Close')}
          </Button>
        </>
      }
    >
      {/* Renders nothing unless in-app updates are enabled; the manual
          steps below stay as the fallback either way. */}
      <div className="mb-6 empty:hidden">
        <SelfUpdatePanel />
      </div>
      {isLoading && (
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-info"></div>
        </div>
      )}

      {error && (
        <Notice tone="danger">
          {t('admin.updates.updateDialog.error', 'Failed to load update instructions')}
        </Notice>
      )}

      {data && !data.updateAvailable && (
        <Notice tone="success">
          {t('admin.updates.upToDate', "You're up to date")} (v{data.currentVersion})
        </Notice>
      )}

      {data?.instructions && (
        <ManualUpdateSteps active={selfUpdateActive}>
        <div className="space-y-6">
          {/* Environment Info */}
          <Notice tone="neutral" icon={<Server className="w-5 h-5" />}>
            {t('admin.updates.updateDialog.detectedEnv', 'Detected Environment')}:{' '}
            <strong>{data.instructions.environmentName}</strong>
          </Notice>

          {/* Warnings */}
          {data.instructions.warnings.length > 0 && (
            <div className="space-y-2">
              {data.instructions.warnings.map((warning, idx) => (
                <Notice key={idx} tone="warning">{warning}</Notice>
              ))}
            </div>
          )}

          {/* Pre-flight Checklist */}
          <div>
            <h4 className="text-sm font-semibold text-heading mb-3 flex items-center">
              <AlertTriangle className="w-4 h-4 text-warning mr-2" />
              {t('admin.updates.updateDialog.beforeUpdating', 'Before updating:')}
            </h4>
            <div className="space-y-2">
              {data.instructions.preChecks.map((check) => (
                <label
                  key={check.id}
                  className="flex items-center p-2 rounded-lg hover:bg-hover cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={checkedItems.has(check.id)}
                    onChange={() => handleCheckItem(check.id)}
                    className="w-4 h-4 text-info-text border-line-strong rounded focus:ring-accent"
                  />
                  <span className="ml-3 text-sm text-body">
                    {check.text}
                    {check.required && (
                      <span className="text-danger ml-1">*</span>
                    )}
                  </span>
                </label>
              ))}
            </div>
          </div>

          {/* Divider */}
          <hr className="border-line" />

          {/* Update Commands */}
          <div>
            <h4 className="text-sm font-semibold text-heading mb-3 flex items-center">
              <Terminal className="w-4 h-4 text-info mr-2" />
              {t('admin.updates.updateDialog.updateCommands', 'Update Commands:')}
            </h4>
            <div className="space-y-4">
              {data.instructions.steps.map((step, idx) => (
                <div key={idx} className={`${step.optional ? 'opacity-75' : ''}`}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm text-soft">
                      {idx + 1}. {step.description}
                      {step.optional && (
                        <span className="ml-2 text-xs text-faint">
                          ({t('common.optional', 'optional')})
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="flex items-center bg-inset border border-line rounded-lg overflow-hidden">
                    <code className="flex-1 px-4 py-3 text-sm text-heading font-mono overflow-x-auto">
                      {step.command}
                    </code>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(step.command, `step-${idx}`)}
                      className="px-3 py-3 text-faint hover:text-body border-l border-line"
                      title={t('common.copy', 'Copy')}
                      aria-label={t('common.copy', 'Copy')}
                    >
                      {copiedCommand === `step-${idx}` ? (
                        <Check className="w-4 h-4 text-success" />
                      ) : (
                        <Copy className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                  {step.note && (
                    <p className="mt-1 text-xs text-muted">
                      {step.note}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Divider */}
          <hr className="border-line" />

          {/* Post-update Checks */}
          <div>
            <h4 className="text-sm font-semibold text-heading mb-3 flex items-center">
              <CheckCircle2 className="w-4 h-4 text-success mr-2" />
              {t('admin.updates.updateDialog.afterUpdating', 'After updating:')}
            </h4>
            <ul className="space-y-2">
              {data.instructions.postChecks.map((check, idx) => (
                <li key={idx} className="flex items-center text-sm text-soft">
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
              className="flex items-center text-sm text-accent"
            >
              <ExternalLink className="w-4 h-4 mr-2" />
              {t('admin.updates.viewReleaseNotes', 'View Release Notes')}
            </a>
          )}
        </div>
        </ManualUpdateSteps>
      )}
    </Modal>
  );
};
