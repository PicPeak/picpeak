import React, { useState, useRef, useEffect } from 'react';
import { MessageSquare, Send, User, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { feedbackService } from '../../services/feedback.service';
import { toast } from 'react-toastify';
import { format } from 'date-fns';
import { Button, Input } from '../common';
import type { PhotoFeedback } from '../../services/feedback.service';
import { useGuestIdentityOptional } from '../../contexts/GuestIdentityContext';

interface PhotoCommentsProps {
  photoId: string;
  gallerySlug: string;
  comments: PhotoFeedback[];
  isEnabled: boolean;
  requireNameEmail: boolean;
  showToGuests: boolean;
  onCommentAdded?: () => void;
}

export const PhotoComments: React.FC<PhotoCommentsProps> = ({
  photoId,
  gallerySlug,
  comments,
  isEnabled,
  requireNameEmail,
  showToGuests,
  onCommentAdded
}) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const guestIdentity = useGuestIdentityOptional();
  const isGuestMode = guestIdentity?.identityMode === 'guest';
  const [showCommentForm, setShowCommentForm] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [guestName, setGuestName] = useState('');
  const [guestEmail, setGuestEmail] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [commentText]);

  const submitCommentMutation = useMutation({
    mutationFn: (data: any) => 
      feedbackService.submitFeedback(gallerySlug, photoId, {
        feedback_type: 'comment',
        comment_text: data.comment_text,
        guest_name: data.guest_name,
        guest_email: data.guest_email
      }),
    onSuccess: (response) => {
      setCommentText('');
      setShowCommentForm(false);
      queryClient.invalidateQueries({ queryKey: ['photo-feedback', gallerySlug, photoId] });
      
      if (response.message) {
        toast.info(response.message);
      } else {
        toast.success(t('feedback.commentSubmitted', 'Comment submitted'));
      }
      
      if (onCommentAdded) {
        onCommentAdded();
      }
    },
    onError: (error: any) => {
      if (error.response?.status === 429) {
        toast.error(t('feedback.rateLimited', 'Please wait before commenting again'));
      } else if (error.response?.data?.errors) {
        setErrors(error.response.data.errors);
      } else {
        toast.error(t('feedback.commentError', 'Failed to submit comment'));
      }
    }
  });

  const handleSubmitComment = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});

    // Validate
    const newErrors: Record<string, string> = {};
    if (!commentText.trim()) {
      newErrors.comment_text = t('feedback.commentRequired', 'Comment is required');
    }
    // In guest identity mode, name/email come from the guest token — don't
    // ask for them here.
    if (requireNameEmail && !isGuestMode) {
      if (!guestName.trim()) {
        newErrors.guest_name = t('feedback.nameRequired', 'Name is required');
      }
      if (!guestEmail.trim()) {
        newErrors.guest_email = t('feedback.emailRequired', 'Email is required');
      }
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    if (isGuestMode && guestIdentity) {
      try {
        await guestIdentity.ensureIdentity();
      } catch {
        return;
      }
      submitCommentMutation.mutate({ comment_text: commentText.trim() });
      return;
    }

    submitCommentMutation.mutate({
      comment_text: commentText.trim(),
      guest_name: guestName.trim() || undefined,
      guest_email: guestEmail.trim() || undefined
    });
  };

  if (!isEnabled) return null;

  // Filter comments based on visibility settings
  const visibleComments = showToGuests 
    ? comments.filter(c => c.is_approved && !c.is_hidden)
    : comments.filter(c => c.is_mine);

  return (
    <div className="space-y-4">
      {/* Comments Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-theme flex items-center gap-2">
          <MessageSquare className="w-4 h-4" />
          {t('feedback.comments', 'Comments')} 
          {visibleComments.length > 0 && (
            <span className="text-muted-theme">({visibleComments.length})</span>
          )}
        </h3>
        {!showCommentForm && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowCommentForm(true)}
          >
            {t('feedback.addComment', 'Add Comment')}
          </Button>
        )}
      </div>

      {/* Comment Form */}
      {showCommentForm && (
        <form onSubmit={handleSubmitComment} className="space-y-3 p-4 bg-surface rounded-lg border border-surface">
          {requireNameEmail && !isGuestMode && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input
                placeholder={t('feedback.yourName', 'Your name')}
                value={guestName}
                onChange={(e) => setGuestName(e.target.value)}
                error={errors.guest_name}
              />
              <Input
                type="email"
                placeholder={t('feedback.yourEmail', 'Your email')}
                value={guestEmail}
                onChange={(e) => setGuestEmail(e.target.value)}
                error={errors.guest_email}
              />
            </div>
          )}
          
          <div>
            <textarea
              ref={textareaRef}
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              placeholder={t('feedback.writeComment', 'Write a comment...')}
              className={`w-full px-3 py-2 text-sm border rounded-lg resize-vertical min-h-[100px] focus:ring-2 focus:ring-primary-500 focus:border-accent-dark ${
                errors.comment_text ? 'border-red-500' : 'border-surface'
              }`}
              rows={4}
              maxLength={500}
            />
            {errors.comment_text && (
              <p className="text-xs text-red-600 mt-1">{errors.comment_text}</p>
            )}
            <p className="text-xs text-muted-theme mt-1">
              {commentText.length}/500
            </p>
          </div>

          <div className="flex gap-2">
            <Button
              type="submit"
              size="sm"
              variant="primary"
              leftIcon={submitCommentMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              disabled={submitCommentMutation.isPending}
            >
              {t('feedback.submit', 'Submit')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setShowCommentForm(false);
                setCommentText('');
                setErrors({});
              }}
            >
              {t('common.cancel', 'Cancel')}
            </Button>
          </div>
        </form>
      )}

      {/* Comments List */}
      {visibleComments.length > 0 && (
        <div className="space-y-3">
          {visibleComments.map((comment) => (
            <div key={comment.id} className="flex gap-3">
              <div className="flex-shrink-0">
                <div className="w-8 h-8 bg-black/10 rounded-full flex items-center justify-center">
                  <User className="w-4 h-4 text-muted-theme" />
                </div>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2 mb-1">
                  <span className="text-sm font-medium text-theme">
                    {comment.guest_name || t('feedback.anonymous', 'Anonymous')}
                  </span>
                  <span className="text-xs text-muted-theme">
                    {format(new Date(comment.created_at), 'PP')}
                  </span>
                  {comment.is_mine && !comment.is_approved && (
                    <span className="text-xs text-orange-600">
                      {t('feedback.pendingApproval', 'Pending approval')}
                    </span>
                  )}
                </div>
                <p className="text-sm text-muted-theme break-words">
                  {comment.comment_text}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Empty State */}
      {visibleComments.length === 0 && !showCommentForm && (
        <p className="text-sm text-muted-theme text-center py-4">
          {t('feedback.noComments', 'No comments yet. Be the first to comment!')}
        </p>
      )}
    </div>
  );
};
