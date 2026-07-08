import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Plus,
  Search,
  Archive,
  AlertTriangle,
  MoreVertical,
  ExternalLink,
  Edit,
  Download,
  Trash2,
  Calendar,
  Image,
  Activity,
  Copy,
  CheckCircle,
  ChevronLeft,
  ChevronRight
} from 'lucide-react';
import { parseISO, differenceInDays } from 'date-fns';
import { toast } from 'react-toastify';
import { useModal, useMutationWithToast } from '../../hooks';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';

import { Button, Input, Card, SkeletonTable, ErrorBoundary } from '../../components/common';
import { BulkArchiveModal, BulkDeleteModal } from '../../components/admin';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { eventsService, type EventStatusFilter } from '../../services/events.service';
import { adminService } from '../../services/admin.service';
import { isGalleryPublic } from '../../utils/accessControl';
import { buildShareLinkUrl } from '../../utils/url';
import type { Event } from '../../types';
import { useTranslation } from 'react-i18next';

const PAGE_SIZE = 20;

export const EventsListPage: React.FC = () => {
  const { t } = useTranslation();
  const { format } = useLocalizedDate();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedEvents, setSelectedEvents] = useState<number[]>([]);
  // const [showFilters, setShowFilters] = useState(false);
  const [activeDropdown, setActiveDropdown] = useState<number | null>(null);
  const [dropdownPosition, setDropdownPosition] = useState<{ top: number; left: number } | null>(null);
  const bulkArchiveModal = useModal();
  const bulkDeleteModal = useModal();
  const [copiedEventId, setCopiedEventId] = useState<number | null>(null);

  const copyShareLink = async (event: Event) => {
    const url = buildShareLinkUrl(event.share_link);
    if (!url || url === '#') {
      toast.error(t('errors.noShareLink', 'No share link available'));
      return;
    }
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(url);
      } else {
        const textArea = document.createElement('textarea');
        textArea.value = url;
        textArea.style.position = 'fixed';
        textArea.style.left = '-999999px';
        document.body.appendChild(textArea);
        textArea.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(textArea);
        if (!ok) throw new Error('Copy failed');
      }
      setCopiedEventId(event.id);
      toast.success(t('events.linkCopied', 'Gallery link copied'));
      setTimeout(() => setCopiedEventId((current) => (current === event.id ? null : current)), 2000);
    } catch {
      toast.error(t('errors.copyFailed', 'Failed to copy link'));
    }
  };

  // Get filter from URL — backend supports all of these as `status` values
  const filterParam = searchParams.get('filter');
  const statusFilter: EventStatusFilter | undefined =
    filterParam === 'active' || filterParam === 'archived' ||
    filterParam === 'draft' || filterParam === 'expiring' ||
    filterParam === 'inactive'
      ? filterParam
      : undefined;
  const isExpiringFilter = filterParam === 'expiring';
  const isDraftFilter = filterParam === 'draft';

  // Server-side pagination + debounced search
  const [page, setPage] = useState(1);
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearchTerm(searchTerm.trim()), 300);
    return () => clearTimeout(t);
  }, [searchTerm]);

  // Reset to page 1 whenever the filter or search changes so users don't
  // get stuck on a page index that no longer exists in the new result set.
  useEffect(() => {
    setPage(1);
  }, [statusFilter, debouncedSearchTerm]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest('.dropdown-container')) {
        setActiveDropdown(null);
        setDropdownPosition(null);
      }
    };

    if (activeDropdown !== null) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [activeDropdown]);

  // Update dropdown position on scroll/resize
  useEffect(() => {
    const handleScrollOrResize = () => {
      if (activeDropdown !== null) {
        setActiveDropdown(null);
        setDropdownPosition(null);
      }
    };

    window.addEventListener('scroll', handleScrollOrResize, true);
    window.addEventListener('resize', handleScrollOrResize);
    
    return () => {
      window.removeEventListener('scroll', handleScrollOrResize, true);
      window.removeEventListener('resize', handleScrollOrResize);
    };
  }, [activeDropdown]);

  // Fetch events — fully server-side: pagination, status filter, and search
  // (#346 — counters and search were previously bounded to the first 100 rows).
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-events', statusFilter ?? 'all', debouncedSearchTerm, page],
    queryFn: () => eventsService.getEvents(page, PAGE_SIZE, statusFilter, debouncedSearchTerm || undefined),
    placeholderData: (prev) => prev,
  });

  // Clamp the active page when the result count shrinks (#442 — bulk
  // delete of an entire page would leave the user on a now-empty
  // page=N where N > totalPages, with no auto-correction). Triggers
  // after each successful refetch when totalPages drops below the
  // current page (bulk delete, individual delete, archive, anything).
  // Must live AFTER the useQuery above so `data` is in scope — the
  // original placement at the top of the component caused a TDZ
  // ReferenceError on /admin/events that crashed the page (#454).
  useEffect(() => {
    if (data?.pagination && page > data.pagination.totalPages) {
      setPage(Math.max(1, data.pagination.totalPages));
    }
  }, [data?.pagination, page]);

  // Aggregate counters come from the dashboard stats endpoint so the cards
  // and the "All (N)" filter button always reflect global totals, not the
  // currently visible page.
  const { data: dashboardStats } = useQuery({
    queryKey: ['admin-dashboard-stats'],
    queryFn: () => adminService.getDashboardStats(),
  });

  // Archive mutation
  const archiveMutation = useMutationWithToast({
    mutationFn: eventsService.archiveEvent,
    invalidateKeys: [['admin-events'], ['admin-dashboard-stats']],
    successMessage: t('toast.eventArchived'),
    errorMessage: () => t('toast.saveError'),
  });

  // Delete mutation
  const deleteMutation = useMutationWithToast({
    mutationFn: eventsService.deleteEvent,
    invalidateKeys: [['admin-events'], ['admin-dashboard-stats']],
    successMessage: t('toast.deleteSuccess'),
    errorMessage: () => t('toast.deleteError'),
  });

  // Bulk archive mutation
  const bulkArchiveMutation = useMutation({
    mutationFn: eventsService.bulkArchiveEvents,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['admin-events'] });
      queryClient.invalidateQueries({ queryKey: ['admin-dashboard-stats'] });
      setSelectedEvents([]);
      bulkArchiveModal.close();

      if (data.results.failed.length === 0) {
        toast.success(t('events.bulkArchiveSuccess', { count: data.results.successful.length }));
      } else {
        toast.warning(t('events.bulkArchivePartial', { success: data.results.successful.length, failed: data.results.failed.length }));
      }
    },
    onError: () => {
      toast.error(t('toast.saveError'));
    },
  });

  // Bulk delete mutation. Confirmation is handled client-side by the modal's
  // typed-DELETE gate (#417); server still enforces auth + permission.
  const bulkDeleteMutation = useMutation({
    mutationFn: (eventIds: number[]) => eventsService.bulkDeleteEvents(eventIds),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['admin-events'] });
      queryClient.invalidateQueries({ queryKey: ['admin-dashboard-stats'] });
      setSelectedEvents([]);
      bulkDeleteModal.close();

      if (data.results.failed.length === 0) {
        toast.success(t('events.bulkDelete.successAll', { count: data.results.successful.length }));
      } else {
        toast.warning(t('events.bulkDelete.successPartial', { success: data.results.successful.length, failed: data.results.failed.length }));
      }
    },
    onError: () => {
      toast.error(t('events.bulkDelete.errorGeneric'));
      bulkDeleteModal.close();
    },
  });

  // Filtering and searching now happen server-side. Use the response directly,
  // ordered as the backend returned them (created_at desc by default).
  const events: Event[] = data?.events ?? [];
  const pagination = data?.pagination;
  const totalPages = pagination?.totalPages ?? 1;
  const filteredCount = pagination?.total ?? 0;
  const isFilteringOrSearching = !!statusFilter || !!debouncedSearchTerm;

  const handleSelectAll = () => {
    if (selectedEvents.length === events.length) {
      setSelectedEvents([]);
    } else {
      setSelectedEvents(events.map(e => e.id));
    }
  };

  const handleSelectEvent = (id: number) => {
    setSelectedEvents(prev => 
      prev.includes(id) 
        ? prev.filter(i => i !== id)
        : [...prev, id]
    );
  };

  const getEventStatus = (event: Event) => {
    if (event.is_draft) return { label: t('events.draft'), color: 'text-yellow-600 dark:text-yellow-400 bg-yellow-100 dark:bg-yellow-900/40' };
    if (event.is_archived) return { label: t('events.archived'), color: 'text-neutral-500 dark:text-neutral-400 bg-neutral-100 dark:bg-neutral-700' };
    if (!event.is_active) return { label: t('events.inactive'), color: 'text-red-600 dark:text-red-400 bg-red-100 dark:bg-red-900/40' };

    if (!event.expires_at) return { label: t('events.active'), color: 'text-green-600 dark:text-green-400 bg-green-100 dark:bg-green-900/40' };

    const days = differenceInDays(parseISO(event.expires_at), new Date());
    if (days <= 0) return { label: t('events.expired'), color: 'text-red-600 dark:text-red-400 bg-red-100 dark:bg-red-900/40' };
    if (days <= 7) return { label: t('events.daysLeft', { count: days }), color: 'text-orange-600 dark:text-orange-400 bg-orange-100 dark:bg-orange-900/40' };

    return { label: t('events.active'), color: 'text-green-600 dark:text-green-400 bg-green-100 dark:bg-green-900/40' };
  };

  if (isLoading) {
    return (
      <div>
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">{t('events.title')}</h1>
            <p className="text-neutral-600 dark:text-neutral-400 mt-1">{t('events.subtitle')}</p>
          </div>
        </div>
        <SkeletonTable rows={5} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-12">
        <p className="text-red-600">{t('events.failedToLoadEvents')}</p>
        <Button onClick={() => window.location.reload()} className="mt-4">
          {t('events.tryAgain')}
        </Button>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <div>
        {/* Page Header */}
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">{t('events.title')}</h1>
            <p className="text-neutral-600 dark:text-neutral-400 mt-1">{t('events.subtitle')}</p>
          </div>
          <Button
            variant="primary"
            leftIcon={<Plus className="w-5 h-5" />}
            onClick={() => navigate('/admin/events/new')}
          >
            {t('events.createEvent')}
          </Button>
        </div>

      {/* Statistics Cards — fed from /admin/dashboard/stats so the totals
          stay accurate regardless of the visible page (#346). */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <Card padding="sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-neutral-600 dark:text-neutral-400">{t('events.stats.totalEvents')}</p>
              <p className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">{dashboardStats?.totalEvents ?? 0}</p>
            </div>
            <Calendar className="w-8 h-8 text-accent" />
          </div>
        </Card>

        <Card padding="sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-neutral-600 dark:text-neutral-400">{t('events.stats.activeEvents')}</p>
              <p className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
                {dashboardStats?.activeEvents ?? 0}
              </p>
            </div>
            <Activity className="w-8 h-8 text-green-600" />
          </div>
        </Card>

        <Card padding="sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-neutral-600 dark:text-neutral-400">{t('events.stats.totalPhotos')}</p>
              <p className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
                {dashboardStats?.totalPhotos ?? 0}
              </p>
            </div>
            <Image className="w-8 h-8 text-blue-600" />
          </div>
        </Card>

        <Card padding="sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-neutral-600 dark:text-neutral-400">{t('events.stats.expiringEvents')}</p>
              <p className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
                {dashboardStats?.expiringEvents ?? 0}
              </p>
            </div>
            <AlertTriangle className="w-8 h-8 text-orange-600" />
          </div>
        </Card>
      </div>

      {/* Filters and Search */}
      <Card padding="sm" className="mb-6">
        <div className="flex flex-col lg:flex-row gap-4">
          {/* Search */}
          <div className="flex-1">
            <Input
              type="text"
              placeholder={t('events.searchEventsPlaceholder')}
              leftIcon={<Search className="w-5 h-5 text-neutral-400" />}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>

          {/* Filter Buttons */}
          <div className="flex gap-2">
            <Button
              variant={!statusFilter ? 'primary' : 'outline'}
              size="md"
              onClick={() => {
                searchParams.delete('filter');
                setSearchParams(searchParams);
              }}
            >
              {t('events.all')} ({dashboardStats?.totalEvents ?? 0})
            </Button>
            <Button
              variant={statusFilter === 'active' ? 'primary' : 'outline'}
              size="md"
              onClick={() => setSearchParams({ filter: 'active' })}
            >
              {t('events.active')}
            </Button>
            <Button
              variant={isExpiringFilter ? 'primary' : 'outline'}
              size="md"
              onClick={() => setSearchParams({ filter: 'expiring' })}
              leftIcon={<AlertTriangle className="w-4 h-4" />}
            >
              {t('events.expiring')}
            </Button>
            <Button
              variant={isDraftFilter ? 'primary' : 'outline'}
              size="md"
              onClick={() => setSearchParams({ filter: 'draft' })}
            >
              {t('events.draft')}
            </Button>
            <Button
              variant={statusFilter === 'archived' ? 'primary' : 'outline'}
              size="md"
              onClick={() => setSearchParams({ filter: 'archived' })}
              leftIcon={<Archive className="w-4 h-4" />}
            >
              {t('events.archived')}
            </Button>
          </div>
        </div>

        {/* Bulk Actions */}
        {selectedEvents.length > 0 && (
          <div className="mt-4 p-3 bg-accent-dark/15 rounded-lg flex items-center justify-between">
            <span className="text-sm text-accent-dark">
              {t('events.eventsSelected', { count: selectedEvents.length })}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setSelectedEvents([])}>
                {t('events.clear')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => bulkArchiveModal.open()}
              >
                {t('events.archiveSelected')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => bulkDeleteModal.open()}
                className="border-red-300 text-red-700 hover:bg-red-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-900/30"
              >
                {t('events.deleteSelected', 'Delete Selected')}
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* Events Table */}
      <Card className="overflow-visible">
        <div className="overflow-x-auto overflow-y-visible">
          <table className="w-full">
            <thead className="bg-neutral-50 dark:bg-neutral-800 border-b border-neutral-200 dark:border-neutral-700">
              <tr>
                <th className="px-6 py-3 text-left">
                  <input
                    type="checkbox"
                    checked={selectedEvents.length === events.length && events.length > 0}
                    onChange={handleSelectAll}
                    className="w-4 h-4 text-accent border-neutral-300 dark:border-neutral-600 rounded focus:ring-primary-500 dark:bg-neutral-700"
                  />
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">
                  {t('events.event')}
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">
                  {t('events.type')}
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">
                  {t('events.date')}
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">
                  {t('events.photos', 'Photos')}
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">
                  {t('events.status')}
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">
                  {t('events.expires')}
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">
                  {t('events.actions')}
                </th>
              </tr>
            </thead>
            <tbody className="bg-white dark:bg-neutral-800 divide-y divide-neutral-200 dark:divide-neutral-700">
              {events.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-6 py-12 text-center text-neutral-500 dark:text-neutral-400">
                    {t('events.noEventsFound')}
                  </td>
                </tr>
              ) : (
                events.map((event) => {
                  const status = getEventStatus(event);

                  return (
                    <tr
                      key={event.id}
                      className="hover:bg-neutral-50 dark:hover:bg-neutral-700/50 cursor-pointer"
                      onClick={() => navigate(`/admin/events/${event.id}`)}
                    >
                      <td className="px-6 py-4" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedEvents.includes(event.id)}
                          onChange={() => handleSelectEvent(event.id)}
                          className="w-4 h-4 text-accent border-neutral-300 dark:border-neutral-600 rounded focus:ring-primary-500 dark:bg-neutral-700"
                        />
                      </td>
                      <td className="px-6 py-4">
                        <div>
                          <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{event.event_name}</p>
                          <p className="text-xs text-neutral-500 dark:text-neutral-400">{event.customer_email}</p>
                          <div className="mt-1">
                            <span
                              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${
                                isGalleryPublic(event.require_password)
                                  ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300'
                                  : 'bg-neutral-100 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300'
                              }`}
                            >
                              {isGalleryPublic(event.require_password) ? t('events.publicAccess', 'Public access') : t('events.passwordProtected', 'Password protected')}
                            </span>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-sm text-neutral-700 dark:text-neutral-300">
                        {event.event_type}
                      </td>
                      <td className="px-6 py-4 text-sm text-neutral-700 dark:text-neutral-300">
                        {event.event_date ? format(parseISO(event.event_date), 'MMM d, yyyy') : 'N/A'}
                      </td>
                      <td className="px-6 py-4 text-sm text-right tabular-nums text-neutral-700 dark:text-neutral-300">
                        {event.photo_count ?? 0}
                      </td>
                      <td className="px-6 py-4">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${status.color}`}>
                          {status.label}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-sm text-neutral-700 dark:text-neutral-300">
                        {event.expires_at ? format(parseISO(event.expires_at), 'MMM d, yyyy') : 'N/A'}
                      </td>
                      <td className="px-6 py-4" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center gap-1">
                          {/* Inline action buttons - hidden on mobile */}
                          <div className="hidden md:flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => navigate(`/admin/events/${event.id}`)}
                              title={t('events.viewDetails')}
                            >
                              <Edit className="w-4 h-4" />
                            </Button>
                            {event.share_link && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => window.open(buildShareLinkUrl(event.share_link), '_blank')}
                                title={t('events.viewGallery')}
                              >
                                <ExternalLink className="w-4 h-4" />
                              </Button>
                            )}
                            {event.share_link && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => copyShareLink(event)}
                                title={t('events.copyLink', 'Copy Link')}
                              >
                                {copiedEventId === event.id ? (
                                  <CheckCircle className="w-4 h-4 text-green-600" />
                                ) : (
                                  <Copy className="w-4 h-4" />
                                )}
                              </Button>
                            )}
                          </div>

                          {/* Context menu for additional actions */}
                          <div className="relative inline-block text-left dropdown-container">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                if (activeDropdown === event.id) {
                                  setActiveDropdown(null);
                                  setDropdownPosition(null);
                                } else {
                                  const rect = e.currentTarget.getBoundingClientRect();
                                  setActiveDropdown(event.id);
                                  setDropdownPosition({
                                    top: rect.bottom + window.scrollY,
                                    left: rect.right - 224 + window.scrollX // 224px = 14rem (w-56)
                                  });
                                }
                              }}
                              className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 p-1"
                            >
                              <MoreVertical className="w-5 h-5" />
                            </button>

                            {activeDropdown === event.id && dropdownPosition && (
                              <div
                                className="fixed z-50 w-56 rounded-md shadow-lg bg-white dark:bg-neutral-800 ring-1 ring-black ring-opacity-5 dark:ring-neutral-700"
                                style={{ top: `${dropdownPosition.top}px`, left: `${dropdownPosition.left}px` }}
                              >
                                <div className="py-1">
                                  {/* Show Edit/View on mobile only (already visible inline on desktop) */}
                                  <button
                                    onClick={() => {
                                      navigate(`/admin/events/${event.id}`);
                                      setActiveDropdown(null);
                                      setDropdownPosition(null);
                                    }}
                                    className="md:hidden w-full text-left px-4 py-2 text-sm text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700 flex items-center gap-2"
                                  >
                                    <Edit className="w-4 h-4" />
                                    {t('events.viewDetails')}
                                  </button>
                                  {event.share_link ? (
                                    <a
                                      href={buildShareLinkUrl(event.share_link)}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="md:hidden w-full text-left px-4 py-2 text-sm text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700 flex items-center gap-2"
                                      onClick={() => {
                                        setActiveDropdown(null);
                                        setDropdownPosition(null);
                                      }}
                                    >
                                      <ExternalLink className="w-4 h-4" />
                                      {t('events.viewGallery')}
                                    </a>
                                  ) : null}
                                  {event.share_link ? (
                                    <button
                                      onClick={() => {
                                        copyShareLink(event);
                                        setActiveDropdown(null);
                                        setDropdownPosition(null);
                                      }}
                                      className="md:hidden w-full text-left px-4 py-2 text-sm text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700 flex items-center gap-2"
                                    >
                                      <Copy className="w-4 h-4" />
                                      {t('events.copyLink', 'Copy Link')}
                                    </button>
                                  ) : null}
                                  {!event.is_archived ? (
                                    <button
                                      onClick={() => {
                                        archiveMutation.mutate(event.id);
                                        setActiveDropdown(null);
                                        setDropdownPosition(null);
                                      }}
                                      className="w-full text-left px-4 py-2 text-sm text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700 flex items-center gap-2"
                                    >
                                      <Archive className="w-4 h-4" />
                                      {t('events.archiveEventAction')}
                                    </button>
                                  ) : null}
                                  {event.is_archived ? (
                                    <button
                                      onClick={() => {
                                        toast.info(t('events.downloadArchiveSoon'));
                                        setActiveDropdown(null);
                                        setDropdownPosition(null);
                                      }}
                                      className="w-full text-left px-4 py-2 text-sm text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700 flex items-center gap-2"
                                    >
                                      <Download className="w-4 h-4" />
                                      {t('events.downloadArchiveAction')}
                                    </button>
                                  ) : null}
                                  <button
                                    onClick={() => {
                                      if (confirm(t('events.deleteEventConfirm'))) {
                                        deleteMutation.mutate(event.id);
                                        setActiveDropdown(null);
                                        setDropdownPosition(null);
                                      }
                                    }}
                                    className="w-full text-left px-4 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 flex items-center gap-2"
                                  >
                                    <Trash2 className="w-4 h-4" />
                                    {t('events.deleteEvent')}
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Pagination — only when the current filter has more than one page */}
      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm text-neutral-600 dark:text-neutral-400">
          <div>
            {t('events.paginationLabel', {
              from: events.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1,
              to: (page - 1) * PAGE_SIZE + events.length,
              total: filteredCount,
              defaultValue: '{{from}}–{{to}} of {{total}}',
            })}
            {isFilteringOrSearching && (
              <span className="ml-2 text-neutral-400">({t('events.filtered', 'filtered')})</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              leftIcon={<ChevronLeft className="w-4 h-4" />}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
            >
              {t('common.previous', 'Previous')}
            </Button>
            <span>
              {t('events.pageOf', {
                page,
                totalPages,
                defaultValue: 'Page {{page}} of {{totalPages}}',
              })}
            </span>
            <Button
              variant="outline"
              size="sm"
              rightIcon={<ChevronRight className="w-4 h-4" />}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
            >
              {t('common.next', 'Next')}
            </Button>
          </div>
        </div>
      )}

      {/* Bulk Archive Modal */}
      <BulkArchiveModal
        isOpen={bulkArchiveModal.isOpen}
        onClose={bulkArchiveModal.close}
        onConfirm={() => bulkArchiveMutation.mutate(selectedEvents)}
        selectedEvents={events.filter(e => selectedEvents.includes(e.id))}
        isLoading={bulkArchiveMutation.isPending}
      />

      {/* Bulk Delete Modal */}
      <BulkDeleteModal
        isOpen={bulkDeleteModal.isOpen}
        onClose={bulkDeleteModal.close}
        onConfirm={async () => {
          await bulkDeleteMutation.mutateAsync(selectedEvents);
        }}
        selectedEvents={events.filter(e => selectedEvents.includes(e.id))}
        isLoading={bulkDeleteMutation.isPending}
      />
      </div>
    </ErrorBoundary>
  );
};

EventsListPage.displayName = 'EventsListPage';
