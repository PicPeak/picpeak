/**
 * ProjectSelect — a gated project picker reused by the quote / contract /
 * hours / event editors to link a document to a Project Overview project.
 *
 * Renders nothing when the `projects` feature flag is off, so every call
 * site stays a one-liner that simply vanishes when the feature is disabled
 * (the maintainer's "book to project must not show unless projects is
 * enabled" requirement). Customers never see this — admin surfaces only.
 */
import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useFeatureFlags } from '../../contexts/FeatureFlagsContext';
import { projectsService } from '../../services/projects.service';

interface ProjectSelectProps {
  value: number | null;
  onChange: (projectId: number | null) => void;
  /** Optional label above the select. When omitted the select renders bare. */
  label?: string;
  /** Restrict the list to a single customer's projects when set. */
  customerAccountId?: number | null;
  disabled?: boolean;
  className?: string;
}

export const ProjectSelect: React.FC<ProjectSelectProps> = ({
  value,
  onChange,
  label,
  customerAccountId,
  disabled,
  className,
}) => {
  const { t } = useTranslation();
  const { flags } = useFeatureFlags();

  const { data: projects, isLoading } = useQuery({
    queryKey: ['projects', 'select'],
    queryFn: () => projectsService.list(),
    enabled: !!flags.projects,
    staleTime: 60_000,
  });

  // Hard gate: hidden entirely when the feature is off.
  if (!flags.projects) return null;

  const options = (projects || []).filter(
    (p) => customerAccountId == null || p.customerAccountId == null || p.customerAccountId === customerAccountId,
  );

  return (
    <div className={className}>
      {label && (
        <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
          {label}
        </label>
      )}
      <select
        value={value ?? ''}
        disabled={disabled || isLoading}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
        className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:opacity-60"
      >
        <option value="">{t('projects.picker.none', 'No project')}</option>
        {options.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </div>
  );
};
