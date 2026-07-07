import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { galleryService } from '../../services/gallery.service';
import { slideshowService, type SlideshowSettings } from '../../services/slideshow.service';
import { storeGalleryToken, setActiveGallerySlug } from '../../utils/galleryAuthStorage';
import { buildResourceUrl } from '../../utils/url';
import type { Photo } from '../../types';

const DEFAULT_SETTINGS: SlideshowSettings = {
  interval_ms: 5000,
  transition: 'crossfade',
  transition_ms: 800,
  colorfilter: 'none',
  fit: 'cover',
  watermark: null,
};

// How often the running show re-checks settings + photo count (tiny payload).
const STATE_POLL_MS = 3000;

// Prefer the aspect-preserved preview (≤1920px) over the full original; fall
// back to the standard url. Always absolutised so it works whether the API is
// same-origin or an explicit absolute base.
function photoSrc(photo: Photo): string {
  return buildResourceUrl(photo.preview_url || photo.hero_url || photo.url);
}

// CSS `filter` applied directly to the image for filters that are pure tone
// adjustments. Tint/vignette filters are drawn as a separate overlay instead.
function imageFilter(colorfilter: SlideshowSettings['colorfilter']): string {
  switch (colorfilter) {
    case 'bw': return 'grayscale(1)';
    case 'sepia': return 'sepia(0.75)';
    default: return 'none';
  }
}

// Overlay for tint/vignette filters (drawn above the image, below the
// watermark). Returns null when the filter needs no overlay.
function colorOverlayStyle(colorfilter: SlideshowSettings['colorfilter']): React.CSSProperties | null {
  switch (colorfilter) {
    case 'warm':
      return { background: 'rgba(255, 160, 60, 0.18)', mixBlendMode: 'soft-light' };
    case 'cool':
      return { background: 'rgba(60, 140, 255, 0.18)', mixBlendMode: 'soft-light' };
    case 'vignette':
      return { background: 'radial-gradient(ellipse at center, rgba(0,0,0,0) 55%, rgba(0,0,0,0.55) 100%)' };
    default:
      return null;
  }
}

function watermarkCorner(position: string): React.CSSProperties {
  const pad = '4vmin';
  switch (position) {
    case 'top-left': return { top: pad, left: pad };
    case 'top-right': return { top: pad, right: pad };
    case 'bottom-left': return { bottom: pad, left: pad };
    case 'bottom-right':
    default: return { bottom: pad, right: pad };
  }
}

type Phase = 'splash' | 'running' | 'ended';

