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
import { Badge, Button, Card, EmptyState, ErrorState, Input, Loading, Table, TableHead, TableBody, TableRow, TableHeaderCell, TableCell } from '../../../components/common';
import { projectsService, type ProjectSummary } from '../../../services/projects.service';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';
import { formatMoneyMinor } from '../../../utils/money';
import { SectionPageHeader } from '../../../components/admin/SectionPageHeader';

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

  const { data: projects, isLoading, isError, isRefetching, refetch } = useQuery({
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
      <SectionPageHeader
        feature="projects"
        icon={FolderKanban}
        title={t('projects.title', 'Project Overview')}
        description={t('projects.subtitle', 'Group galleries into projects and see every email, document and hour in one cockpit.')}
      />

      {/* Inline create */}
      <Card className="mb-4">
        <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
          <div className="flex-1">
            <label className="block text-sm font-medium text-body mb-1">
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
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-faint" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('projects.search', 'Search by name or customer…') as string}
          className="pl-9"
        />
      </div>

      {isLoading ? (
        <Loading />
      ) : isError && !projects ? (
        <Card>
          <ErrorState
            size="inline"
            title={t('projects.loadFailed', 'Could not load the projects')}
            onRetry={() => refetch()}
            retrying={isRefetching}
          />
        </Card>
      ) : !projects || projects.length === 0 ? (
        <Card>
          <EmptyState
            size="inline"
            icon={<FolderKanban />}
            title={search
              ? t('projects.noMatches', 'No projects match this search')
              : t('projects.emptyTitle', 'No projects yet')}
            description={search ? undefined : t('projects.empty', 'Create one above, or galleries you already have were grouped automatically.')}
          />
        </Card>
      ) : (
        <Table>
          <TableHead>
            <tr>
              <TableHeaderCell>{t('projects.col.name', 'Project')}</TableHeaderCell>
              <TableHeaderCell>{t('projects.col.customer', 'Customer')}</TableHeaderCell>
              <TableHeaderCell align="right">{t('projects.col.events', 'Galleries')}</TableHeaderCell>
              <TableHeaderCell align="right">{t('projects.col.value', 'Value')}</TableHeaderCell>
              <TableHeaderCell>{t('projects.col.status', 'Status')}</TableHeaderCell>
              <TableHeaderCell>{t('projects.col.updated', 'Updated')}</TableHeaderCell>
            </tr>
          </TableHead>
          <TableBody>
            {projects.map((p: ProjectSummary) => (
              <TableRow
                key={p.id}
                interactive
                onClick={() => navigate(`/admin/clients/projects/${p.id}`)}
              >
                <TableCell className="font-medium text-heading">{p.name}</TableCell>
                <TableCell className="text-soft">{p.customerEmail || '—'}</TableCell>
                <TableCell align="right">{p.eventCount ?? 0}</TableCell>
                <TableCell align="right" className="font-medium text-heading">{formatValuation(p)}</TableCell>
                <TableCell>
                  <Badge>{t(`projects.status.${p.status}`, p.status)}</Badge>
                </TableCell>
                <TableCell className="text-muted">{p.updatedAt ? format(p.updatedAt) : '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
};
