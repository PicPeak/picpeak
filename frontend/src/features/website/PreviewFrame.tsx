/**
 * The website builder's preview (issue 2618): the server's own markup for the
 * draft, in a sandboxed iframe. `allow-same-origin` without `allow-scripts`:
 * nothing in the page runs, and the editor can still read clicks on its
 * sections to select a block. The desktop view is laid out at 1280 px and
 * scaled into the column, the phone view at 390 px.
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

export type PreviewDevice = 'desktop' | 'phone';

const DESKTOP_WIDTH = 1280;
const PHONE_WIDTH = 390;

interface PreviewFrameProps {
  html: string | null;
  device: PreviewDevice;
  selectedBlockId: string | null;
  onSelectBlock: (id: string) => void;
  loading?: boolean;
}

export const PreviewFrame: React.FC<PreviewFrameProps> = ({ html, device, selectedBlockId, onSelectBlock, loading }) => {
  const { t } = useTranslation();
  const container = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const scrollY = useRef(0);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const onSelect = useRef(onSelectBlock);
  onSelect.current = onSelectBlock;
  const selected = useRef(selectedBlockId);
  selected.current = selectedBlockId;

  useLayoutEffect(() => {
    const el = container.current;
    if (!el) return undefined;
    const observer = new ResizeObserver(([entry]) => setBox({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const markSelected = (doc: Document | null | undefined, scroll: boolean) => {
    if (!doc) return;
    doc.querySelectorAll('.pp-selected').forEach((el) => el.classList.remove('pp-selected'));
    if (!selected.current) return;
    const el = doc.querySelector(`[data-block-id="${CSS.escape(selected.current)}"]`);
    if (!el) return;
    el.classList.add('pp-selected');
    if (scroll) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  // A new render replaces the document: keep the reader's place in it.
  const onLoad = () => {
    const doc = frame.current?.contentDocument;
    if (!doc) return;
    if (scrollY.current) frame.current?.contentWindow?.scrollTo(0, scrollY.current);
    doc.addEventListener('click', (event) => {
      // Links and buttons in the preview would navigate the frame away.
      event.preventDefault();
      const target = (event.target as Element | null)?.closest?.('[data-block-id]');
      const id = target?.getAttribute('data-block-id');
      if (id) onSelect.current(id);
    }, true);
    doc.addEventListener('submit', (event) => event.preventDefault(), true);
    frame.current?.contentWindow?.addEventListener('scroll', () => {
      scrollY.current = frame.current?.contentWindow?.scrollY || 0;
    }, { passive: true });
    markSelected(doc, false);
  };

  useEffect(() => {
    markSelected(frame.current?.contentDocument, true);
  }, [selectedBlockId]);

  const width = device === 'phone' ? PHONE_WIDTH : DESKTOP_WIDTH;
  const scale = device === 'phone' ? Math.min(1, box.width / PHONE_WIDTH || 1) : Math.min(1, box.width / DESKTOP_WIDTH || 1);
  const height = scale > 0 ? box.height / scale : box.height;

  return (
    <div ref={container} className="relative flex-1 min-h-[480px] overflow-hidden rounded-xl border border-line bg-inset">
      {html !== null && (
        <div
          className={device === 'phone' ? 'mx-auto' : ''}
          style={{ width: width * scale, height: box.height }}
        >
          <iframe
            ref={frame}
            title={t('website.preview.title', 'Preview of the page')}
            srcDoc={html}
            sandbox="allow-same-origin"
            onLoad={onLoad}
            className={`origin-top-left bg-panel ${device === 'phone' ? 'border-x border-line shadow-lg' : ''}`}
            style={{ width, height, transform: `scale(${scale})` }}
          />
        </div>
      )}
      {(loading || html === null) && (
        <div className="absolute top-3 right-3 rounded-full bg-panel px-3 py-1 text-xs text-muted shadow">
          {t('website.preview.updating', 'Updating preview…')}
        </div>
      )}
    </div>
  );
};