export function SlideshowPage() {
  const { slug = '', token = '' } = useParams<{ slug: string; token: string }>();
  const { t } = useTranslation();

  const [phase, setPhase] = useState<Phase>('splash');
  const [error, setError] = useState<string | null>(null);
  const [eventName, setEventName] = useState<string>('');
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [settings, setSettings] = useState<SlideshowSettings>(DEFAULT_SETTINGS);

  // Two-buffer crossfade: each buffer holds an index into `photos`. `active`
  // says which buffer is on top. Advancing loads the next index into the
  // hidden buffer, then flips `active` so CSS opacity transitions it in.
  const [buffers, setBuffers] = useState<[number, number]>([0, 0]);
  const [active, setActive] = useState<0 | 1>(0);
  const [cursorHidden, setCursorHidden] = useState(false);
  // Bumped on each dip transition to re-trigger the white/black flash overlay.
  const [flash, setFlash] = useState(0);

  // Refs so timers/pollers read the latest value without re-subscribing.
  const photosRef = useRef<Photo[]>(photos);
  const settingsRef = useRef<SlideshowSettings>(settings);
  const activeRef = useRef<0 | 1>(active);
  const positionRef = useRef(0); // index currently shown in the active buffer
  photosRef.current = photos;
  settingsRef.current = settings;
  activeRef.current = active;

  // ----- New uploads APPEND quietly: keep existing order/position, only add. -----
  const mergePhotos = useCallback((incoming: Photo[]) => {
    setPhotos((prev) => {
      if (prev.length === 0) return incoming;
      const seen = new Set(prev.map((p) => p.id));
      const added = incoming.filter((p) => !seen.has(p.id));
      return added.length ? [...prev, ...added] : prev;
    });
  }, []);

  const loadPhotos = useCallback(async () => {
    const data = await galleryService.getGalleryPhotos(slug);
    mergePhotos(data.photos || []);
  }, [slug, mergePhotos]);

  // Fetch + fully decode an image so the next swap paints instantly (decode()
  // forces the browser to rasterise it now rather than on first display, which
  // is what otherwise makes the transition stutter). Best-effort.
  const preloadDecode = useCallback(async (photo?: Photo) => {
    if (!photo) return;
    try {
      const img = new Image();
      img.src = photoSrc(photo);
      if (img.decode) await img.decode();
    } catch {
      /* decode can reject on cache/abort — harmless, the <img> still loads */
    }
  }, []);

  // ----- Advance one slide (wraps at the end). -----
  const advance = useCallback(() => {
    const list = photosRef.current;
    if (list.length < 2) return;
    const next = (positionRef.current + 1) % list.length;
    positionRef.current = next;
    const swap = () => {
      const hidden: 0 | 1 = activeRef.current === 0 ? 1 : 0;
      setBuffers((prev) => {
        const updated: [number, number] = [...prev] as [number, number];
        updated[hidden] = next;
        return updated;
      });
      setActive(hidden);
    };
    const tr = settingsRef.current.transition;
    if (tr === 'dipwhite' || tr === 'dipblack') {
      // Dip: start the white/black flash now, and swap the image at the flash
      // PEAK (fully opaque) so the cut is hidden — otherwise the new image is
      // visible before the flash covers it, which reads as a flicker.
      setFlash((f) => f + 1);
      window.setTimeout(swap, Math.max(100, settingsRef.current.transition_ms) / 2);
    } else {
      swap();
    }
  }, []);

  // ----- Start: gesture-driven (fullscreen needs a user gesture). -----
  const start = useCallback(async () => {
    try {
      setError(null);
      const session = await slideshowService.getSession(slug, token);
      // Store the minted token so XHR photo calls carry it; the cookie set by
      // /session covers <img> requests.
      storeGalleryToken(slug, session.token);
      setActiveGallerySlug(slug);
      setEventName(session.event.event_name || '');
      setSettings(session.settings || DEFAULT_SETTINGS);

      // Load the list and DECODE the first slide (and the next) before we flip
      // to running, so playback starts on an already-rasterised image instead
      // of struggling on the first transition.
      const data = await galleryService.getGalleryPhotos(slug);
      const list = data.photos || [];
      setPhotos(list);
      await preloadDecode(list[0]);
      void preloadDecode(list[1]);
      positionRef.current = 0;
      setBuffers([0, 0]);
      setActive(0);
      setPhase('running');

      // Enter fullscreen (best-effort — projector/kiosk; ignore if blocked).
      try {
        await document.documentElement.requestFullscreen?.();
      } catch {
        /* fullscreen denied — keep running windowed */
      }
    } catch (e: any) {
      if (e?.response?.status === 404) {
        setError(t('slideshow.notFound', 'This slideshow link is not active.'));
      } else {
        setError(t('slideshow.startFailed', 'Could not start the slideshow. Please try again.'));
      }
    }
  }, [slug, token, preloadDecode, t]);

  // ----- Auto-advance timer (restarts when interval or photo count changes). -----
  useEffect(() => {
    if (phase !== 'running') return;
    if (photos.length < 2) return;
    const id = window.setInterval(advance, Math.max(1000, settings.interval_ms));
    return () => window.clearInterval(id);
  }, [phase, photos.length, settings.interval_ms, advance]);

  // ----- Live poll: settings changes + new uploads + link death. -----
  useEffect(() => {
    if (phase !== 'running') return;
    let cancelled = false;
    const id = window.setInterval(async () => {
      try {
        const state = await slideshowService.getState(slug, token);
        if (cancelled) return;
        const prev = settingsRef.current;
        const next: SlideshowSettings = {
          interval_ms: state.interval_ms,
          transition: state.transition,
          transition_ms: state.transition_ms,
          colorfilter: state.colorfilter,
          fit: state.fit,
          watermark: state.watermark,
        };
        if (JSON.stringify(next) !== JSON.stringify({
          interval_ms: prev.interval_ms,
          transition: prev.transition,
          transition_ms: prev.transition_ms,
          colorfilter: prev.colorfilter,
          fit: prev.fit,
          watermark: prev.watermark,
        })) {
          setSettings(next);
        }
        if (state.photo_count !== photosRef.current.length) {
          await loadPhotos();
        }
      } catch (e: any) {
        if (cancelled) return;
        if (e?.response?.status === 404) {
          // Admin disabled/rotated the link, or the gallery expired.
          setPhase('ended');
        }
        // Other errors (transient network): ignore and keep showing.
      }
    }, STATE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [phase, slug, token, loadPhotos]);

  // ----- Decode-ahead the next 1–2 images so transitions don't pop. -----
  useEffect(() => {
    if (phase !== 'running' || photos.length === 0) return;
    for (let i = 1; i <= 2; i++) {
      void preloadDecode(photos[(positionRef.current + i) % photos.length]);
    }
  }, [phase, photos, buffers, preloadDecode]);

  // ----- Auto-hide the cursor after inactivity. -----
  useEffect(() => {
    if (phase !== 'running') return;
    let timer: number;
    const onMove = () => {
      setCursorHidden(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setCursorHidden(true), 3000);
    };
    onMove();
    window.addEventListener('mousemove', onMove);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.clearTimeout(timer);
    };
  }, [phase]);

  const isDip = settings.transition === 'dipwhite' || settings.transition === 'dipblack';
  // Dip & cut swap instantly under the flash; the others crossfade.
  const bufferMs = settings.transition === 'cut' || isDip ? 0 : Math.max(0, settings.transition_ms);

  const bufferStyle = (buf: 0 | 1): React.CSSProperties => {
    const isActive = active === buf;
    const base: React.CSSProperties = {
      position: 'absolute',
      inset: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      opacity: isActive ? 1 : 0,
      transition: `opacity ${bufferMs}ms ease-in-out, transform ${bufferMs}ms ease-in-out`,
    };
    if (settings.transition === 'slide') {
      base.transform = isActive ? 'translateX(0)' : 'translateX(6%)';
    }
    return base;
  };

  const imgStyle = (buf: 0 | 1): React.CSSProperties => {
    const isActive = active === buf;
    const style: React.CSSProperties = {
      // Pin to the full viewport (maxWidth/maxHeight alone left the <img> at the
      // photo's intrinsic ≤1920px size, so it never scaled up to the projector).
      // `fit` decides the rest: 'cover' fills + crops, 'contain' letterboxes the
      // whole image with black bars (no crop — kinder to portrait photos).
      width: '100%',
      height: '100%',
      objectFit: settings.fit === 'contain' ? 'contain' : 'cover',
      filter: imageFilter(settings.colorfilter),
    };
    if (settings.transition === 'kenburns' && isActive) {
      style.animation = `picpeak-kenburns ${Math.max(2000, settings.interval_ms)}ms ease-out forwards`;
    }
    return style;
  };

  const renderBuffer = (buf: 0 | 1) => {
    const idx = buffers[buf];
    const photo = photos[idx];
    if (!photo) return null;
    return (
      <div style={bufferStyle(buf)}>
        <img src={photoSrc(photo)} alt="" style={imgStyle(buf)} draggable={false} />
      </div>
    );
  };

  const overlay = colorOverlayStyle(settings.colorfilter);
  const watermarkUrl = settings.watermark ? buildResourceUrl(settings.watermark.url) : null;

  const containerStyle: React.CSSProperties = useMemo(
    () => ({
      position: 'fixed',
      inset: 0,
      background: '#000',
      overflow: 'hidden',
      cursor: cursorHidden ? 'none' : 'default',
      userSelect: 'none',
    }),
    [cursorHidden]
  );

  return (
    <div style={containerStyle}>
      <style>{`
        @keyframes picpeak-kenburns {
          0%   { transform: scale(1)    translate(0, 0); }
          100% { transform: scale(1.12) translate(-2%, -2%); }
        }
        @keyframes picpeak-dip {
          0%   { opacity: 0; }
          50%  { opacity: 1; }
          100% { opacity: 0; }
        }
      `}</style>

      {phase === 'splash' && (
        <div
          onClick={start}
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
            cursor: 'pointer',
            textAlign: 'center',
            padding: 24,
          }}
        >
          <div style={{ fontSize: 64, lineHeight: 1, marginBottom: 24 }}>▶</div>
          <div style={{ fontSize: 24, fontWeight: 600 }}>
            {t('slideshow.start', 'Start slideshow')}
          </div>
          {eventName && <div style={{ fontSize: 16, opacity: 0.7, marginTop: 8 }}>{eventName}</div>}
          {error && <div style={{ color: '#f87171', marginTop: 24, fontSize: 16 }}>{error}</div>}
        </div>
      )}

      {phase === 'running' && photos.length === 0 && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
            opacity: 0.6,
            fontSize: 20,
          }}
        >
          {t('slideshow.waiting', 'Waiting for photos…')}
        </div>
      )}

      {phase === 'running' && photos.length > 0 && (
        <>
          {renderBuffer(0)}
          {renderBuffer(1)}

          {/* Tint / vignette overlay */}
          {overlay && <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', ...overlay }} />}

          {/* Dip-to-white / dip-to-black flash (re-keyed each advance) */}
          {isDip && flash > 0 && (
            <div
              key={flash}
              style={{
                position: 'absolute',
                inset: 0,
                pointerEvents: 'none',
                background: settings.transition === 'dipwhite' ? '#fff' : '#000',
                // Base opacity 0 so that BEFORE and AFTER the one-shot animation
                // (animation-fill-mode defaults to none) the overlay is fully
                // transparent. Without this it reverted to opacity 1 and stayed
                // opaque between slides, hiding the image repeatedly.
                opacity: 0,
                animation: `picpeak-dip ${Math.max(200, settings.transition_ms)}ms ease-in-out`,
              }}
            />
          )}

          {/* ZDF/ARD-ident-style watermark: white, semi-transparent corner logo */}
          {watermarkUrl && (
            <img
              src={watermarkUrl}
              alt=""
              draggable={false}
              style={{
                position: 'absolute',
                ...watermarkCorner(settings.watermark!.position),
                width: 'auto',
                height: 'auto',
                // Size = % of the viewport's shorter side (vmin), so the logo
                // scales the same on any screen. Configured globally.
                maxWidth: `${settings.watermark!.size ?? 12}vmin`,
                maxHeight: `${settings.watermark!.size ?? 12}vmin`,
                opacity: Math.min(1, Math.max(0, (settings.watermark!.opacity ?? 60) / 100)),
                // 'white' recolors the logo white (dark/transparent marks); 'original'
                // leaves a boxed/colored logo as-is so it doesn't become a white blob.
                filter: settings.watermark!.style === 'original' ? 'none' : 'brightness(0) invert(1)',
                pointerEvents: 'none',
              }}
            />
          )}
        </>
      )}

      {phase === 'ended' && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
            opacity: 0.7,
            fontSize: 20,
          }}
        >
          {t('slideshow.ended', 'Slideshow ended.')}
        </div>
      )}
    </div>
  );
}

export default SlideshowPage;
