import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Download,
  Eye,
  Trash2,
  Search,
  Filter,
  CheckCircle,
  XCircle,
  Clock,
  AlertCircle,
  FileArchive,
  Database,
  Image,
  HardDrive,
  ChevronDown,
  ChevronUp,
  Calendar,
  RefreshCw,
  Loader2
} from 'lucide-react';
import { toast } from 'react-toastify';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Input, Loading } from '../common';
import { api } from '../../config/api';
// Per [[feedback_respect_general_format_settings]]: route every displayed
// date/time through useLocalizedDate so the admin's general_date_format +
// general_time_format settings apply uniformly. Previously the backup
// History pane used raw date-fns format() with hard-coded 'p' (12-hour
// AM/PM) and 'PPP' (US-locale long date), which ignored the settings —
// Ralf 2026-05-31 flagged "11:25 PM" on a 24h-configured install.
import { useLocalizedDate } from '../../hooks/useLocalizedDate';

const statusIcons = {
  completed: { icon: CheckCircle, color: 'text-green-500' },
  failed: { icon: XCircle, color: 'text-red-500' },
  running: { icon: Loader2, color: 'text-blue-500 animate-spin' },
  partial: { icon: AlertCircle, color: 'text-amber-500' }
};

const formatBytes = (bytes) => {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
};

