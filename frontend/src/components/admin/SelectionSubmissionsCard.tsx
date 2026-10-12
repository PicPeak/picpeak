import React from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle, Heart, RotateCcw } from 'lucide-react';
import { toast } from 'react-toastify';

import { Button, Card, useConfirm } from '../common';
import { feedbackService } from '../../services/feedback.service';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { useAnyPermission } from '../../hooks/usePermission';

/**
 * Finished selections and approvals of one gallery, per guest (issue 1733,
 * backlog item A1). A submission locks that guest's picks (or their approve /
 * reject); reopening one lets them change and hand it in again. Nothing is
 * rendered until a guest has submitted something.
 */
export const SelectionSubmissionsCard: React.FC<{ eventId: string; className?: string }> = ({ eventId, className }) => {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const { formatDateTime } = useLocalizedDate();
  // Reopening is client help, like moderating (adminFeedback.js).
  const canReopen = useAnyPermission(['events.edit', 'events.support']);

  const queryKey = ['selection-submissions', eventId];
  const { data: submissions } = useQuery({
    queryKey,
    queryFn: () => feedbackService.getSelectionSubmissions(eventId),
    enabled: !!eventId,
  });

  const reopenMutation = useMutation({
    mutationFn: (submissionId: number) => feedbackService.reopenSelectionSubmission(eventId, submissionId),
    onSuccess: () => toast.success(t('feedback.submissions.reopened', 'Submission reopened')),
    onError: () => toast.error(t('feedback.submissions.reopenError', 'Failed to reopen the submission')),
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });

  if (!submissions || submissions.length === 0) return null;

  return (
    <Card className={className}>
      <div className="p-4">
        <h3 className="text-sm font-semibold text-heading mb-3">
          {t('feedback.submissions.title', 'Finished selections and approvals')}
        </h3>
        <ul className="divide-y divide-line-faint">
          {submissions.map((submission) => (
            <li key={submission.id} className="py-3 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm">
                  {submission.kind === 'approval'
                    ? <CheckCircle className="w-4 h-4 text-success-text" aria-hidden="true" />
                    : <Heart className="w-4 h-4 text-danger" aria-hidden="true" />}
                  <span className="font-medium text-heading">
                    {submission.guest_name || t('feedback.anonymous', 'Anonymous')}
                  </span>
                  <span className="text-body">
                    {submission.kind === 'approval'
                      ? t('feedback.submissions.approval', 'Approval of the edited photos')
                      : t('feedback.submissions.selection', 'Selection')}
                  </span>
                </div>
                <p className="text-xs text-muted mt-1">
                  {t('feedback.submissions.photoCount', 'Photos: {{count}}', { count: submission.item_count })}
                  {' · '}
                  {t('feedback.submissions.submittedOn', 'Submitted {{date}}', { date: formatDateTime(submission.submitted_at) })}
                  {submission.reopened_at && (
                    <>
                      {' · '}
                      {t('feedback.submissions.reopenedOn', 'Reopened {{date}}', { date: formatDateTime(submission.reopened_at) })}
                    </>
                  )}
                </p>
                {submission.note && (
                  <p className="text-sm text-body mt-1 break-words">
                    {t('feedback.submissions.note', 'Note: {{note}}', { note: submission.note })}
                  </p>
                )}
              </div>
              {canReopen && !submission.reopened_at && (
                <Button
                  size="sm"
                  variant="outline"
                  leftIcon={<RotateCcw className="w-4 h-4" />}
                  disabled={reopenMutation.isPending}
                  onClick={async () => {
                    const ok = await confirm({
                      message: t('feedback.submissions.reopenConfirm', 'Reopen this submission? The guest can change their picks again and has to submit them anew.'),
                      confirmLabel: t('feedback.submissions.reopen', 'Reopen'),
                    });
                    if (ok) reopenMutation.mutate(submission.id);
                  }}
                >
                  {t('feedback.submissions.reopen', 'Reopen')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
};
