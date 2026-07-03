import React, { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { 
  ArrowLeft, 
  MessageSquare, 
  Star, 
  Heart, 
  TrendingUp,
  Filter,
  Download,
  Shield,
  CheckCircle,
  Eye,
  EyeOff,
  Trash2
} from 'lucide-react';
import { toast } from 'react-toastify';
import { format, parseISO } from 'date-fns';

import { Button, Card, Loading } from '../../components/common';
import { AdminAuthenticatedImage } from '../../components/admin/AdminAuthenticatedImage';
import { FeedbackSettings } from '../../components/admin';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { eventsService } from '../../services/events.service';
import { feedbackService } from '../../services/feedback.service';
import type { PhotoFeedback, FeedbackAnalytics, FeedbackResponse } from '../../services/feedback.service';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';

export const EventFeedbackPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const { formatDateTime: fmtDateTime } = useLocalizedDate();

  const [activeTab, setActiveTab] = useState<'settings' | 'feedback' | 'analytics' | 'moderation'>('settings');
  const [feedbackFilter, setFeedbackFilter] = useState({
    type: '',
    status: '',
    page: 1,
    limit: 20
  });
  // Export shape selector (#640 #6). 'long' = one row per individual feedback
  // action (backward-compat, what the existing export has always been).
  // 'pivot' = one row per (photo, guest) — handier for spreadsheet pivot tables
  // and per-guest engagement scans, hidden rows excluded.
  const [exportShape, setExportShape] = useState<'long' | 'pivot'>('long');

  // Fetch event details
  const { data: event, isLoading: eventLoading } = useQuery({
    queryKey: ['event', id],
    queryFn: () => eventsService.getEvent(Number(id)),
    enabled: !!id
  });

  // Fetch feedback settings
  const { data: settings, isLoading: settingsLoading } = useQuery({
    queryKey: ['feedback-settings', id],
    queryFn: () => feedbackService.getEventFeedbackSettings(id!),
    enabled: !!id
  });

  // Fetch feedback list
  const { data: feedbackData, isLoading: feedbackLoading } = useQuery<FeedbackResponse>({
    queryKey: ['event-feedback', id, feedbackFilter],
    queryFn: () => feedbackService.getEventFeedback(id!, feedbackFilter),
    enabled: !!id && activeTab === 'feedback'
  });

  // Fetch analytics
  const { data: analytics, isLoading: analyticsLoading } = useQuery<FeedbackAnalytics>({
    queryKey: ['feedback-analytics', id],
    queryFn: () => feedbackService.getEventFeedbackAnalytics(id!),
    enabled: !!id && activeTab === 'analytics'
  });

  // Update settings mutation
  const updateSettingsMutation = useMutation({
    mutationFn: (newSettings: any) => feedbackService.updateEventFeedbackSettings(id!, newSettings),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['feedback-settings', id] });
      toast.success(t('feedback.settingsUpdated', 'Feedback settings updated'));
    },
    onError: () => {
      toast.error(t('feedback.settingsUpdateError', 'Failed to update settings'));
    }
  });

  // Moderate feedback mutation
  const moderateMutation = useMutation({
    mutationFn: ({ feedbackId, action }: { feedbackId: string; action: 'approve' | 'hide' | 'reject' }) =>
      feedbackService.moderateFeedback(feedbackId, action),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['event-feedback', id] });
      toast.success(t('feedback.moderated', 'Feedback moderated'));
    }
  });

  // Delete feedback mutation
  const deleteMutation = useMutation({
    mutationFn: (feedbackId: string) => feedbackService.deleteFeedback(feedbackId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['event-feedback', id] });
      toast.success(t('feedback.deleted', 'Feedback deleted'));
    }
  });

  // Export feedback. Filename carries the shape so multiple exports of the
  // same event don't overwrite each other in the admin's Downloads folder.
  const handleExport = async (format: 'json' | 'csv') => {
    try {
      const data = await feedbackService.exportEventFeedback(id!, format, exportShape);
      const eventSlug = event?.slug || id;
      const filename = `feedback-${exportShape}-${eventSlug}.${format}`;
      if (format === 'csv') {
        const blob = new Blob([data], { type: 'text/csv' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
      } else {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
      }
      toast.success(t('feedback.exported', 'Feedback exported'));
    } catch (error) {
      toast.error(t('feedback.exportError', 'Failed to export feedback'));
    }
  };

  if (eventLoading || settingsLoading) {
    return <Loading />;
  }

  if (!event) {
    return <div>{t('events.notFound', 'Event not found')}</div>;
  }

  const pagination = feedbackData?.pagination;
  const perPage = pagination?.per_page ?? feedbackFilter.limit ?? 20;
  const totalPages = perPage ? Math.max(1, Math.ceil((pagination?.total ?? 0) / perPage)) : 1;

  return (
    <div className="max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<ArrowLeft className="w-4 h-4" />}
            onClick={() => navigate(`/admin/events/${id}`)}
          >
            {t('common.back')}
          </Button>
          <div>
            <h1 className="text-2xl font-bold text-neutral-900">
              {t('feedback.title', 'Feedback Management')}
            </h1>
            <p className="text-sm text-neutral-600 mt-1">
              {event.event_name} • {event.slug}
            </p>
          </div>
        </div>
        <div className="flex gap-2 items-end">
          {/* Shape selector (#640 #6). Long is the existing per-action shape;
              pivot is per-(photo, guest) for spreadsheet pivot tables. */}
          <div className="flex flex-col gap-1">
            <label className="text-xs text-neutral-500 dark:text-neutral-400" htmlFor="feedback-export-shape">
              {t('feedback.exportShapeLabel', 'Shape')}
            </label>
            <select
              id="feedback-export-shape"
              value={exportShape}
              onChange={(e) => setExportShape(e.target.value as 'long' | 'pivot')}
              className="text-sm px-2 py-1.5 rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800"
            >
              <option value="long">{t('feedback.exportShapeLong', 'Per-action (long)')}</option>
              <option value="pivot">{t('feedback.exportShapePivot', 'Per-guest (pivot)')}</option>
            </select>
          </div>
          <Button
            variant="outline"
            size="sm"
            leftIcon={<Download className="w-4 h-4" />}
            onClick={() => handleExport('csv')}
          >
            {t('feedback.exportCSV', 'Export CSV')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            leftIcon={<Download className="w-4 h-4" />}
            onClick={() => handleExport('json')}
          >
            {t('feedback.exportJSON', 'Export JSON')}
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="mb-6 border-b border-neutral-200">
        <nav className="-mb-px flex gap-6">
          {[
            { id: 'settings', label: t('feedback.tabs.settings', 'Settings'), icon: Shield },
            { id: 'feedback', label: t('feedback.tabs.feedback', 'Feedback'), icon: MessageSquare },
            { id: 'analytics', label: t('feedback.tabs.analytics', 'Analytics'), icon: TrendingUp },
            { id: 'moderation', label: t('feedback.tabs.moderation', 'Moderation'), icon: Filter },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`flex items-center gap-2 px-1 py-2 border-b-2 font-medium text-sm transition-colors ${
                activeTab === tab.id
                  ? 'border-accent text-accent'
                  : 'border-transparent text-neutral-500 hover:text-neutral-700 hover:border-neutral-300'
              }`}
            >
              <tab.icon className="w-4 h-4" />
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Content */}
      {activeTab === 'settings' && settings && (
        <FeedbackSettings
          settings={settings}
          onChange={(newSettings) => updateSettingsMutation.mutate(newSettings)}
        />
      )}

      {activeTab === 'feedback' && (
        <div className="space-y-4">
          {/* Filters */}
          <Card>
            <div className="p-4 flex gap-4">
              <select
                value={feedbackFilter.type}
                onChange={(e) => setFeedbackFilter({ ...feedbackFilter, type: e.target.value, page: 1 })}
                className="px-3 py-2 border border-neutral-300 rounded-lg"
              >
                <option value="">{t('feedback.allTypes', 'All Types')}</option>
                <option value="rating">{t('feedback.types.rating', 'Ratings')}</option>
                <option value="like">{t('feedback.types.like', 'Likes')}</option>
                <option value="comment">{t('feedback.types.comment', 'Comments')}</option>
                <option value="favorite">{t('feedback.types.favorite', 'Favorites')}</option>
              </select>
              <select
                value={feedbackFilter.status}
                onChange={(e) => setFeedbackFilter({ ...feedbackFilter, status: e.target.value, page: 1 })}
                className="px-3 py-2 border border-neutral-300 rounded-lg"
              >
                <option value="">{t('feedback.allStatuses', 'All Statuses')}</option>
                <option value="pending">{t('feedback.status.pending', 'Pending')}</option>
                <option value="approved">{t('feedback.status.approved', 'Approved')}</option>
                <option value="hidden">{t('feedback.status.hidden', 'Hidden')}</option>
              </select>
            </div>
          </Card>

          {/* Feedback List */}
          {feedbackLoading ? (
            <Loading />
          ) : feedbackData?.feedback?.length === 0 ? (
            <Card>
              <div className="p-8 text-center text-neutral-500">
                {t('feedback.noFeedback', 'No feedback found')}
              </div>
            </Card>
          ) : (
            <div className="space-y-2">
              {feedbackData?.feedback?.map((item: PhotoFeedback) => (
                <Card key={item.id} className="overflow-hidden">
                  <div className="p-4 flex items-start gap-4">
                    {item.photo_id && (
                      <div className="w-16 h-16 overflow-hidden rounded">
                        <AdminAuthenticatedImage
                          src={`/admin/photos/${id}/thumbnail/${item.photo_id}`}
                          alt={item.filename || 'Photo'}
                          className="w-16 h-16 object-cover rounded"
                        />
                      </div>
                    )}
                    <div className="flex-1">
                      <div className="flex items-start justify-between">
                        <div>
                          <div className="flex items-center gap-2 mb-1">
                            {item.feedback_type === 'rating' && <Star className="w-4 h-4 text-yellow-500" />}
                            {item.feedback_type === 'like' && <Heart className="w-4 h-4 text-red-500" />}
                            {item.feedback_type === 'comment' && <MessageSquare className="w-4 h-4 text-blue-500" />}
                            <span className="font-medium text-sm">
                              {item.guest_name || t('feedback.anonymous', 'Anonymous')}
                            </span>
                            {item.guest_email && (
                              <span className="text-xs text-neutral-500">({item.guest_email})</span>
                            )}
                          </div>
                          {item.rating && (
                            <div className="flex gap-1 mb-1">
                              {[1, 2, 3, 4, 5].map((star) => (
                                <Star
                                  key={star}
                                  className={`w-4 h-4 ${
                                    star <= item.rating! ? 'fill-yellow-500 text-yellow-500' : 'text-neutral-300'
                                  }`}
                                />
                              ))}
                            </div>
                          )}
                          {item.comment_text && (
                            <p className="text-sm text-neutral-700">{item.comment_text}</p>
                          )}
                          <p className="text-xs text-neutral-500 mt-1">
                            {(() => {
                              const d = typeof item.created_at === 'string' 
                                ? parseISO(item.created_at) 
                                : new Date(item.created_at);
                              return isNaN(d.getTime()) ? t('common.unknownDate', 'Unknown date') : fmtDateTime(d);
                            })()}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          {item.feedback_type === 'comment' && !item.is_approved && (
                            <>
                              <Button
                                size="sm"
                                variant="ghost"
                                leftIcon={<CheckCircle className="w-4 h-4" />}
                                onClick={() => moderateMutation.mutate({ 
                                  feedbackId: item.id.toString(), 
                                  action: 'approve' 
                                })}
                              >
                                {t('feedback.approve', 'Approve')}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                leftIcon={<EyeOff className="w-4 h-4" />}
                                onClick={() => moderateMutation.mutate({ 
                                  feedbackId: item.id.toString(), 
                                  action: 'hide' 
                                })}
                              >
                                {t('feedback.hide', 'Hide')}
                              </Button>
                            </>
                          )}
                          {item.is_hidden && (
                            <Button
                              size="sm"
                              variant="ghost"
                              leftIcon={<Eye className="w-4 h-4" />}
                              onClick={() => moderateMutation.mutate({ 
                                feedbackId: item.id.toString(), 
                                action: 'approve' 
                              })}
                            >
                              {t('feedback.unhide', 'Unhide')}
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            leftIcon={<Trash2 className="w-4 h-4" />}
                            onClick={() => {
                              if (confirm(t('feedback.confirmDelete', 'Are you sure you want to delete this feedback?'))) {
                                deleteMutation.mutate(item.id.toString());
                              }
                            }}
                          >
                            {t('common.delete', 'Delete')}
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}

          {/* Pagination */}
          {pagination && totalPages > 1 && (
            <div className="flex justify-center gap-2 mt-4">
              <Button
                variant="outline"
                size="sm"
                disabled={feedbackFilter.page === 1}
                onClick={() => setFeedbackFilter({ ...feedbackFilter, page: feedbackFilter.page - 1 })}
              >
                {t('common.previous', 'Previous')}
              </Button>
              <span className="flex items-center px-3 text-sm text-neutral-600">
                {t('common.pageOf', 'Page {{current}} of {{total}}', {
                  current: feedbackFilter.page,
                  total: totalPages
                })}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={feedbackFilter.page >= totalPages}
                onClick={() => setFeedbackFilter({ ...feedbackFilter, page: feedbackFilter.page + 1 })}
              >
                {t('common.next', 'Next')}
              </Button>
            </div>
          )}
        </div>
      )}

      {activeTab === 'analytics' && (
        <div className="space-y-6">
          {analyticsLoading ? (
            <Loading />
          ) : analytics ? (
            <>
              {/* Summary Stats */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <Card>
                  <div className="p-6">
                    <div className="flex items-center gap-3 mb-2">
                      <Star className="w-8 h-8 text-yellow-500" />
                      <div>
                        <p className="text-2xl font-bold">{(analytics.summary.average_rating || 0).toFixed(1)}</p>
                        <p className="text-sm text-neutral-600">{t('feedback.avgRating', 'Average Rating')}</p>
                      </div>
                    </div>
                    <p className="text-xs text-neutral-500">
                      {t('feedback.totalRatings', '{{count}} ratings', { count: analytics.summary.total_ratings })}
                    </p>
                  </div>
                </Card>
                <Card>
                  <div className="p-6">
                    <div className="flex items-center gap-3 mb-2">
                      <Heart className="w-8 h-8 text-red-500" />
                      <div>
                        <p className="text-2xl font-bold">{analytics.summary.total_likes}</p>
                        <p className="text-sm text-neutral-600">{t('feedback.totalLikes', 'Total Likes')}</p>
                      </div>
                    </div>
                  </div>
                </Card>
                <Card>
                  <div className="p-6">
                    <div className="flex items-center gap-3 mb-2">
                      <MessageSquare className="w-8 h-8 text-blue-500" />
                      <div>
                        <p className="text-2xl font-bold">{analytics.summary.total_comments}</p>
                        <p className="text-sm text-neutral-600">{t('feedback.totalComments', 'Total Comments')}</p>
                      </div>
                    </div>
                    {analytics.summary.pending_moderation > 0 && (
                      <p className="text-xs text-orange-600">
                        {t('feedback.pendingModeration', '{{count}} pending', { 
                          count: analytics.summary.pending_moderation 
                        })}
                      </p>
                    )}
                  </div>
                </Card>
                <Card>
                  <div className="p-6">
                    <div className="flex items-center gap-3 mb-2">
                      <TrendingUp className="w-8 h-8 text-green-500" />
                      <div>
                        <p className="text-2xl font-bold">{analytics.summary.total_feedback}</p>
                        <p className="text-sm text-neutral-600">{t('feedback.totalInteractions', 'Total Interactions')}</p>
                      </div>
                    </div>
                  </div>
                </Card>
              </div>

              {/* Top Rated Photos */}
              {analytics.topRated.length > 0 && (
                <Card>
                  <div className="p-6">
                    <h3 className="text-lg font-semibold mb-4">{t('feedback.topRated', 'Top Rated Photos')}</h3>
                    <div className="space-y-3">
                      {analytics.topRated.map((photo) => (
                        <div key={photo.id} className="flex items-center justify-between">
                          <span className="text-sm">{photo.filename}</span>
                          <div className="flex items-center gap-2">
                            <div className="flex gap-0.5">
                              {[1, 2, 3, 4, 5].map((star) => (
                                <Star
                                  key={star}
                                  className={`w-3 h-3 ${
                                    star <= Math.round(photo.average_rating) 
                                      ? 'fill-yellow-500 text-yellow-500' 
                                      : 'text-neutral-300'
                                  }`}
                                />
                              ))}
                            </div>
                            <span className="text-sm text-neutral-600">
                              {Number(photo.average_rating).toFixed(1)} ({photo.feedback_count})
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </Card>
              )}

              {/* Recent Comments */}
              {analytics.recentComments.length > 0 && (
                <Card>
                  <div className="p-6">
                    <h3 className="text-lg font-semibold mb-4">{t('feedback.recentComments', 'Recent Comments')}</h3>
                    <div className="space-y-3">
                      {analytics.recentComments.map((comment, idx) => (
                        <div key={idx} className="border-b border-neutral-100 pb-3 last:border-0">
                          <p className="text-sm text-neutral-700">{comment.comment_text}</p>
                          <p className="text-xs text-neutral-500 mt-1">
                            {comment.guest_name} • {comment.filename} • 
                            {(() => {
                              const d = typeof comment.created_at === 'string' 
                                ? parseISO(comment.created_at) 
                                : new Date(comment.created_at);
                              return isNaN(d.getTime()) ? t('common.unknownDate', 'Unknown date') : format(d, 'PP');
                            })()}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                </Card>
              )}
            </>
          ) : null}
        </div>
      )}

      {activeTab === 'moderation' && (
        <div className="space-y-4">
          <Card>
            <div className="p-6">
              <h3 className="text-lg font-semibold mb-4">{t('feedback.wordFilters', 'Word Filters')}</h3>
              <p className="text-sm text-neutral-600">
                {t('feedback.wordFiltersDesc', 'Manage blocked words for comment moderation')}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-4"
                onClick={() => navigate('/admin/settings/moderation')}
              >
                {t('feedback.manageFilters', 'Manage Word Filters')}
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
};