export const BackupHistory = () => {
  const { t } = useTranslation();
  const [expandedRows, setExpandedRows] = useState(new Set());
  const [searchTerm, setSearchTerm] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');
  const [currentPage, setCurrentPage] = useState(1);
  const queryClient = useQueryClient();
  // Locale-aware formatters that respect admin's general_date_format +
  // general_time_format settings. See useLocalizedDate.ts for the full
  // contract; formatTime gives "HH:mm" (24h) or "h:mm a" (12h) based on
  // the setting, format(date) honors general_date_format, and
  // formatDistanceToNow returns "2 minutes ago" in the admin's i18n locale.
  const { format, formatTime, formatDistanceToNow } = useLocalizedDate();

  // Fetch backup history
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['backup-history', currentPage, searchTerm, filterStatus],
    queryFn: async () => {
      const params = new URLSearchParams({
        page: currentPage,
        limit: 20,
        ...(searchTerm && { search: searchTerm }),
        ...(filterStatus !== 'all' && { status: filterStatus })
      });
      const response = await api.get(`/admin/backup/status?${params}`);
      return response.data;
    }
  });

  // Delete backup mutation
  const deleteMutation = useMutation({
    mutationFn: async (backupId) => {
      const response = await api.delete(`/admin/backup/runs/${backupId}`);
      return response.data;
    },
    onSuccess: () => {
      toast.success('Backup deleted successfully');
      queryClient.invalidateQueries({ queryKey: ['backup-history'] });
    },
    onError: (error) => {
      toast.error(error.response?.data?.error || 'Failed to delete backup');
    }
  });

  const toggleRowExpansion = (id) => {
    const newExpanded = new Set(expandedRows);
    if (newExpanded.has(id)) {
      newExpanded.delete(id);
    } else {
      newExpanded.add(id);
    }
    setExpandedRows(newExpanded);
  };

  const handleDelete = (backup) => {
    if (window.confirm(`Are you sure you want to delete this backup from ${format(new Date(backup.created_at))}?`)) {
      deleteMutation.mutate(backup.id);
    }
  };

  if (isLoading) {
    return <Loading />;
  }

  const backups = data?.recentBackups || [];
  const pagination = data?.pagination || {};

  return (
    <div className="space-y-6">
      {/* Search and Filters */}
      <Card className="p-4">
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="flex-1">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-400" />
              <Input
                type="text"
                placeholder={t('backup.history.searchPlaceholder')}
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10"
              />
            </div>
          </div>
          
          <div className="flex gap-2">
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              className="px-3 py-2 border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded-md focus:outline-none focus:ring-primary focus:border-primary"
            >
              <option value="all">All Status</option>
              <option value="completed">Completed</option>
              <option value="failed">Failed</option>
              <option value="running">Running</option>
              <option value="partial">Partial</option>
            </select>
            
            <Button
              onClick={() => refetch()}
              variant="secondary"
              size="sm"
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </Card>

      {/* Backup History Table */}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-neutral-50 dark:bg-neutral-800 border-b border-neutral-200 dark:border-neutral-700">
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">
                  {t('backup.history.columns.status')}
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">
                  {t('backup.history.columns.dateTime')}
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">
                  {t('backup.history.columns.type')}
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">
                  {t('backup.history.columns.size')}
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">
                  {t('backup.history.columns.duration')}
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">
                  {t('backup.history.columns.actions')}
                </th>
              </tr>
            </thead>
            <tbody className="bg-white dark:bg-neutral-800 divide-y divide-neutral-200 dark:divide-neutral-700">
              {backups.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-neutral-500 dark:text-neutral-400">
                    <FileArchive className="h-12 w-12 mx-auto mb-3 text-neutral-300 dark:text-neutral-600" />
                    <p className="text-lg font-medium text-neutral-900 dark:text-neutral-100">No backups found</p>
                    <p className="text-sm mt-1">Backups will appear here once created</p>
                  </td>
                </tr>
              ) : (
                backups.map((backup) => {
                  const StatusIcon = statusIcons[backup.status]?.icon || AlertCircle;
                  const statusColor = statusIcons[backup.status]?.color || 'text-gray-500';
                  const isExpanded = expandedRows.has(backup.id);
                  const stats = backup.statistics || {};

                  return (
                    <React.Fragment key={backup.id}>
                      <tr className="hover:bg-neutral-50 dark:hover:bg-neutral-700/50">
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="flex items-center">
                            <StatusIcon className={`h-5 w-5 ${statusColor}`} />
                            <span className="ml-2 text-sm font-medium text-neutral-900 dark:text-neutral-100 capitalize">
                              {backup.status}
                            </span>
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div>
                            <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                              {format(new Date(backup.created_at))}
                            </p>
                            <p className="text-xs text-neutral-500 dark:text-neutral-400">
                              {formatTime(new Date(backup.created_at))} • {formatDistanceToNow(new Date(backup.created_at), { addSuffix: true })}
                            </p>
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-300 capitalize">
                            {backup.backup_type || 'Manual'}
                          </span>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <p className="text-sm text-neutral-900 dark:text-neutral-100">
                            {formatBytes(stats.total_size || 0)}
                          </p>
                          <p className="text-xs text-neutral-500 dark:text-neutral-400">
                            {stats.files_processed || 0} {t('backup.dashboard.stats.files')}
                          </p>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-neutral-900 dark:text-neutral-100">
                          {backup.duration_seconds
                            ? `${Math.round(backup.duration_seconds / 60)}m ${backup.duration_seconds % 60}s`
                            : '-'}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                          <div className="flex items-center justify-end space-x-2">
                            <button
                              onClick={() => toggleRowExpansion(backup.id)}
                              className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
                              title={t('backup.actions.view')}
                            >
                              {isExpanded ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
                            </button>
                            {backup.manifest_path && (
                              <button
                                onClick={() => window.open(`/api/admin/backup/download/${backup.id}`, '_blank')}
                                className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
                                title={t('backup.actions.download')}
                              >
                                <Download size={20} />
                              </button>
                            )}
                            <button
                              onClick={() => handleDelete(backup)}
                              className="text-neutral-400 hover:text-red-600"
                              title={t('backup.actions.delete')}
                              disabled={deleteMutation.isLoading}
                            >
                              <Trash2 size={20} />
                            </button>
                          </div>
                        </td>
                      </tr>
                      
                      {/* Expanded Details Row */}
                      {isExpanded && (
                        <tr>
                          <td colSpan={6} className="px-6 py-4 bg-neutral-50 dark:bg-neutral-700/50">
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                              {/* Backup Details */}
                              <div className="space-y-2">
                                <h4 className="font-medium text-neutral-900 dark:text-neutral-100">{t('backup.history.details.backupDetails')}</h4>
                                <div className="text-sm space-y-1">
                                  <div className="flex justify-between">
                                    <span className="text-neutral-500 dark:text-neutral-400">{t('backup.history.details.destination')}:</span>
                                    <span className="text-neutral-900 dark:text-neutral-100">{backup.destination_type || 'Unknown'}</span>
                                  </div>
                                  <div className="flex justify-between">
                                    <span className="text-neutral-500 dark:text-neutral-400">{t('backup.history.details.started')}:</span>
                                    <span className="text-neutral-900 dark:text-neutral-100">{formatTime(new Date(backup.created_at))}</span>
                                  </div>
                                  {backup.completed_at && (
                                    <div className="flex justify-between">
                                      <span className="text-neutral-500 dark:text-neutral-400">{t('backup.history.details.completed')}:</span>
                                      <span className="text-neutral-900 dark:text-neutral-100">{formatTime(new Date(backup.completed_at))}</span>
                                    </div>
                                  )}
                                </div>
                              </div>

                              {/* Content Backed Up
                                  Two render paths depending on what the backend
                                  provided:
                                    - NEW: per_path map { "events/active": {count, size}, ... }
                                      from Stage B's walker. One row per path,
                                      ordered by display_order.
                                    - LEGACY: fall back to Photos + Archives +
                                      "Other" bucket so the arithmetic still adds
                                      up when restoring a backup taken before this
                                      change shipped. */}
                              <div className="space-y-2">
                                <h4 className="font-medium text-neutral-900 dark:text-neutral-100">{t('backup.history.details.contentBackedUp')}</h4>
                                <div className="space-y-2">
                                  <div className="flex items-center space-x-2">
                                    <Database className={`h-4 w-4 ${stats.database_backed_up ? 'text-green-500' : 'text-neutral-300 dark:text-neutral-600'}`} />
                                    <span className="text-sm text-neutral-700 dark:text-neutral-300">{t('backup.configuration.whatToBackup.database')}</span>
                                  </div>
                                  {(() => {
                                    // Per-path breakdown when present
                                    const perPath = stats.per_path || stats.perPath;
                                    if (perPath && Object.keys(perPath).length > 0) {
                                      const formatSize = (bytes) => {
                                        if (!bytes) return '0 B';
                                        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
                                        const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
                                        return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
                                      };
                                      // Sort by path string so the order is stable across renders;
                                      // backend uses backup_paths.display_order to drive the walker
                                      // but doesn't carry order into per_path map — alphabetic is
                                      // fine for the display.
                                      const entries = Object.entries(perPath).sort(([a], [b]) => a.localeCompare(b));
                                      return (
                                        <>
                                          {entries.map(([pathKey, info]) => (
                                            <div key={pathKey} className="flex items-center space-x-2">
                                              <FileArchive className={`h-4 w-4 ${info.count > 0 ? 'text-green-500' : 'text-neutral-300 dark:text-neutral-600'}`} />
                                              <span className="text-sm text-neutral-700 dark:text-neutral-300 font-mono">
                                                {pathKey}
                                              </span>
                                              <span className="text-sm text-neutral-500 dark:text-neutral-400 ml-auto">
                                                {info.count} {info.size ? `(${formatSize(info.size)})` : ''}
                                              </span>
                                            </div>
                                          ))}
                                          <div className="flex items-center space-x-2 pt-1 border-t border-neutral-200 dark:border-neutral-700">
                                            <span className="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                                              {t('backup.history.details.totalFiles', 'Total files')}: {stats.files_processed || 0}
                                            </span>
                                          </div>
                                        </>
                                      );
                                    }

                                    // LEGACY rendering for backups taken before
                                    // per_path was emitted.
                                    const total = Number(stats.files_processed) || 0;
                                    const accounted =
                                      (Number(stats.photos_backed_up) || 0)
                                      + (Number(stats.archives_backed_up) || 0);
                                    const other = Math.max(total - accounted, 0);
                                    return (
                                      <>
                                        <div className="flex items-center space-x-2">
                                          <Image className={`h-4 w-4 ${stats.photos_backed_up > 0 ? 'text-green-500' : 'text-neutral-300 dark:text-neutral-600'}`} />
                                          <span className="text-sm text-neutral-700 dark:text-neutral-300">
                                            Photos ({stats.photos_backed_up || 0} of {stats.total_photos || 0})
                                          </span>
                                        </div>
                                        <div className="flex items-center space-x-2">
                                          <FileArchive className={`h-4 w-4 ${stats.archives_backed_up > 0 ? 'text-green-500' : 'text-neutral-300 dark:text-neutral-600'}`} />
                                          <span className="text-sm text-neutral-700 dark:text-neutral-300">
                                            Archives ({stats.archives_backed_up || 0})
                                          </span>
                                        </div>
                                        <div className="flex items-center space-x-2">
                                          <FileArchive className={`h-4 w-4 ${other > 0 ? 'text-green-500' : 'text-neutral-300 dark:text-neutral-600'}`} />
                                          <span className="text-sm text-neutral-700 dark:text-neutral-300">
                                            {t('backup.history.details.otherFiles', 'Business documents & other')} ({other})
                                          </span>
                                        </div>
                                        <div className="flex items-center space-x-2 pt-1 border-t border-neutral-200 dark:border-neutral-700">
                                          <span className="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                                            {t('backup.history.details.totalFiles', 'Total files')}: {total}
                                          </span>
                                        </div>
                                      </>
                                    );
                                  })()}
                                </div>
                              </div>

                              {/* Error Information */}
                              {backup.error_message && (
                                <div className="space-y-2">
                                  <h4 className="font-medium text-red-900 dark:text-red-200">{t('backup.history.details.errorDetails')}</h4>
                                  <p className="text-sm text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-900/30 p-2 rounded">
                                    {backup.error_message}
                                  </p>
                                </div>
                              )}

                              {/* Manifest Path */}
                              {backup.manifest_path && (
                                <div className="space-y-2">
                                  <h4 className="font-medium text-neutral-900 dark:text-neutral-100">{t('backup.history.details.manifest')}</h4>
                                  <p className="text-sm text-neutral-600 dark:text-neutral-400 font-mono break-all">
                                    {backup.manifest_path}
                                  </p>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {pagination.pages > 1 && (
          <div className="bg-white dark:bg-neutral-800 px-4 py-3 border-t border-neutral-200 dark:border-neutral-700 sm:px-6">
            <div className="flex items-center justify-between">
              <div className="flex-1 flex justify-between sm:hidden">
                <Button
                  onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  variant="secondary"
                  size="sm"
                >
                  {t('backup.history.pagination.previous')}
                </Button>
                <Button
                  onClick={() => setCurrentPage(p => Math.min(pagination.pages, p + 1))}
                  disabled={currentPage === pagination.pages}
                  variant="secondary"
                  size="sm"
                >
                  {t('backup.history.pagination.next')}
                </Button>
              </div>
              <div className="hidden sm:flex-1 sm:flex sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm text-neutral-700 dark:text-neutral-300">
                    {t('backup.history.pagination.showing', {
                      from: (currentPage - 1) * pagination.limit + 1,
                      to: Math.min(currentPage * pagination.limit, pagination.total),
                      total: pagination.total
                    })}
                  </p>
                </div>
                <div>
                  <nav className="relative z-0 inline-flex rounded-md shadow-sm -space-x-px">
                    <button
                      onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                      disabled={currentPage === 1}
                      className="relative inline-flex items-center px-2 py-2 rounded-l-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm font-medium text-neutral-500 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {t('backup.history.pagination.previous')}
                    </button>

                    {[...Array(Math.min(5, pagination.pages))].map((_, i) => {
                      const pageNum = i + 1;
                      return (
                        <button
                          key={pageNum}
                          onClick={() => setCurrentPage(pageNum)}
                          className={`relative inline-flex items-center px-4 py-2 border text-sm font-medium ${
                            currentPage === pageNum
                              ? 'z-10 bg-accent-dark/15 border-primary text-primary'
                              : 'bg-white dark:bg-neutral-800 border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-700'
                          }`}
                        >
                          {pageNum}
                        </button>
                      );
                    })}

                    <button
                      onClick={() => setCurrentPage(p => Math.min(pagination.pages, p + 1))}
                      disabled={currentPage === pagination.pages}
                      className="relative inline-flex items-center px-2 py-2 rounded-r-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm font-medium text-neutral-500 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {t('backup.history.pagination.next')}
                    </button>
                  </nav>
                </div>
              </div>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
};