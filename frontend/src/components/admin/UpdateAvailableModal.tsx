import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { X, ExternalLink, Copy, CheckCircle, ChevronDown, ChevronRight, ArrowUpCircle } from 'lucide-react';
import { toast } from 'react-toastify';
import { api } from '../../config/api';
import { Button, Card } from '../common';
import { MarkdownContent } from '../common/MarkdownContent';
import { githubReleaseUrl } from '../../utils/githubReleaseUrl';

/**
 * Update-available modal (#567).
 *
 * Opened from the sidebar "vX.Y.Z available" chip. Shows:
 *   - Aggregated release notes for every version between current and
 *     latest in the user's channel (one collapsible section each).
 *   - Copy-paste upgrade command tailored to the detected environment
 *     (Docker compose, native git, standalone).
 *   - "Dismiss this version" — writes to localStorage so the chip
 *     doesn't reappear until an even newer version is published.
 */

interface ReleaseEntry {
  version: string;
  tag: string;
  name: string;
  body: string;
  publishedAt: string | null;
  htmlUrl: string | null;
}

interface ChangelogResponse {
  enabled: boolean;
  current: string;
  channel: string;
  releases: ReleaseEntry[];
}

interface InstructionStep {
  description: string;
  command?: string;
  url?: string;
}

interface InstructionsResponse {
  updateAvailable: boolean;
  currentVersion: string;
  targetVersion?: string;
  environment?: { type: string; description?: string };
  instructions?: {
    title: string;
    description?: string;
    steps: InstructionStep[];
    notes?: string[];
  };
  releaseNotesUrl?: string;
}

interface UpdateAvailableModalProps {
  currentVersion: string;
  latestVersion: string;
  onClose: () => void;
  onDismiss: (version: string) => void;
}

const fetchChangelog = async (): Promise<ChangelogResponse> => {
  const { data } = await api.get<ChangelogResponse>('/admin/system/updates/changelog');
  return data;
};

const fetchInstructions = async (): Promise<InstructionsResponse> => {
  const { data } = await api.get<InstructionsResponse>('/admin/system/updates/instructions');
  return data;
};

const formatDate = (iso: string | null): string => {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
};

