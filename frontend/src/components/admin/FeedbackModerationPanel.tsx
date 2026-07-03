import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  MessageSquare,
  EyeOff,
  Trash2,
  CheckCircle,
  User
} from 'lucide-react';
import { toast } from 'react-toastify';

import { Card, Loading, Button } from '../common';
import { AdminAuthenticatedImage } from './AdminAuthenticatedImage';
import { feedbackService, type FeedbackResponse, type PhotoFeedback } from '../../services/feedback.service';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';

interface FeedbackModerationPanelProps {
  eventId: number;
  className?: string;
  compact?: boolean;
  maxItems?: number;
}

export const FeedbackModerationPanel: React.FC<FeedbackModerationPanelProps> = ({
  eventId,
  className = '',
  compact = false,
  maxItems = 5
}) => {
  const { t } = useTranslation();
  const { formatDateTime } = useLocalizedDate();
  const queryClient = useQueryClient();
  const [showAll, setShowAll] = useState(false);

  // Fetch pending feedback
  const { data: feedbackData, isLoading } = useQuery<FeedbackResponse>({
    queryKey: ['event-feedback-moderation', eventId],
    queryFn: () => feedbackService.getEventFeedback(eventId.toString(), {
      type: 'comment',
      status: 'pending',
      limit: showAll ? 100 : maxItems
    }),
    refetchInterval: 30000 // Refresh every 30 seconds
  });

  // Moderation mutation
  const moderateMutation = useMutation({
    mutationFn: ({ feedbackId, action }: { feedbackId: string; action: 'approve' | 'hide' | 'reject' }) =>
      feedbackService.moderateFeedback(feedbackId, action),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['event-feedback-moderation', eventId] });
      toast.success(t('feedback.moderationSuccess'));
    }
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: (feedbackId: string) => feedbackService.deleteFeedback(feedbackId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['event-feedback-moderation', eventId] });
      toast.success(t('feedback.deleted'));
    }
  });

  if (isLoading) {
    return (
      <Card className={className}>
        <div className="p-6">
          <Loading />
        </div>
      </Card>
    );
  }

  const pendingComments: PhotoFeedback[] = feedbackData?.feedback || [];
  const hasPending = pendingComments.length > 0;

  return (
    <Card className={className}>
      <div className={compact ? 'p-4' : 'p-6'}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-neutral-900">
            {t('feedback.pendingModeration', 'Pending Moderation')}
          </h2>
          {hasPending && (
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
              {pendingComments.length} {t('feedback.pending', 'pending')}
            </span>
          )}
        </div>

        {!hasPending ? (
          <div className="text-center py-8">
            <CheckCircle className="w-12 h-12 text-green-500 mx-auto mb-3" />
            <p className="text-neutral-600 dark:text-neutral-300">{t('feedback.noPendingComments', 'No comments pending moderation')}</p>
          </div>
        ) : (
          <div className="space-y-3">
            {pendingComments.slice(0, showAll ? undefined : maxItems).map((item) => (
              <div key={item.id} className="border border-neutral-200 dark:border-neutral-700 rounded-lg p-4 hover:bg-neutral-50 dark:hover:bg-neutral-800">
                <div className="flex items-start gap-3">
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 bg-neutral-100 dark:bg-neutral-800 rounded-full flex items-center justify-center">
                      <User className="w-5 h-5 text-neutral-600 dark:text-neutral-300" />
                    </div>
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 text-sm">
                          <span className="font-medium text-neutral-900 dark:text-neutral-100">
                            {item.guest_name || t('feedback.anonymous', 'Anonymous')}
                          </span>
                          <span className="text-neutral-500 dark:text-neutral-400">•</span>
                          <span className="text-neutral-500 dark:text-neutral-400">
                            {formatDateTime(item.created_at)}
                          </span>
                        </div>
                        <p className="mt-1 text-sm text-neutral-700">{item.comment_text || item.comment}</p>
                        {item.photo_id && (
                          <div className="mt-2 flex items-center gap-2">
                            <div className="w-16 h-16 overflow-hidden rounded">
                              <AdminAuthenticatedImage 
                                src={`/admin/photos/${eventId}/thumbnail/${item.photo_id}`}
                                alt={item.filename || 'Photo'}
                                className="w-16 h-16 object-cover rounded"
                              />
                            </div>
                            <p className="text-xs text-neutral-500">
                              {t('feedback.onPhoto', 'On photo')}: {item.filename || item.photo_filename || `#${item.photo_id}`}
                            </p>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2 mt-3">
                      <Button
                        size="sm"
                        variant="ghost"
                        leftIcon={<CheckCircle className="w-4 h-4" />}
                        onClick={() => moderateMutation.mutate({ 
                          feedbackId: item.id.toString(), 
                          action: 'approve' 
                        })}
                        isLoading={moderateMutation.isPending}
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
                        isLoading={moderateMutation.isPending}
                      >
                        {t('feedback.hide', 'Hide')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        leftIcon={<Trash2 className="w-4 h-4" />}
                        onClick={() => {
                          if (confirm(t('feedback.confirmDelete', 'Are you sure you want to delete this comment?'))) {
                            deleteMutation.mutate(item.id.toString());
                          }
                        }}
                        isLoading={deleteMutation.isPending}
                        className="text-red-600 hover:text-red-700 hover:bg-red-50"
                      >
                        {t('common.delete', 'Delete')}
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            ))}

            {pendingComments.length > maxItems && !showAll && (
              <button
                onClick={() => setShowAll(true)}
                className="w-full text-center py-2 text-sm text-accent hover:opacity-80 font-medium"
              >
                {t('feedback.showAll', 'Show all {{count}} pending comments', { count: pendingComments.length })}
              </button>
            )}
          </div>
        )}

        {/* Quick link to full feedback page */}
        <div className="mt-4 pt-4 border-t border-neutral-200">
          <a
            href={`/admin/events/${eventId}/feedback`}
            className="text-sm text-accent hover:opacity-80 font-medium flex items-center gap-1"
          >
            <MessageSquare className="w-4 h-4" />
            {t('feedback.viewAllFeedback', 'View all feedback & settings')}
          </a>
        </div>
      </div>
    </Card>
  );
};

FeedbackModerationPanel.displayName = 'FeedbackModerationPanel';
