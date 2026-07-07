import React, { useState } from 'react';
import { Star, Send, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Photo } from '../../../../types';

interface Comment {
  id: string;
  author: string;
  text: string;
  date: string;
}

interface StoryFeedbackSheetProps {
  isOpen: boolean;
  onClose: () => void;
  photo: Photo | null;
  comments: Comment[];
  rating: number;
  onAddComment: (text: string, name?: string, email?: string) => void;
  onRate: (rating: number) => void;
  requireNameEmail?: boolean;
  savedIdentity?: { name: string; email: string } | null;
}

export const StoryFeedbackSheet: React.FC<StoryFeedbackSheetProps> = ({
  isOpen,
  onClose,
  photo,
  comments,
  rating,
  onAddComment,
  onRate,
  requireNameEmail = false,
  savedIdentity
}) => {
  const { t } = useTranslation();
  const [commentText, setCommentText] = useState('');
  const [guestName, setGuestName] = useState(savedIdentity?.name || '');
  const [guestEmail, setGuestEmail] = useState(savedIdentity?.email || '');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (commentText.trim()) {
      if (requireNameEmail && (!guestName.trim() || !guestEmail.trim())) {
        return;
      }
      onAddComment(commentText, guestName || undefined, guestEmail || undefined);
      setCommentText('');
    }
  };

  if (!photo) return null;

  return (
    <>
      {/* Backdrop */}
      {isOpen && (
        <div className="story-backdrop" onClick={onClose} />
      )}

      {/* Sheet */}
      <div className={`story-feedback-sheet ${isOpen ? 'open' : ''}`}>
        <button className="story-feedback-close" onClick={onClose}>
          <X size={20} />
        </button>

        <div className="story-feedback-sheet-header">
          <h3 className="story-feedback-sheet-title">
            {t('gallery.feedback.title', 'Feedback')}
          </h3>
          <p className="story-feedback-sheet-description">
            {t('gallery.feedback.shareThoughts', 'Share your thoughts on "{{name}}"', { name: photo.filename })}
          </p>
        </div>

        <div className="space-y-8">
          {/* Rating Section */}
          <div className="story-feedback-rating">
            <label className="story-feedback-rating-label">
              {t('gallery.feedback.rateThisMoment', 'Rate this moment')}
            </label>
            <div className="story-feedback-rating-stars">
              {[1, 2, 3, 4, 5].map((star) => (
                <button
                  key={star}
                  onClick={() => onRate(star)}
                  className={`story-feedback-rating-star ${star <= rating ? 'active' : ''}`}
                >
                  <Star
                    size={28}
                    strokeWidth={1.5}
                    fill={star <= rating ? 'currentColor' : 'none'}
                  />
                </button>
              ))}
            </div>
          </div>

          {/* Comments List */}
          <div>
            <label className="story-feedback-comments-label">
              {t('gallery.feedback.comments', 'Comments')} ({comments.length})
            </label>

            <div className="story-feedback-comments">
              {comments.length === 0 ? (
                <p className="story-feedback-empty">
                  {t('gallery.feedback.noComments', 'No comments yet. Be the first!')}
                </p>
              ) : (
                comments.map((comment) => (
                  <div key={comment.id} className="story-feedback-comment story-animate-fade-in">
                    <div className="story-feedback-comment-avatar">
                      {comment.author[0]?.toUpperCase() || '?'}
                    </div>
                    <div className="story-feedback-comment-content">
                      <div className="story-feedback-comment-header">
                        <span className="story-feedback-comment-author">{comment.author}</span>
                        <span className="story-feedback-comment-date">{comment.date}</span>
                      </div>
                      <p className="story-feedback-comment-text">{comment.text}</p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Comment Form */}
          <form onSubmit={handleSubmit} className="story-feedback-form">
            {requireNameEmail && !savedIdentity && (
              <div className="space-y-3 mb-3">
                <input
                  type="text"
                  placeholder={t('gallery.feedback.yourName', 'Your name')}
                  value={guestName}
                  onChange={(e) => setGuestName(e.target.value)}
                  className="story-feedback-textarea"
                  style={{ minHeight: 'auto', padding: '0.5rem 0.75rem' }}
                  required
                />
                <input
                  type="email"
                  placeholder={t('gallery.feedback.yourEmail', 'Your email')}
                  value={guestEmail}
                  onChange={(e) => setGuestEmail(e.target.value)}
                  className="story-feedback-textarea"
                  style={{ minHeight: 'auto', padding: '0.5rem 0.75rem' }}
                  required
                />
              </div>
            )}
            <textarea
              placeholder={t('gallery.feedback.writeLovelyNote', 'Write a lovely note...')}
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              className="story-feedback-textarea"
            />
            <button
              type="submit"
              className="story-feedback-submit"
              disabled={!commentText.trim() || (requireNameEmail && !savedIdentity && (!guestName.trim() || !guestEmail.trim()))}
            >
              <Send size={14} />
              {t('gallery.feedback.postComment', 'Post Comment')}
            </button>
          </form>
        </div>
      </div>
    </>
  );
};
