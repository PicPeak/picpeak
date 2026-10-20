import React, { useState, useRef, useEffect } from 'react';
import { MessageSquare, Send, User, Loader2, Pencil, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { feedbackService } from '../../services/feedback.service';
import { toast } from 'react-toastify';
import { Button, Input } from '../common';
import type { PhotoFeedback } from '../../services/feedback.service';
import { useGuestIdentityOptional } from '../../contexts/GuestIdentityContext';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { useCommentAnnotation } from './annotation/CommentAnnotationContext';
import { parseAnnotation } from '../../utils/photoAnnotation';

interface PhotoCommentsProps {
  photoId: string;
  gallerySlug: string;
  comments: PhotoFeedback[];
  isEnabled: boolean;
  requireNameEmail: boolean;
  showToGuests: boolean;
  /** The gallery lets a guest draw on the photo with a comment (issue 1733). */
  allowAnnotations?: boolean;
  /**
   * `comments` is the fetched list, not the empty stand-in used while it
   * loads. Only then can a comment be said to be gone.
   */
  commentsLoaded?: boolean;
  onCommentAdded?: () => void;
}

export const PhotoComments: React.FC<PhotoCommentsProps> = ({
  photoId,
  gallerySlug,
  comments,
  isEnabled,
  requireNameEmail,
  showToGuests,
  allowAnnotations = false,
  commentsLoaded = false,
  onCommentAdded
}) => {
  const { t } = useTranslation();
  const { format } = useLocalizedDate();
  const queryClient = useQueryClient();
  const guestIdentity = useGuestIdentityOptional();
  const isGuestMode = guestIdentity?.identityMode === 'guest';
  // Only inside the standard lightbox, which is where a drawing can be made
  // and laid over the photo (issue 1733). Null anywhere else.
  const annotation = useCommentAnnotation();
  const canDraw = allowAnnotations && !!annotation?.canDraw;
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
        annotation: data.annotation,
        guest_name: data.guest_name,
        guest_email: data.guest_email
      }),
    onSuccess: (response, data) => {
      setCommentText('');
      setShowCommentForm(false);
      // Only the drawing that went with this comment: the handler also runs
      // for a response that arrives after the panel was closed and reopened.
      annotation?.discardSent(data.annotation);
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

  // The lightbox's Annotate mode (issue 1733) stays shut while a comment is
  // on its way: its success clears the form and the drawing, and would take
  // a newer one too, on this photo or (the form is reused from photo to
  // photo) on the next.
  const setSending = annotation?.setSending;
  const sending = submitCommentMutation.isPending;
  useEffect(() => {
    if (!setSending) return;
    setSending(sending);
    return () => setSending(false);
  }, [setSending, sending]);

  // A drawing is made for a comment: the form opens with it. With a
  // finished one too: Annotate opens the panel, and a drawing done before
  // this form mounted (the panel loads its settings first) still needs it.
  const drawingNow = !!annotation?.drawing || !!annotation?.draft;
  useEffect(() => {
    if (drawingNow) setShowCommentForm(true);
  }, [drawingNow]);

  // The finished drawing, sent with the comment when the gallery allows it.
  const draftAnnotation = canDraw ? annotation?.draft ?? undefined : undefined;

  const handleSubmitComment = async (e: React.FormEvent) => {
    e.preventDefault();
    // A drawing still in progress is not part of the comment yet.
    if (annotation?.drawing) return;
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
      submitCommentMutation.mutate({ comment_text: commentText.trim(), annotation: draftAnnotation });
      return;
    }

    submitCommentMutation.mutate({
      comment_text: commentText.trim(),
      annotation: draftAnnotation,
      guest_name: guestName.trim() || undefined,
      guest_email: guestEmail.trim() || undefined
    });
  };

  // Filter comments based on visibility settings
  const visibleComments = showToGuests 
    ? comments.filter(c => c.is_approved && !c.is_hidden)
    : comments.filter(c => c.is_mine);

  // The drawing on the photo is a copy taken when its marker was clicked
  // (issue 1733). When its comment leaves this list (hidden or deleted by the
  // photographer, seen on the next fetch) the marker goes too, so the drawing
  // has to come off the photo with it.
  const shownCommentId = annotation?.shownCommentId ?? null;
  const hideShown = annotation?.hideShown;
  const shownCommentGone = isEnabled && commentsLoaded && shownCommentId !== null
    && !visibleComments.some(c => c.id === shownCommentId && parseAnnotation(c.annotation));
  useEffect(() => {
    if (shownCommentGone) hideShown?.();
  }, [shownCommentGone, hideShown]);

  if (!isEnabled) return null;

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
        <form onSubmit={handleSubmitComment} className="space-y-3 p-4 bg-surface rounded-lg border border-border-token">
          {requireNameEmail && !isGuestMode && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input
                themed
                placeholder={t('feedback.yourName', 'Your name')}
                value={guestName}
                onChange={(e) => setGuestName(e.target.value)}
                error={errors.guest_name}
              />
              <Input
                themed
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
              className={`w-full px-3 py-2 text-sm bg-surface text-theme placeholder:text-muted-theme border rounded-lg resize-vertical min-h-[100px] focus:ring-2 focus:ring-accent focus:border-accent-dark ${
                errors.comment_text ? 'border-danger' : 'border-border-token'
              }`}
              rows={4}
              maxLength={500}
            />
            {errors.comment_text && (
              <p className="text-xs text-status hue-danger mt-1">{errors.comment_text}</p>
            )}
            <p className="text-xs text-muted-theme mt-1">
              {commentText.length}/500
            </p>
          </div>

          {/* Draw on the photo (issue 1733). The drawing is sent with this
              comment, so the words stay required. It is drawn in the
              lightbox bar's Annotate mode, which this only points to. */}
          {canDraw && annotation && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {annotation.drawing ? (
                <p className="text-xs text-muted-theme" role="status">
                  {t('feedback.annotation.inProgress', 'Finish the drawing on the photo, then send your comment.')}
                </p>
              ) : !annotation.draft ? (
                <p className="text-xs text-muted-theme">
                  {t('feedback.annotation.hint', 'To draw on the photo, switch to Annotate.')}
                </p>
              ) : (
                <>
                  <span className="inline-flex items-center gap-1.5 text-theme">
                    <Pencil className="w-4 h-4" aria-hidden="true" />
                    {t('feedback.annotation.attached', 'Drawing attached')}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    leftIcon={<X className="w-4 h-4" />}
                    onClick={annotation.discard}
                    disabled={submitCommentMutation.isPending}
                  >
                    {t('feedback.annotation.remove', 'Remove drawing')}
                  </Button>
                </>
              )}
            </div>
          )}

          <div className="flex gap-2">
            <Button
              type="submit"
              size="sm"
              variant="primary"
              leftIcon={submitCommentMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              disabled={submitCommentMutation.isPending || !!annotation?.drawing}
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
                annotation?.discard();
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
          {visibleComments.map((comment) => {
            // A stored drawing (issue 1733), validated before anything draws
            // it. The marker needs the lightbox to show it on the photo.
            const drawing = annotation ? parseAnnotation(comment.annotation) : null;
            const drawingShown = annotation?.shownCommentId === comment.id;
            return (
            <div key={comment.id} className="flex gap-3">
              <div className="flex-shrink-0">
                <div className="w-8 h-8 bg-elevated rounded-full flex items-center justify-center">
                  <User className="w-4 h-4 text-muted-theme" />
                </div>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2 mb-1">
                  <span className="text-sm font-medium text-theme">
                    {comment.guest_name || t('feedback.anonymous', 'Anonymous')}
                  </span>
                  <span className="text-xs text-muted-theme">
                    {format(comment.created_at)}
                  </span>
                  {comment.is_mine && !comment.is_approved && (
                    <span className="text-xs text-status hue-warning">
                      {t('feedback.pendingApproval', 'Pending approval')}
                    </span>
                  )}
                </div>
                <p className="text-sm text-muted-theme break-words">
                  {comment.comment_text}
                </p>
                {annotation && drawing && (
                  <button
                    type="button"
                    aria-pressed={drawingShown}
                    onClick={() => annotation.toggleShown(comment.id, drawing)}
                    className={`mt-1 inline-flex items-center gap-1 text-xs rounded px-1.5 py-0.5 border border-border-token transition-colors ${drawingShown ? 'bg-elevated text-theme' : 'text-muted-theme hover-surface'}`}
                  >
                    <Pencil className="w-3 h-3" aria-hidden="true" />
                    {drawingShown
                      ? t('feedback.annotation.hide', 'Hide drawing')
                      : t('feedback.annotation.show', 'Show drawing')}
                  </button>
                )}
              </div>
            </div>
            );
          })}
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
