import React, { useState } from 'react';
import { 
  Archive, 
  Download, 
  Search, 
  Calendar,
  HardDrive,
  FileArchive,
  AlertCircle,
  RotateCcw,
  Trash2,
  ChevronLeft,
  ChevronRight
} from 'lucide-react';
import { format, parseISO, isValid } from 'date-fns';
import { toast } from 'react-toastify';

import { Button, Input, Card, Loading } from '../../components/common';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { archiveService } from '../../services/archive.service';
import { useTranslation } from 'react-i18next';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
// import { useNavigate } from 'react-router-dom';

export const ArchivesPage: React.FC = () => {
  const { t } = useTranslation();
  const { formatTime: fmtTime } = useLocalizedDate();
  const [searchTerm, setSearchTerm] = useState('');
  const [filterType, setFilterType] = useState<string>('all');
  const [sortBy, setSortBy] = useState<'date' | 'size' | 'name'>('date');
  const [currentPage, setCurrentPage] = useState(1);
  // const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Helper function to safely format dates
  const formatDate = (dateString: string | null | undefined, formatStr: string): string => {
    if (!dateString) return '';
    try {
      const date = parseISO(dateString);
      return isValid(date) ? format(date, formatStr) : '';
    } catch {
      return '';
    }
  };

  // Fetch archives from API
  const { data: archivesData, isLoading } = useQuery({
    queryKey: ['admin-archives', currentPage],
    queryFn: () => archiveService.getArchives(currentPage, 20),
  });

  const archives = archivesData?.archives || [];

  const filteredArchives = archives.filter(archive => {
    if (filterType !== 'all' && archive.eventType !== filterType) {
      return false;
    }
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      return archive.eventName.toLowerCase().includes(term);
    }
    return true;
  }).sort((a, b) => {
    switch (sortBy) {
      case 'name':
        return a.eventName.localeCompare(b.eventName);
      case 'size':
        return b.archiveSize - a.archiveSize;
      case 'date':
      default:
        const dateA = a.archivedAt ? new Date(a.archivedAt).getTime() : 0;
        const dateB = b.archivedAt ? new Date(b.archivedAt).getTime() : 0;
        return dateB - dateA;
    }
  });

  const getTotalSize = () => {
    return archives.reduce((sum, archive) => sum + archive.archiveSize, 0);
  };

  // Mutations
  const restoreMutation = useMutation({
    mutationFn: (id: number) => archiveService.restoreArchive(id),
    onSuccess: () => {
      toast.success(t('archives.restoreSuccess'));
      queryClient.invalidateQueries({ queryKey: ['admin-archives'] });
    },
    onError: () => {
      toast.error(t('errors.somethingWentWrong'));
    }
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => archiveService.deleteArchive(id),
    onSuccess: () => {
      toast.success(t('archives.deleteSuccess'));
      queryClient.invalidateQueries({ queryKey: ['admin-archives'] });
    },
    onError: () => {
      toast.error(t('errors.somethingWentWrong'));
    }
  });

  const handleDownload = async (archive: typeof archives[0]) => {
    try {
      toast.info(t('gallery.downloading', { count: 1 }).replace('photo', 'archive'));
      await archiveService.downloadArchive(archive.id, `${archive.slug}-archive.zip`);
      toast.success(t('common.download'));
    } catch (error) {
      toast.error(t('errors.somethingWentWrong'));
    }
  };

  const handleRestore = (archive: typeof archives[0]) => {
    if (confirm(t('archives.confirmRestore').replace('{{name}}', archive.eventName))) {
      restoreMutation.mutate(archive.id);
    }
  };

  const handleDelete = (archive: typeof archives[0]) => {
    if (confirm(t('archives.confirmDelete').replace('{{name}}', archive.eventName))) {
      deleteMutation.mutate(archive.id);
    }
  };

  // Details view not implemented yet
  // const handleViewDetails = (archive: typeof archives[0]) => {
  //   navigate(`/admin/archives/${archive.id}`);
  // };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loading size="lg" text={t('archives.loadingArchives')} />
      </div>
    );
  }

  return (
    <div>
      {/* Page Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">{t('archives.title')}</h1>
        <p className="text-neutral-600 dark:text-neutral-400 mt-1">{t('archives.subtitle')}</p>
      </div>

      {/* Statistics Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <Card padding="sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-neutral-600 dark:text-neutral-400">{t('archives.totalArchives')}</p>
              <p className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">{archives.length}</p>
            </div>
            <Archive className="w-8 h-8 text-accent" />
          </div>
        </Card>

        <Card padding="sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-neutral-600 dark:text-neutral-400">{t('archives.storageUsed')}</p>
              <p className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">{archiveService.formatBytes(getTotalSize())}</p>
            </div>
            <HardDrive className="w-8 h-8 text-blue-600" />
          </div>
        </Card>

        <Card padding="sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-neutral-600 dark:text-neutral-400">{t('archives.totalPhotos')}</p>
              <p className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
                {(() => {
                  const total = archives.reduce((sum, a) => sum + (parseInt(String(a.photoCount)) || 0), 0);
                  return total === 0 ? '0' : total.toLocaleString();
                })()}
              </p>
            </div>
            <FileArchive className="w-8 h-8 text-green-600" />
          </div>
        </Card>

        <Card padding="sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-neutral-600 dark:text-neutral-400">{t('archives.avgArchiveSize')}</p>
              <p className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
                {archives.length > 0
                  ? archiveService.formatBytes(getTotalSize() / archives.length)
                  : '0 Bytes'
                }
              </p>
            </div>
            <Calendar className="w-8 h-8 text-purple-600" />
          </div>
        </Card>
      </div>

      {/* Filters and Search */}
      <Card padding="sm" className="mb-6">
        <div className="flex flex-col lg:flex-row gap-4">
          <div className="flex-1">
            <Input
              type="text"
              placeholder={t('archives.searchPlaceholder')}
              leftIcon={<Search className="w-5 h-5 text-neutral-400" />}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          
          <div className="flex gap-2">
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
              className="px-4 py-2 border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-accent-dark"
            >
              <option value="all">{t('archives.allTypes')}</option>
              <option value="wedding">{t('archives.wedding')}</option>
              <option value="birthday">{t('archives.birthday')}</option>
              <option value="corporate">{t('archives.corporate')}</option>
              <option value="party">Party</option>
              <option value="other">{t('archives.other')}</option>
            </select>

            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as any)}
              className="px-4 py-2 border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-accent-dark"
            >
              <option value="date">{t('archives.sortByDate')}</option>
              <option value="name">{t('archives.sortByName')}</option>
              <option value="size">{t('archives.sortBySize')}</option>
            </select>
          </div>
        </div>
      </Card>

      {/* Archives Table */}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-neutral-50 dark:bg-neutral-800 border-b border-neutral-200 dark:border-neutral-700">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">
                  {t('archives.tableHeaders.event')}
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">
                  {t('archives.tableHeaders.type')}
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">
                  {t('archives.tableHeaders.archivedDate')}
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">
                  {t('archives.tableHeaders.size')}
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">
                  {t('archives.tableHeaders.photos')}
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">
                  {t('archives.tableHeaders.actions')}
                </th>
              </tr>
            </thead>
            <tbody className="bg-white dark:bg-neutral-800 divide-y divide-neutral-200 dark:divide-neutral-700">
              {filteredArchives.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-neutral-500 dark:text-neutral-400">
                    {t('archives.noArchivesFound')}
                  </td>
                </tr>
              ) : (
                filteredArchives.map((archive) => (
                  <tr key={archive.id} className="hover:bg-neutral-50 dark:hover:bg-neutral-700/50">
                    <td className="px-6 py-4">
                      <div>
                        <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{archive.eventName}</p>
                        <p className="text-xs text-neutral-500 dark:text-neutral-400">
                          {t('archives.eventDateNA').replace('N/A', formatDate(archive.eventDate, 'MMM d, yyyy') || 'N/A')}
                        </p>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-sm text-neutral-700 dark:text-neutral-300 capitalize">
                      {archive.eventType}
                    </td>
                    <td className="px-6 py-4 text-sm text-neutral-700 dark:text-neutral-300">
                      <div>
                        <p>{formatDate(archive.archivedAt, 'MMM d, yyyy') || t('archives.processing')}</p>
                        <p className="text-xs text-neutral-500 dark:text-neutral-400">
                          {archive.archivedAt ? fmtTime(archive.archivedAt) : ''}
                        </p>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-sm text-neutral-700 dark:text-neutral-300">
                      {archiveService.formatBytes(archive.archiveSize)}
                    </td>
                    <td className="px-6 py-4 text-sm text-neutral-700 dark:text-neutral-300">
                      {archive.photoCount}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {/* Details view not implemented yet
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleViewDetails(archive)}
                          leftIcon={<Eye className="w-4 h-4" />}
                        >
                          Details
                        </Button>
                        */}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDownload(archive)}
                          leftIcon={<Download className="w-4 h-4" />}
                          disabled={!archive.archivePath}
                        >
                          {t('archives.download')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRestore(archive)}
                          leftIcon={<RotateCcw className="w-4 h-4" />}
                          disabled={restoreMutation.isPending}
                        >
                          {t('archives.restore')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDelete(archive)}
                          leftIcon={<Trash2 className="w-4 h-4" />}
                          className="text-red-600 hover:text-red-700"
                          disabled={deleteMutation.isPending}
                        >
                          {t('archives.delete')}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Pagination */}
      {archivesData?.pagination && archivesData.pagination.totalPages > 1 && (
        <div className="mt-6 flex items-center justify-between">
          <div className="text-sm text-neutral-600">
            {t('archives.showing', { 
              from: ((currentPage - 1) * archivesData.pagination.limit) + 1,
              to: Math.min(currentPage * archivesData.pagination.limit, archivesData.pagination.total),
              total: archivesData.pagination.total
            })}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
              disabled={currentPage === 1}
              leftIcon={<ChevronLeft className="w-4 h-4" />}
            >
              {t('common.previous')}
            </Button>
            <span className="px-3 text-sm">
              {t('archives.page', { current: currentPage, total: archivesData.pagination.totalPages })}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage(prev => Math.min(archivesData.pagination.totalPages, prev + 1))}
              disabled={currentPage === archivesData.pagination.totalPages}
              rightIcon={<ChevronRight className="w-4 h-4" />}
            >
              {t('common.next')}
            </Button>
          </div>
        </div>
      )}

      {/* Storage Warning */}
      <div className="mt-6 p-4 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-lg">
        <div className="flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-amber-900 dark:text-amber-200">{t('archives.storageManagement')}</p>
            <p className="text-sm text-amber-700 dark:text-amber-300 mt-1">
              {t('archives.storageInfo')}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};