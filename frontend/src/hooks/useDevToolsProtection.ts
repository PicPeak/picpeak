import { useEffect, useCallback, useRef } from 'react';

interface UseDevToolsProtectionOptions {
  enabled: boolean;
  onDevToolsDetected?: () => void;
  redirectOnDetection?: boolean;
  redirectUrl?: string;
  detectionSensitivity?: 'low' | 'medium' | 'high';
}

export const useDevToolsProtection = (options: UseDevToolsProtectionOptions) => {
  const detectionTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastConsoleCountRef = useRef(0);
  const isDetectedRef = useRef(false);

  const handleDevToolsDetected = useCallback(() => {
    if (isDetectedRef.current) return; // Prevent multiple triggers
    isDetectedRef.current = true;

    console.clear(); // Clear any console output
    options.onDevToolsDetected?.();

    if (options.redirectOnDetection) {
      const redirectUrl = options.redirectUrl || '/';
      setTimeout(() => {
        window.location.href = redirectUrl;
      }, 100);
    }
  }, [options]);

  const detectByTiming = useCallback(() => {
    const threshold = options.detectionSensitivity === 'high' ? 100 : 
                     options.detectionSensitivity === 'medium' ? 200 : 500;

    const start = performance.now();
    
    // This will be slow if DevTools is open due to console.log overhead
    console.log('%c', 'color: transparent; font-size: 0px;');
    console.clear();
    
    const end = performance.now();
    
    if (end - start > threshold) {
      handleDevToolsDetected();
    }
  }, [options.detectionSensitivity, handleDevToolsDetected]);

  const detectByWindowSize = useCallback(() => {
    const heightThreshold = window.screen.height - window.innerHeight > 200;
    const widthThreshold = window.screen.width - window.innerWidth > 200;
    
    // Check if the available space suggests DevTools is open
    if (heightThreshold || widthThreshold) {
      // Additional check to avoid false positives (mobile keyboards, etc.)
      if (window.outerHeight - window.innerHeight > 100 || 
          window.outerWidth - window.innerWidth > 100) {
        handleDevToolsDetected();
      }
    }
  }, [handleDevToolsDetected]);

  const detectByConsole = useCallback(() => {
    let consoleCount = 0;
    
    // Override console methods to detect usage
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;
    const originalInfo = console.info;
    
    console.log = (...args) => {
      consoleCount++;
      return originalLog.apply(console, args);
    };
    
    console.error = (...args) => {
      consoleCount++;
      return originalError.apply(console, args);
    };
    
    console.warn = (...args) => {
      consoleCount++;
      return originalWarn.apply(console, args);
    };
    
    console.info = (...args) => {
      consoleCount++;
      return originalInfo.apply(console, args);
    };
    
    // Test if console is being actively used
    console.log('%cDevTools Detection', 'color: transparent; font-size: 0px;');
    
    // If console count increased significantly, DevTools might be open
    if (consoleCount > lastConsoleCountRef.current + 2) {
      handleDevToolsDetected();
    }
    
    lastConsoleCountRef.current = consoleCount;
    
    // Restore original console methods
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
    console.info = originalInfo;
  }, [handleDevToolsDetected]);

  const detectByDebugger = useCallback(() => {
    // Use debugger statement timing to detect DevTools
    const start = Date.now();
    
    // This will pause execution if DevTools is open
    try {
      debugger;
    } catch (e) {
      // Ignore errors
    }
    
    const end = Date.now();
    
    // If there was a significant delay, DevTools was open
    if (end - start > 100) {
      handleDevToolsDetected();
    }
  }, [handleDevToolsDetected]);

  const detectByElement = useCallback(() => {
    // Create a fake element that DevTools might interact with
    const element = document.createElement('div');
    element.id = '__devtools_detector__';
    
    let detected = false;
    
    // Override toString to detect if DevTools inspects the element
    Object.defineProperty(element, 'id', {
      get() {
        detected = true;
        return '__devtools_detector__';
      },
      configurable: true
    });
    
    // Trigger the getter
    console.log(element);
    console.clear();
    
    if (detected) {
      handleDevToolsDetected();
    }
  }, [handleDevToolsDetected]);

  const detectByToString = useCallback(() => {
    // Use function toString override to detect DevTools
    const func = () => {};
    func.toString = () => {
      handleDevToolsDetected();
      return 'function () { [native code] }';
    };
    
    console.log('%c', func);
    console.clear();
  }, [handleDevToolsDetected]);

  const runDetection = useCallback(() => {
    if (!options.enabled || isDetectedRef.current) return;
    
    try {
      // Run multiple detection methods
      detectByTiming();
      detectByWindowSize();
      detectByConsole();
      
      // More aggressive detection for higher sensitivity
      if (options.detectionSensitivity === 'medium' || options.detectionSensitivity === 'high') {
        detectByDebugger();
        detectByElement();
      }
      
      // Most aggressive detection
      if (options.detectionSensitivity === 'high') {
        detectByToString();
      }
    } catch (error) {
      // Silently handle any detection errors
    }
  }, [
    options.enabled,
    options.detectionSensitivity,
    detectByTiming,
    detectByWindowSize,
    detectByConsole,
    detectByDebugger,
    detectByElement,
    detectByToString
  ]);

  useEffect(() => {
    if (!options.enabled) return;

    // Disable right-click globally when DevTools protection is enabled
    const handleGlobalRightClick = (e: MouseEvent) => {
      e.preventDefault();
      return false;
    };

    // Block F12 and other DevTools shortcuts
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === 'F12' ||
        (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'J' || e.key === 'C')) ||
        (e.ctrlKey && e.key === 'U')
      ) {
        e.preventDefault();
        e.stopPropagation();
        handleDevToolsDetected();
        return false;
      }
    };

    document.addEventListener('contextmenu', handleGlobalRightClick);
    document.addEventListener('keydown', handleKeyDown, true);

    // Start detection interval
    const interval = options.detectionSensitivity === 'high' ? 500 : 
                    options.detectionSensitivity === 'medium' ? 1000 : 2000;
    
    detectionTimerRef.current = setInterval(runDetection, interval);

    // Initial detection
    runDetection();

    return () => {
      document.removeEventListener('contextmenu', handleGlobalRightClick);
      document.removeEventListener('keydown', handleKeyDown, true);
      
      if (detectionTimerRef.current) {
        clearInterval(detectionTimerRef.current);
      }
    };
  }, [options.enabled, options.detectionSensitivity, runDetection, handleDevToolsDetected]);

  return {
    isDetected: isDetectedRef.current,
    reset: () => {
      isDetectedRef.current = false;
    }
  };
};