export const UpdateAvailableModal: React.FC<UpdateAvailableModalProps> = ({
  currentVersion,
  latestVersion,
  onClose,
  onDismiss,
}) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<Set<string>>(new Set([latestVersion]));
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const { data: changelog, isLoading: changelogLoading, isError: changelogError } = useQuery({
    queryKey: ['update-changelog'],
    queryFn: fetchChangelog,
    staleTime: 60 * 60 * 1000,
  });

  const { data: instructions, isLoading: instructionsLoading } = useQuery({
    queryKey: ['update-instructions'],
    queryFn: fetchInstructions,
    staleTime: 60 * 60 * 1000,
  });

  const toggle = (version: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(version)) next.delete(version);
      else next.add(version);
      return next;
    });
  };

  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((current) => (current === key ? null : current)), 2000);
    } catch {
      toast.error(t('admin.updates.copyFailed', 'Could not copy to clipboard'));
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <Card
        padding="none"
        className="w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-neutral-200 dark:border-neutral-700">
          <div className="flex items-start gap-3">
            <ArrowUpCircle className="w-6 h-6 text-blue-600 mt-0.5 flex-shrink-0" />
            <div>
              <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
                {t('admin.updates.modalTitle', 'Update available')}
              </h2>
              <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-0.5">
                {t('admin.updates.modalSubtitle', 'v{{current}} → v{{latest}}', {
                  current: currentVersion,
                  latest: latestVersion,
                })}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
            aria-label={t('common.close', 'Close')}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body — scrollable */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* Upgrade instructions */}
          <section>
            <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 mb-2">
              {t('admin.updates.howToUpgrade', 'How to upgrade')}
            </h3>
            {instructionsLoading && (
              <p className="text-sm text-neutral-500">{t('common.loading', 'Loading…')}</p>
            )}
            {!instructionsLoading && instructions?.instructions && (
              <div className="space-y-3">
                {instructions.environment?.description && (
                  <p className="text-xs text-neutral-500 dark:text-neutral-400">
                    {t('admin.updates.detectedEnv', 'Detected environment: {{env}}', {
                      env: instructions.environment.description,
                    })}
                  </p>
                )}
                {instructions.instructions.steps.map((step, idx) => {
                  const key = `step-${idx}`;
                  return (
                    <div key={key}>
                      <p className="text-sm text-neutral-700 dark:text-neutral-300 mb-1">
                        {idx + 1}. {step.description}
                      </p>
                      {step.command && (
                        <div className="relative">
                          <pre className="text-xs bg-neutral-900 text-neutral-100 rounded p-3 overflow-x-auto">
                            <code>{step.command}</code>
                          </pre>
                          <button
                            onClick={() => copy(step.command!, key)}
                            className="absolute top-2 right-2 p-1.5 rounded hover:bg-neutral-700/50 text-neutral-300"
                            aria-label={t('admin.updates.copyCommand', 'Copy command')}
                          >
                            {copiedKey === key
                              ? <CheckCircle className="w-4 h-4 text-green-400" />
                              : <Copy className="w-4 h-4" />}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
                {instructions.instructions.notes && instructions.instructions.notes.length > 0 && (
                  <ul className="text-xs text-neutral-500 dark:text-neutral-400 list-disc list-inside space-y-1">
                    {instructions.instructions.notes.map((note, idx) => (
                      <li key={idx}>{note}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>

          {/* Aggregated changelog */}
          <section>
            <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 mb-2">
              {t('admin.updates.releaseNotes', 'Release notes')}
            </h3>
            {changelogLoading && (
              <p className="text-sm text-neutral-500">{t('common.loading', 'Loading…')}</p>
            )}
            {changelogError && (
              <p className="text-sm text-red-600">
                {t('admin.updates.changelogError', 'Could not load release notes. Check the release pages directly on GitHub.')}
              </p>
            )}
            {changelog?.releases.length === 0 && !changelogLoading && (
              <p className="text-sm text-neutral-500">
                {t('admin.updates.noReleases', 'No release notes available.')}
              </p>
            )}
            {changelog && changelog.releases.length > 0 && (
              <div className="space-y-2">
                {changelog.releases.map((release) => {
                  const isOpen = expanded.has(release.version);
                  return (
                    <div
                      key={release.version}
                      className="border border-neutral-200 dark:border-neutral-700 rounded"
                    >
                      <button
                        onClick={() => toggle(release.version)}
                        className="w-full flex items-center justify-between p-3 hover:bg-neutral-50 dark:hover:bg-neutral-800"
                      >
                        <div className="flex items-center gap-2 text-left">
                          {isOpen
                            ? <ChevronDown className="w-4 h-4 text-neutral-500" />
                            : <ChevronRight className="w-4 h-4 text-neutral-500" />}
                          <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                            {release.name}
                          </span>
                          {release.publishedAt && (
                            <span className="text-xs text-neutral-500">
                              {formatDate(release.publishedAt)}
                            </span>
                          )}
                        </div>
                        <a
                          href={release.htmlUrl || githubReleaseUrl(release.version)}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="text-xs text-blue-600 hover:underline flex items-center gap-1"
                        >
                          {t('admin.updates.viewOnGitHub', 'View on GitHub')}
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      </button>
                      {isOpen && release.body && (
                        <div className="px-4 pb-4 pt-1 border-t border-neutral-100 dark:border-neutral-800">
                          <MarkdownContent
                            source={release.body}
                            className="text-sm prose prose-sm dark:prose-invert max-w-none"
                          />
                        </div>
                      )}
                      {isOpen && !release.body && (
                        <div className="px-4 pb-4 pt-1 text-sm text-neutral-500 italic">
                          {t('admin.updates.noNotes', 'No release notes provided.')}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 p-4 border-t border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900/50">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onDismiss(latestVersion);
              onClose();
            }}
          >
            {t('admin.updates.dismissUntilNext', 'Dismiss until next version')}
          </Button>
          <Button variant="primary" size="sm" onClick={onClose}>
            {t('common.close', 'Close')}
          </Button>
        </div>
      </Card>
    </div>
  );
};
