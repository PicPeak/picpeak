import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '../../common';
import { useGalleryDialog } from '../hooks/useGalleryDialog';
import type { WalkthroughStep } from './walkthroughSteps';

interface GalleryWalkthroughProps {
  open: boolean;
  steps: WalkthroughStep[];
  /**
   * Point at the real controls where the layout has them (the standard
   * layouts). False gives centered cards throughout (Premium, Story).
   */
  anchored: boolean;
  onClose: () => void;
  /** The dialog is on screen (each time it opens). */
  onShown?: () => void;
}

// Coach marks from Tailwind's `md` up; below it simple centered cards.
const DESKTOP_QUERY = '(min-width: 768px)';
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const MARGIN = 16;
const GAP = 12;
const RING_PADDING = 6;

function mediaMatches(query: string): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(query).matches;
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => mediaMatches(query));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener?.('change', update);
    return () => list.removeEventListener?.('change', update);
  }, [query]);
  return matches;
}

/** The first element of the selectors that is actually on screen. */
export function findWalkthroughAnchor(selectors: string[]): HTMLElement | null {
  for (const selector of selectors) {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (el.closest('[inert], [aria-hidden="true"]')) continue;
      if (window.getComputedStyle(el).visibility === 'hidden') continue;
      return el;
    }
  }
  return null;
}

interface Box { top: number; left: number; width: number; height: number }

const toBox = (rect: DOMRect): Box => ({ top: rect.top, left: rect.left, width: rect.width, height: rect.height });

/** Below the target when it fits, else above, else as close as the viewport allows. */
function placeCard(target: Box, card: { width: number; height: number }, vw: number, vh: number) {
  const below = target.top + target.height + GAP;
  const above = target.top - GAP - card.height;
  let top: number;
  if (below + card.height <= vh - MARGIN) top = below;
  else if (above >= MARGIN) top = above;
  else top = Math.max(MARGIN, vh - card.height - MARGIN);
  const centered = target.left + target.width / 2 - card.width / 2;
  const left = Math.min(Math.max(MARGIN, centered), Math.max(MARGIN, vw - card.width - MARGIN));
  return { top, left };
}

/**
 * The first-visit walkthrough (issue 2551): a few short steps for the
 * features this gallery offers. From `md` up, in a layout that has the
 * controls, each step is a card next to the real button with a ring around
 * it; a step whose control is not on screen, a phone, and the full-page
 * layouts get a centered card.
 *
 * A dialog: focus moves into it and stays there, Escape skips the tour,
 * the arrow keys go back and forth, and focus returns to where it was.
 */
export const GalleryWalkthrough: React.FC<GalleryWalkthroughProps> = ({ open, steps, anchored, onClose, onShown }) => {
  const { t } = useTranslation();
  const [index, setIndex] = useState(0);
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
  const panelRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const [target, setTarget] = useState<Box | null>(null);
  const [cardSize, setCardSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    if (open) setIndex(0);
  }, [open]);

  const shown = open && steps.length > 0;
  const onShownRef = useRef(onShown);
  onShownRef.current = onShown;
  useEffect(() => {
    if (shown) onShownRef.current?.();
  }, [shown]);
  useGalleryDialog({ open: shown, onClose, panelRef, initialFocusRef: primaryRef });

  const current = steps[Math.min(index, steps.length - 1)];
  const coach = shown && anchored && isDesktop && !!current && current.anchors.length > 0;

  // Find the step's control, bring it on screen, and follow it while the
  // page scrolls or resizes.
  useEffect(() => {
    if (!coach || !current) {
      setTarget(null);
      return;
    }
    const el = findWalkthroughAnchor(current.anchors);
    if (!el) {
      setTarget(null);
      return;
    }
    const rect = el.getBoundingClientRect();
    if ((rect.top < 0 || rect.bottom > window.innerHeight) && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' });
    }
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setTarget(el.isConnected ? toBox(el.getBoundingClientRect()) : null);
      });
    };
    measure();
    window.addEventListener('scroll', measure, { capture: true, passive: true });
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', measure, { capture: true });
      window.removeEventListener('resize', measure);
    };
  }, [coach, current, reducedMotion]);

  useLayoutEffect(() => {
    if (!shown || !panelRef.current) return;
    const rect = panelRef.current.getBoundingClientRect();
    setCardSize((prev) => (prev && prev.width === rect.width && prev.height === rect.height
      ? prev
      : { width: rect.width, height: rect.height }));
  }, [shown, index, target]);

  // Keep the focus on the card's main button as the steps change.
  useEffect(() => {
    if (shown && panelRef.current && !panelRef.current.contains(document.activeElement)) {
      primaryRef.current?.focus();
    }
  }, [shown, index]);

  const isLast = index >= steps.length - 1;
  const next = useCallback(() => {
    if (isLast) onClose();
    else setIndex((i) => Math.min(i + 1, steps.length - 1));
  }, [isLast, onClose, steps.length]);
  const back = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  if (!shown || !current) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      next();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      back();
    }
  };

  const anchoredBox = coach && target;
  let cardStyle: React.CSSProperties;
  if (anchoredBox && cardSize) {
    const { top, left } = placeCard(target, cardSize, window.innerWidth, window.innerHeight);
    cardStyle = { top, left };
  } else {
    cardStyle = { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };
  }
  const motion = reducedMotion ? '' : 'transition-[top,left,width,height] duration-200 ease-out';

  return createPortal(
    <div className="fixed inset-0 z-[90]" data-testid="gallery-walkthrough">
      {anchoredBox ? (
        <div
          aria-hidden="true"
          data-testid="gallery-walkthrough-ring"
          className={`fixed rounded-lg pointer-events-none ${motion}`}
          style={{
            top: target.top - RING_PADDING,
            left: target.left - RING_PADDING,
            width: target.width + RING_PADDING * 2,
            height: target.height + RING_PADDING * 2,
            boxShadow: '0 0 0 3px var(--color-accent, #5c8762), 0 0 0 9999px rgba(0, 0, 0, 0.5)',
          }}
        />
      ) : (
        <div aria-hidden="true" className="absolute inset-0 bg-black/50" />
      )}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        onKeyDown={onKeyDown}
        className={`card-themed text-theme fixed p-5 shadow-xl ${motion}`}
        style={{ ...cardStyle, width: `min(360px, calc(100vw - ${MARGIN * 2}px))` }}
      >
        <p className="text-xs font-medium text-muted-theme" aria-live="polite">
          {t('gallery.walkthrough.stepOf', 'Step {{current}} of {{total}}', { current: index + 1, total: steps.length })}
        </p>
        <h2 id={titleId} className="mt-1 text-lg font-semibold text-theme">{t(current.titleKey)}</h2>
        <p id={bodyId} className="mt-1 text-sm text-muted-theme">{t(current.bodyKey)}</p>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          {!isLast ? (
            <Button variant="ghost" size="sm" onClick={onClose}>
              {t('gallery.walkthrough.skip', 'Skip')}
            </Button>
          ) : <span />}
          <div className="flex gap-2">
            {index > 0 && (
              <Button variant="outline" size="sm" onClick={back}>
                {t('gallery.walkthrough.back', 'Back')}
              </Button>
            )}
            <Button ref={primaryRef} variant="primary" size="sm" onClick={next}>
              {isLast ? t('gallery.walkthrough.done', 'Got it') : t('gallery.walkthrough.next', 'Next')}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
};
