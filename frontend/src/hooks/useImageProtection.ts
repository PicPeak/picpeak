import { useEffect, useRef, useCallback } from 'react';

type VendorStyle = CSSStyleDeclaration & {
  webkitUserSelect?: string;
  webkitTouchCallout?: string;
  webkitUserDrag?: string;
  MozAppearance?: string;
  webkitAppearance?: string;
};

export type ProtectionLevel = 'basic' | 'standard' | 'enhanced' | 'maximum';

interface UseImageProtectionOptions {
  enabled: boolean;
  onAttemptedDownload?: () => void;
  onProtectionViolation?: (violationType: string) => void;
  protectionLevel?: ProtectionLevel;
  useCanvasRendering?: boolean;
  overlayProtection?: boolean;
  blockKeyboardShortcuts?: boolean;
  detectPrintScreen?: boolean;
  watermarkText?: string;
  fragmentGrid?: boolean;
}

export const useImageProtection = (options: UseImageProtectionOptions) => {
  const elementRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const printScreenDetectorRef = useRef<HTMLCanvasElement | null>(null);
  const printScreenIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const reportViolation = useCallback((violationType: string) => {
    options.onAttemptedDownload?.();
    options.onProtectionViolation?.(violationType);
  }, [options]);

  // Enhanced print screen detection
  const detectPrintScreen = useCallback(() => {
    if (!options.detectPrintScreen || options.protectionLevel === 'basic') return;

    try {
      if (!printScreenDetectorRef.current) {
        printScreenDetectorRef.current = document.createElement('canvas');
        printScreenDetectorRef.current.width = 1;
        printScreenDetectorRef.current.height = 1;
        printScreenDetectorRef.current.style.position = 'absolute';
        printScreenDetectorRef.current.style.left = '-9999px';
        printScreenDetectorRef.current.style.top = '-9999px';
        document.body.appendChild(printScreenDetectorRef.current);
      }

      const canvas = printScreenDetectorRef.current;
      const ctx = canvas.getContext('2d');
      
      if (!ctx) return;

      // Fill with a specific pattern
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, 1, 1);
      
      // Try to read the pixel data
      try {
        const imageData = ctx.getImageData(0, 0, 1, 1);
        const data = imageData.data;
        
        // Check if data was modified (some screenshot tools modify canvas data)
        if (data[0] !== 255 || data[1] !== 255 || data[2] !== 255) {
          reportViolation('print_screen_detected');
        }
      } catch (e) {
        // Canvas data access blocked - possible screenshot attempt
        reportViolation('canvas_access_blocked');
      }
    } catch (error) {
      // Silently handle detection errors
    }
  }, [options.detectPrintScreen, options.protectionLevel, reportViolation]);

  // Enhanced keyboard shortcut detection
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!options.blockKeyboardShortcuts || options.protectionLevel === 'basic') return;

    const isBlocked = 
      // Developer tools
      e.key === 'F12' ||
      (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'J' || e.key === 'C')) ||
      // View source
      (e.ctrlKey && e.key === 'u') ||
      (e.ctrlKey && e.key === 'U') ||
      // Save page/image
      (e.ctrlKey && e.key === 's') ||
      (e.ctrlKey && e.key === 'S') ||
      // Print
      (e.ctrlKey && e.key === 'p') ||
      (e.ctrlKey && e.key === 'P') ||
      // Print Screen
      e.key === 'PrintScreen' ||
      // Select all
      (e.ctrlKey && e.key === 'a') ||
      (e.ctrlKey && e.key === 'A') ||
      // Copy
      (e.ctrlKey && e.key === 'c') ||
      (e.ctrlKey && e.key === 'C') ||
      // Enhanced protection: additional shortcuts
      (options.protectionLevel === 'enhanced' || options.protectionLevel === 'maximum') && (
        // Find
        (e.ctrlKey && e.key === 'f') ||
        (e.ctrlKey && e.key === 'F') ||
        // Zoom
        (e.ctrlKey && (e.key === '+' || e.key === '-' || e.key === '0')) ||
        // Function keys that might trigger actions
        ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11'].includes(e.key)
      ) ||
      // Maximum protection: block almost everything
      options.protectionLevel === 'maximum' && (
        e.ctrlKey || e.altKey || e.metaKey || 
        ['Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)
      );

    if (isBlocked) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      reportViolation(`keyboard_shortcut_${e.key}_${e.ctrlKey ? 'ctrl_' : ''}${e.shiftKey ? 'shift_' : ''}${e.altKey ? 'alt_' : ''}`);
      return false;
    }
  }, [options.blockKeyboardShortcuts, options.protectionLevel, reportViolation]);

  useEffect(() => {
    if (!options.enabled || !elementRef.current) return;

    const element = elementRef.current;
    const protectionLevel = options.protectionLevel || 'standard';

    // Basic protection events
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      reportViolation('context_menu');
      return false;
    };

    const handleDragStart = (e: DragEvent) => {
      e.preventDefault();
      reportViolation('drag_start');
      return false;
    };

    const handleSelectStart = (e: Event) => {
      e.preventDefault();
      reportViolation('text_selection');
      return false;
    };

    // Enhanced visibility change detection
    const handleVisibilityChange = () => {
      if (protectionLevel === 'maximum' && document.hidden) {
        // Page became hidden - might be screenshot attempt
        setTimeout(() => {
          if (!document.hidden) {
            reportViolation('suspicious_visibility_change');
          }
        }, 100);
      }
    };

    // Detect copy attempts through clipboard API
    const handleCopy = (e: ClipboardEvent) => {
      if (protectionLevel !== 'basic') {
        e.preventDefault();
        e.stopPropagation();
        reportViolation('clipboard_copy');
        return false;
      }
    };

    // Detect paste attempts (might be used to extract data)
    const handlePaste = (e: ClipboardEvent) => {
      if (protectionLevel === 'enhanced' || protectionLevel === 'maximum') {
        e.preventDefault();
        reportViolation('clipboard_paste');
        return false;
      }
    };

    // Add basic event listeners
    element.addEventListener('contextmenu', handleContextMenu);
    element.addEventListener('dragstart', handleDragStart);
    element.addEventListener('selectstart', handleSelectStart);

    // Add enhanced event listeners
    if (protectionLevel !== 'basic') {
      document.addEventListener('keydown', handleKeyDown, true);
      document.addEventListener('visibilitychange', handleVisibilityChange);
      document.addEventListener('copy', handleCopy, true);
      document.addEventListener('paste', handlePaste, true);
      
      // Start print screen detection
      if (options.detectPrintScreen && (protectionLevel === 'enhanced' || protectionLevel === 'maximum')) {
        const interval = protectionLevel === 'maximum' ? 50 : 100;
        printScreenIntervalRef.current = setInterval(detectPrintScreen, interval);
      }
    }

    // CSS protection
    const elementStyle = element.style as VendorStyle;
    elementStyle.userSelect = 'none';
    elementStyle.webkitUserSelect = 'none';
    elementStyle.webkitTouchCallout = 'none';
    elementStyle.pointerEvents = 'auto';
    elementStyle.webkitUserDrag = 'none';
    element.draggable = false;

    // Enhanced CSS protection
    if (protectionLevel !== 'basic') {
      elementStyle.outline = 'none';
      elementStyle.webkitAppearance = 'none';
      elementStyle.MozAppearance = 'none';
      
      // Disable text selection on parent elements
      let parent = element.parentElement;
      while (parent) {
        const parentStyle = parent.style as VendorStyle;
        parentStyle.userSelect = 'none';
        parentStyle.webkitUserSelect = 'none';
        parent = parent.parentElement;
      }
    }

    // Create overlay protection
    if (options.overlayProtection && protectionLevel !== 'basic') {
      const overlay = document.createElement('div');
      overlay.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: transparent;
        z-index: 1;
        pointer-events: none;
      `;
      
      // Position relative container
      const container = element.parentElement;
      if (container) {
        container.style.position = 'relative';
        container.appendChild(overlay);
        overlayRef.current = overlay;
      }
    }

    // Cleanup function
    return () => {
      element.removeEventListener('contextmenu', handleContextMenu);
      element.removeEventListener('dragstart', handleDragStart);
      element.removeEventListener('selectstart', handleSelectStart);
      
      if (protectionLevel !== 'basic') {
        document.removeEventListener('keydown', handleKeyDown, true);
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        document.removeEventListener('copy', handleCopy, true);
        document.removeEventListener('paste', handlePaste, true);
      }
      
      // Clear print screen detection interval
      if (printScreenIntervalRef.current) {
        clearInterval(printScreenIntervalRef.current);
      }
      
      // Remove print screen detector canvas
      if (printScreenDetectorRef.current && printScreenDetectorRef.current.parentElement) {
        printScreenDetectorRef.current.parentElement.removeChild(printScreenDetectorRef.current);
      }
      
      // Remove overlay
      if (overlayRef.current && overlayRef.current.parentElement) {
        overlayRef.current.parentElement.removeChild(overlayRef.current);
      }
    };
  }, [
    options.enabled,
    options.onAttemptedDownload,
    options.onProtectionViolation,
    options.protectionLevel,
    options.overlayProtection,
    options.blockKeyboardShortcuts,
    options.detectPrintScreen,
    reportViolation,
    handleKeyDown,
    detectPrintScreen
  ]);

  return {
    elementRef,
    canvasRef,
    overlayRef
  };
};
