import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ANNOTATION_MAX_STROKES,
  type AnnotationStroke,
  type AnnotationTool,
  type PhotoAnnotation,
} from '../../../utils/photoAnnotation';
import type { CommentAnnotationContextValue } from './CommentAnnotationContext';

interface Options {
  photoId: number | undefined;
  /** A still picture is on screen (not a video). */
  canDraw: boolean;
  /** The feedback panel, which holds the comment form, is open. */
  panelOpen: boolean;
  /** Called when drawing starts: the lightbox resets the image to fit. */
  onStart: () => void;
  /** Called when a stored drawing is put on the photo. */
  onShow: () => void;
}

/**
 * Annotate mode for the lightbox (issue 1733): the strokes being drawn, the
 * finished drawing waiting on the comment form, and the stored drawing a
 * guest picked from the comment list. Kept out of PhotoLightbox so that file
 * only has the integration points.
 */
export function useLightboxAnnotation({ photoId, canDraw, panelOpen, onStart, onShow }: Options) {
  const onShowRef = useRef(onShow);
  onShowRef.current = onShow;
  const [drawing, setDrawing] = useState(false);
  const [strokes, setStrokes] = useState<AnnotationStroke[]>([]);
  const [draft, setDraft] = useState<PhotoAnnotation | null>(null);
  const [shown, setShown] = useState<{ commentId: number; annotation: PhotoAnnotation } | null>(null);
  const [tool, setTool] = useState<AnnotationTool>('free');
  const [color, setColor] = useState(0);
  // A comment is on its way (reported by the comment form). Its success
  // clears the form and the drawing, so no new drawing starts meanwhile.
  const [sending, setSending] = useState(false);

  // A drawing belongs to one photo: another photo drops all of it.
  useEffect(() => {
    setDrawing(false);
    setStrokes([]);
    setDraft(null);
    setShown(null);
  }, [photoId, canDraw]);

  // The comment form lives in the feedback panel, so a draft goes with it
  // when the panel closes. A stored drawing picked from the list stays: on a
  // phone the panel covers the photo and has to be closed to look at it.
  useEffect(() => {
    if (panelOpen) return;
    setDrawing(false);
    setStrokes([]);
    setDraft(null);
  }, [panelOpen]);

  const startDrawing = useCallback(() => {
    if (!canDraw || sending) return;
    setShown(null);
    setStrokes(draft?.strokes ?? []);
    setDrawing(true);
    onStart();
  }, [canDraw, sending, draft, onStart]);

  /** Leave the mode, keeping whatever was attached before it was entered. */
  const cancel = useCallback(() => setDrawing(false), []);

  const done = () => {
    setDraft(strokes.length > 0 ? { v: 1, strokes } : null);
    setDrawing(false);
  };

  const discard = useCallback(() => {
    setDrawing(false);
    setStrokes([]);
    setDraft(null);
  }, []);

  // Called from a request's success handler, which can arrive late: after
  // the panel was closed and reopened, or on another photo. Only the very
  // draft that was sent goes; a drawing made since is not this comment's.
  const discardSent = useCallback((sent: PhotoAnnotation | undefined) => {
    if (sent) setDraft((prev) => (prev === sent ? null : prev));
  }, []);

  const toggleShown = useCallback((commentId: number, annotation: PhotoAnnotation) => {
    if (shown?.commentId === commentId) {
      setShown(null);
      return;
    }
    setShown({ commentId, annotation });
    onShowRef.current();
  }, [shown]);

  const hideShown = useCallback(() => setShown(null), []);

  const atLimit = strokes.length >= ANNOTATION_MAX_STROKES;
  const addStroke = (stroke: AnnotationStroke) => {
    setStrokes((prev) => (prev.length >= ANNOTATION_MAX_STROKES ? prev : [...prev, stroke]));
  };

  const context = useMemo<CommentAnnotationContextValue>(() => ({
    canDraw,
    drawing,
    draft,
    discard,
    discardSent,
    setSending,
    shownCommentId: shown?.commentId ?? null,
    toggleShown,
    hideShown,
  }), [canDraw, drawing, draft, discard, discardSent, shown, toggleShown, hideShown]);

  // What lies on the photo: the strokes in progress, else the drawing picked
  // from the comment list, else the one waiting on the comment form.
  const visible: PhotoAnnotation | null = drawing
    ? (strokes.length > 0 ? { v: 1, strokes } : null)
    : shown?.annotation ?? draft;

  return {
    /** Drawing can start now: a still picture, and no comment on its way. */
    canStart: canDraw && !sending,
    drawing,
    startDrawing,
    cancel,
    done,
    strokes,
    atLimit,
    addStroke,
    undo: () => setStrokes((prev) => prev.slice(0, -1)),
    clear: () => setStrokes([]),
    tool,
    setTool,
    color,
    setColor,
    visible,
    context,
  };
}

export type LightboxAnnotation = ReturnType<typeof useLightboxAnnotation>;
