import { createContext, useContext } from 'react';
import type { PhotoAnnotation } from '../../../utils/photoAnnotation';

/**
 * What the comment form needs from the lightbox to attach a drawing to a
 * comment and to show one (issue 1733). Provided by the standard
 * PhotoLightbox only; anywhere else the comment list is text only.
 */
export interface CommentAnnotationContextValue {
  /** False on a video: there is no still picture to draw on. */
  canDraw: boolean;
  /** The guest is drawing on the photo right now. */
  drawing: boolean;
  /** The finished drawing waiting to be sent with the comment. */
  draft: PhotoAnnotation | null;
  /** Leave drawing mode and drop the draft. */
  discard: () => void;
  /**
   * The comment carrying this draft was stored: drop it, unless the guest
   * has moved on to another drawing since.
   */
  discardSent: (sent: PhotoAnnotation | undefined) => void;
  /**
   * The form reports a comment on its way: the lightbox's Annotate mode
   * stays shut until it is stored or refused.
   */
  setSending: (sending: boolean) => void;
  /** Which comment's drawing is on the photo, if any. */
  shownCommentId: number | null;
  toggleShown: (commentId: number, annotation: PhotoAnnotation) => void;
  /** Take the shown drawing off the photo. */
  hideShown: () => void;
}

export const CommentAnnotationContext = createContext<CommentAnnotationContextValue | null>(null);

export const useCommentAnnotation = () => useContext(CommentAnnotationContext);
