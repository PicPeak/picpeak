import React, { useRef, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Play, Pause, Volume2, VolumeX, Maximize, Minimize, AlertTriangle } from 'lucide-react';

interface VideoPlayerProps {
  src: string;
  poster?: string;
  className?: string;
  autoPlay?: boolean;
  muted?: boolean;
  loop?: boolean;
  controls?: boolean;
  width?: string | number;
  height?: string | number;
  /** The <video> preload hint; the browser's default when omitted. */
  preload?: 'none' | 'metadata' | 'auto';
  /** Called when playback first starts. */
  onPlaybackStart?: () => void;
  /** Called when the source fails to load. */
  onLoadError?: () => void;
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  src,
  poster,
  className = '',
  autoPlay = false,
  muted = false,
  loop = false,
  controls = true,
  width = '100%',
  height = 'auto',
  preload,
  onPlaybackStart,
  onLoadError,
}) => {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(muted);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [showControls, setShowControls] = useState(true);
  const controlsTimeoutRef = useRef<NodeJS.Timeout>();
  // The hide timer reads these instead of state so it sees the value at the
  // moment it fires, not the one captured when the mouse last moved.
  const isPlayingRef = useRef(false);
  const hoveringControlsRef = useRef(false);
  // Read by the listeners below, which are only bound once.
  const onPlaybackStartRef = useRef(onPlaybackStart);
  const onLoadErrorRef = useRef(onLoadError);
  onPlaybackStartRef.current = onPlaybackStart;
  onLoadErrorRef.current = onLoadError;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleTimeUpdate = () => {
      setCurrentTime(video.currentTime);
      setProgress((video.currentTime / video.duration) * 100 || 0);
    };

    const handleLoadedMetadata = () => {
      setDuration(video.duration);
    };

    const handlePlay = () => {
      isPlayingRef.current = true;
      setIsPlaying(true);
      onPlaybackStartRef.current?.();
    };
    // A paused video always shows its controls. Without this, a hide timer
    // armed during playback fired after the pause and left the guest with
    // no visible play or fullscreen button — every click then went to the
    // <video> itself and just toggled playback.
    const handlePause = () => {
      isPlayingRef.current = false;
      if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
      setIsPlaying(false);
      setShowControls(true);
    };
    const handleEnded = () => handlePause();

    // Without this the element just sits on its poster at 0:00 and says
    // nothing (#1370) — a guest cannot tell a failed request from a codec
    // their browser will not decode, and neither could we from their report.
    // MEDIA_ERR_SRC_NOT_SUPPORTED is the one worth naming: it is what an
    // HEVC/H.265 phone recording does everywhere except Safari, and the
    // photographer's answer is to download the file rather than retry.
    const handleError = () => {
      const code = video.error?.code;
      setLoadError(
        code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
          ? t('gallery.videoFormatUnsupported', 'This video format cannot be played in this browser. Download it to watch it.')
          : t('gallery.videoLoadFailed', 'This video could not be loaded.')
      );
      setIsPlaying(false);
      onLoadErrorRef.current?.();
    };

    video.addEventListener('timeupdate', handleTimeUpdate);
    video.addEventListener('loadedmetadata', handleLoadedMetadata);
    video.addEventListener('play', handlePlay);
    video.addEventListener('pause', handlePause);
    video.addEventListener('ended', handleEnded);
    video.addEventListener('error', handleError);

    return () => {
      video.removeEventListener('timeupdate', handleTimeUpdate);
      video.removeEventListener('loadedmetadata', handleLoadedMetadata);
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('ended', handleEnded);
      video.removeEventListener('error', handleError);
    };
  }, [t]);

  // Keep isFullscreen honest when the user leaves through Esc or the native
  // UI rather than our button. Browsers with only the prefixed API (the
  // webkitRequestFullscreen path below) fire webkitfullscreenchange and
  // expose webkitFullscreenElement instead of the standard pair; iOS Safari
  // only tells the <video> itself (webkitendfullscreen). Compare against our
  // own container so another element going fullscreen does not flip us.
  useEffect(() => {
    const video = videoRef.current;
    const handleFullscreenChange = () => {
      const doc = document as Document & { webkitFullscreenElement?: Element | null };
      const active = document.fullscreenElement || doc.webkitFullscreenElement || null;
      setIsFullscreen(active !== null && active === containerRef.current);
    };
    const handleWebkitEnd = () => setIsFullscreen(false);

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    video?.addEventListener('webkitendfullscreen', handleWebkitEnd);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
      video?.removeEventListener('webkitendfullscreen', handleWebkitEnd);
    };
  }, []);

  // Arrowing to the next video in the lightbox reuses this element, so a
  // stale error would otherwise stick to a clip that loads fine.
  useEffect(() => {
    setLoadError(null);
  }, [src]);

  const togglePlayPause = () => {
    const video = videoRef.current;
    if (!video) return;

    if (isPlaying) {
      video.pause();
    } else {
      video.play();
    }
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;

    video.muted = !video.muted;
    setIsMuted(!isMuted);
  };

  const toggleFullscreen = async () => {
    const video = videoRef.current;
    const container = containerRef.current;
    if (!video || !container) return;

    try {
      if (!isFullscreen) {
        // Go fullscreen on the container so our controls come along. iPhone
        // Safari has no Fullscreen API at all — only the video element's
        // webkitEnterFullscreen, which hands off to the native player — so
        // the button did nothing there before this fallback.
        const el = container as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
        const nativeVideo = video as HTMLVideoElement & { webkitEnterFullscreen?: () => void };
        if (el.requestFullscreen) {
          await el.requestFullscreen();
        } else if (el.webkitRequestFullscreen) {
          await el.webkitRequestFullscreen();
        } else if (nativeVideo.webkitEnterFullscreen) {
          nativeVideo.webkitEnterFullscreen();
          return; // state is set by webkitendfullscreen on exit
        }
        setIsFullscreen(true);
      } else {
        const doc = document as Document & { webkitExitFullscreen?: () => Promise<void> | void };
        if (doc.exitFullscreen) {
          await doc.exitFullscreen();
        } else if (doc.webkitExitFullscreen) {
          await doc.webkitExitFullscreen();
        }
        setIsFullscreen(false);
      }
    } catch (error) {
      console.error('Error toggling fullscreen:', error);
    }
  };

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const video = videoRef.current;
    if (!video) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const pos = (e.clientX - rect.left) / rect.width;
    video.currentTime = pos * video.duration;
  };

  const formatTime = (seconds: number): string => {
    if (!seconds || isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const scheduleHideControls = () => {
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }
    controlsTimeoutRef.current = setTimeout(() => {
      // Resting the pointer on the bar must not hide it out from under the
      // cursor — that is where the pointer is when someone is about to
      // click pause or fullscreen.
      if (isPlayingRef.current && !hoveringControlsRef.current) {
        setShowControls(false);
      }
    }, 3000);
  };

  const handleMouseMove = () => {
    setShowControls(true);
    scheduleHideControls();
  };

  const handleControlsMouseEnter = () => {
    hoveringControlsRef.current = true;
    setShowControls(true);
  };

  const handleControlsMouseLeave = () => {
    hoveringControlsRef.current = false;
    scheduleHideControls();
  };

  useEffect(() => {
    return () => {
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
      }
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className={`relative bg-black rounded-lg overflow-hidden ${className}`}
      style={{ width, height: height === 'auto' ? undefined : height }}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => {
        hoveringControlsRef.current = false;
        if (isPlayingRef.current) setShowControls(false);
      }}
    >
      <video
        ref={videoRef}
        src={src}
        poster={poster}
        autoPlay={autoPlay}
        muted={muted}
        loop={loop}
        preload={preload}
        className="w-full h-full object-contain"
        playsInline
        onClick={togglePlayPause}
      />

      {loadError && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/70 p-6 text-center">
          <div className="flex flex-col items-center gap-2 text-white">
            <AlertTriangle size={28} />
            <span className="text-sm max-w-xs">{loadError}</span>
          </div>
        </div>
      )}

      {controls && !loadError && (
        <div
          className={`absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-4 transition-opacity duration-300 ${
            showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
          onMouseEnter={handleControlsMouseEnter}
          onMouseLeave={handleControlsMouseLeave}
        >
          {/* Progress bar */}
          <div
            className="w-full h-1 bg-gray-600 rounded-full cursor-pointer mb-3"
            onClick={handleProgressClick}
          >
            <div
              className="h-full bg-white rounded-full transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>

          {/* Controls */}
          <div className="flex items-center justify-between text-white">
            <div className="flex items-center gap-3">
              <button
                onClick={togglePlayPause}
                className="hover:bg-white/20 p-2 rounded-full transition-colors"
                aria-label={isPlaying ? 'Pause' : 'Play'}
              >
                {isPlaying ? <Pause size={20} /> : <Play size={20} />}
              </button>

              <button
                onClick={toggleMute}
                className="hover:bg-white/20 p-2 rounded-full transition-colors"
                aria-label={isMuted ? 'Unmute' : 'Mute'}
              >
                {isMuted ? <VolumeX size={20} /> : <Volume2 size={20} />}
              </button>

              <span className="text-sm">
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>
            </div>

            <button
              onClick={toggleFullscreen}
              className="hover:bg-white/20 p-2 rounded-full transition-colors"
              aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            >
              {isFullscreen ? <Minimize size={20} /> : <Maximize size={20} />}
            </button>
          </div>
        </div>
      )}

      {/* Play button overlay when paused. It renders after the control bar,
          so it must not capture clicks itself: while paused the fullscreen,
          mute and progress controls were unreachable underneath it, and a
          click on the poster went to this div instead of the <video>. */}
      {!isPlaying && showControls && !loadError && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <button
            onClick={togglePlayPause}
            className="pointer-events-auto bg-black/50 hover:bg-black/70 text-white rounded-full p-6 transition-colors"
            aria-label="Play"
          >
            <Play size={48} fill="white" />
          </button>
        </div>
      )}
    </div>
  );
};

export default VideoPlayer;
