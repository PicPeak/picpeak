/**
 * Admin → Project Overview list page.
 *
 * Lists every project (the admin-only grouping layer above events) with a
 * search box, an inline "new project" creator, and a click-through to each
 * project's cockpit. Visual shape mirrors the other /admin/clients lists so
 * the CRM area feels like one product. Admin-only — customers never see it.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { Plus, Search, FolderKanban } from 'lucide-react';
import { Button, Card, Input, Loading } from '../../../components/common';
import { projectsService, type ProjectSummary } from '../../../services/projects.service';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';
import { formatMoneyMinor } from '../../../utils/money';

/** Render a project's rolled-up value (newest stage per deal, cumulative),
 *  one entry per currency. Convention (deliberately differs from the Events
 *  column): a zero *count* is a real number → "0"; a zero *value* means "nothing
 *  billed/quoted yet" → em dash, since "CHF 0.00" would wrongly imply a real
 *  zero-value deal. */
function formatValuation(p: ProjectSummary): string {
  const buckets = p.valuation?.byCurrency?.filter((b) => b.totalMinor !== 0) || [];
  if (buckets.length === 0) return '—';
  return buckets.map((b) => formatMoneyMinor(b.totalMinor, b.currency)).join(' · ');
}

export const ProjectsListPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { format } = useLocalizedDate();
  const [search, setSearch] = useState('');
  const [newName, setNewName] = useState('');

  const { data: projects, isLoading } = useQuery({
    queryKey: ['projects', { search }],
    queryFn: () => projectsService.list({ q: search || undefined }),
  });

  const createMutation = useMutation({
    mutationFn: () => projectsService.create({ name: newName.trim() }),
    onSuccess: (project) => {
      qc.invalidateQueries({ queryKey: ['projects'] });
      setNewName('');
      toast.success(t('projects.toast.created', 'Project created') as string);
      navigate(`/admin/clients/projects/${project.id}`);
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.error || err?.message || (t('projects.toast.createFailed', 'Could not create project') as string));
    },
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100 flex items-center gap-2">
            <FolderKanban className="w-6 h-6 text-neutral-500" />
            {t('projects.title', 'Project Overview')}
          </h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
            {t('projects.subtitle', 'Group events into projects and see every email, document, gallery and hour in one cockpit.')}
          </p>
        </div>
      </div>

      {/* Inline create */}
      <Card className="mb-4">
        <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
          <div className="flex-1">
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              {t('projects.create.label', 'New project name')}
            </label>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && newName.trim()) createMutation.mutate(); }}
              placeholder={t('projects.create.placeholder', 'e.g. Müller wedding 2026') as string}
            />
          </div>
          <Button
            variant="primary"
            disabled={!newName.trim() || createMutation.isPending}
            isLoading={createMutation.isPending}
            onClick={() => createMutation.mutate()}
          >
            <Plus className="w-4 h-4 mr-1" />{t('projects.create.button', 'Create project')}
          </Button>
        </div>
      </Card>

      {/* Search */}
      <div className="relative mb-3 max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-400" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('projects.search', 'Search by name or customer…') as string}
          className="pl-9"
        />
      </div>

      {isLoading ? (
        <Loading />
      ) : !projects || projects.length === 0 ? (
        <Card>
          <div className="text-center py-10 text-neutral-500 dark:text-neutral-400">
            {t('projects.empty', 'No projects yet. Create one above, or events you already have were grouped automatically.')}
          </div>
        </Card>
      ) : (
        <div className="rounded-lg border border-neutral-200 dark:border-neutral-700 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-neutral-50 dark:bg-neutral-800 text-left">
                <tr>
                  <th className="px-4 py-2 font-medium">{t('projects.col.name', 'Project')}</th>
                  <th className="px-4 py-2 font-medium">{t('projects.col.customer', 'Customer')}</th>
                  <th className="px-4 py-2 font-medium text-right">{t('projects.col.events', 'Events')}</th>
                  <th className="px-4 py-2 font-medium text-right">{t('projects.col.value', 'Value')}</th>
                  <th className="px-4 py-2 font-medium">{t('projects.col.status', 'Status')}</th>
                  <th className="px-4 py-2 font-medium">{t('projects.col.updated', 'Updated')}</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((p: ProjectSummary) => (
                  <tr
                    key={p.id}
                    onClick={() => navigate(`/admin/clients/projects/${p.id}`)}
                    className="border-t border-neutral-100 dark:border-neutral-800 hover:bg-neutral-50 dark:hover:bg-neutral-800/60 cursor-pointer"
                  >
                    <td className="px-4 py-2 font-medium text-neutral-900 dark:text-neutral-100">{p.name}</td>
                    <td className="px-4 py-2 text-neutral-600 dark:text-neutral-400">{p.customerEmail || '—'}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{p.eventCount ?? 0}</td>
                    <td className="px-4 py-2 text-right tabular-nums font-medium text-neutral-900 dark:text-neutral-100">{formatValuation(p)}</td>
                    <td className="px-4 py-2">
                      <span className="inline-block rounded-full px-2 py-0.5 text-xs bg-neutral-100 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-200">
                        {p.status}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-neutral-500 dark:text-neutral-400">{p.updatedAt ? format(p.updatedAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
