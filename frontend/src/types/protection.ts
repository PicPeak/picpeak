// Image Protection Type Definitions

export type ProtectionLevel = 'basic' | 'standard' | 'enhanced' | 'maximum';

export type DetectionSensitivity = 'low' | 'medium' | 'high';

export type ViolationType = 
  | 'context_menu'
  | 'drag_start'
  | 'text_selection'
  | 'keyboard_shortcut'
  | 'print_screen_detected'
  | 'canvas_access_blocked'
  | 'clipboard_copy'
  | 'clipboard_paste'
  | 'devtools_detected'
  | 'suspicious_visibility_change'
  | 'canvas_rendering_error'
  | 'image_load_error'
  | 'canvas_context_menu'
  | 'canvas_drag_start'
  | 'canvas_selection'
  | 'canvas_interaction_blocked';

export interface ProtectionViolationEvent {
  type: ViolationType;
  timestamp: number;
  protectionLevel: ProtectionLevel;
  userAgent: string;
  url: string;
  metadata?: Record<string, any>;
}

export interface DevToolsDetectionOptions {
  enabled: boolean;
  onDevToolsDetected?: () => void;
  redirectOnDetection?: boolean;
  redirectUrl?: string;
  detectionSensitivity?: DetectionSensitivity;
}

export interface ImageProtectionOptions {
  enabled: boolean;
  onAttemptedDownload?: () => void;
  onProtectionViolation?: (violationType: ViolationType) => void;
  protectionLevel?: ProtectionLevel;
  useCanvasRendering?: boolean;
  overlayProtection?: boolean;
  blockKeyboardShortcuts?: boolean;
  detectPrintScreen?: boolean;
  watermarkText?: string;
  fragmentGrid?: boolean;
}

export interface ProtectedImageProps {
  src: string;
  alt: string;
  protectionLevel?: ProtectionLevel;
  watermarkText?: string;
  fragmentGrid?: boolean;
  gridSize?: number;
  scrambleFragments?: boolean;
  invisibleWatermark?: boolean;
  onProtectionViolation?: (violationType: ViolationType) => void;
  fallbackSrc?: string;
  crossOrigin?: 'anonymous' | 'use-credentials';
}

export interface CSSProtectionOptions {
  enabled: boolean;
  protectionLevel: ProtectionLevel;
  applyWatermark?: boolean;
  watermarkText?: string;
  antiScreenshot?: boolean;
}

export interface WatermarkConfig {
  text: string;
  opacity: number;
  fontSize: number;
  color: string;
  positions: Array<{ x: number; y: number }>;
  rotation: number;
}

export interface FragmentConfig {
  enabled: boolean;
  gridSize: number;
  scramble: boolean;
  randomSeed?: number;
}

export interface SteganographyConfig {
  enabled: boolean;
  message: string;
  channel: 'red' | 'green' | 'blue' | 'alpha';
  bitDepth: number;
}

export interface ProtectionMetrics {
  violationCount: number;
  violationTypes: Record<ViolationType, number>;
  lastViolation?: {
    type: ViolationType;
    timestamp: number;
  };
  protectionLevel: ProtectionLevel;
  activeFeatures: string[];
}

export interface DevToolsDetectionResult {
  isDetected: boolean;
  detectionMethod: string;
  confidence: number;
  timestamp: number;
}

export interface CanvasProtectionContext {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  originalImageData: ImageData;
  protectedImageData: ImageData;
  watermarkApplied: boolean;
  fragmentsScrambled: boolean;
}

export interface PrintScreenDetectionState {
  isMonitoring: boolean;
  interval: NodeJS.Timeout | null;
  detectorCanvas: HTMLCanvasElement | null;
  lastKnownState: string;
}

export interface KeyboardProtectionState {
  blockedKeys: Set<string>;
  violationCount: number;
  lastViolation?: {
    key: string;
    timestamp: number;
    modifiers: string[];
  };
}

export interface VisibilityProtectionState {
  isHidden: boolean;
  suspiciousChanges: number;
  lastChange: number;
  threshold: number;
}

export interface ProtectionAnalytics {
  track: (event: string, properties: Record<string, any>) => void;
  trackViolation: (violation: ProtectionViolationEvent) => void;
  getMetrics: () => ProtectionMetrics;
}

export interface ProtectionConfig {
  global: {
    enabled: boolean;
    defaultLevel: ProtectionLevel;
    analyticsEnabled: boolean;
  };
  detection: {
    devTools: DevToolsDetectionOptions;
    printScreen: {
      enabled: boolean;
      interval: number;
      sensitivity: DetectionSensitivity;
    };
    keyboard: {
      enabled: boolean;
      blockedKeys: string[];
      customBlacklist: string[];
    };
    visibility: {
      enabled: boolean;
      threshold: number;
      maxSuspiciousChanges: number;
    };
  };
  rendering: {
    canvas: {
      enabled: boolean;
      fragmentGrid: FragmentConfig;
      watermark: WatermarkConfig;
      steganography: SteganographyConfig;
      noiseInjection: boolean;
    };
    css: {
      enabled: boolean;
      overlays: boolean;
      printBlocking: boolean;
      mobileOptimization: boolean;
    };
  };
  response: {
    logViolations: boolean;
    alertOnViolation: boolean;
    redirectOnDevTools: boolean;
    closeLightboxOnViolation: boolean;
    blockInteractionOnMaxProtection: boolean;
  };
}

export interface ProtectionHookResult {
  elementRef: React.RefObject<HTMLElement>;
  canvasRef?: React.RefObject<HTMLCanvasElement>;
  overlayRef?: React.RefObject<HTMLDivElement>;
  metrics: ProtectionMetrics;
  reset: () => void;
}

export interface DevToolsHookResult {
  isDetected: boolean;
  reset: () => void;
  detectionHistory: DevToolsDetectionResult[];
}

export interface CSSProtectionHookResult {
  containerRef: React.RefObject<HTMLElement>;
  isProtected: boolean;
  appliedClasses: string[];
}

// Utility types for component props
export type ProtectionProps = {
  protectionLevel?: ProtectionLevel;
  useEnhancedProtection?: boolean;
  onProtectionViolation?: (violationType: ViolationType) => void;
};

export type CanvasProtectionProps = ProtectionProps & {
  useCanvasRendering?: boolean;
  fragmentGrid?: boolean;
  watermarkText?: string;
  scrambleFragments?: boolean;
  invisibleWatermark?: boolean;
};

export type DevToolsProtectionProps = ProtectionProps & {
  detectDevTools?: boolean;
  redirectOnDetection?: boolean;
  detectionSensitivity?: DetectionSensitivity;
};

export type KeyboardProtectionProps = ProtectionProps & {
  blockKeyboardShortcuts?: boolean;
  customBlockedKeys?: string[];
};

export type PrintScreenProtectionProps = ProtectionProps & {
  detectPrintScreen?: boolean;
  printScreenSensitivity?: DetectionSensitivity;
};

// Event types for analytics
export interface ProtectionAnalyticsEvent {
  event: string;
  properties: {
    protectionLevel: ProtectionLevel;
    violationType?: ViolationType;
    timestamp: number;
    sessionId: string;
    userId?: string;
    photoId?: string | number;
    galleryId?: string | number;
    userAgent: string;
    viewport: {
      width: number;
      height: number;
    };
    [key: string]: any;
  };
}

// Configuration validation
export interface ProtectionConfigValidator {
  validate: (config: Partial<ProtectionConfig>) => {
    isValid: boolean;
    errors: string[];
    warnings: string[];
  };
  getDefaults: () => ProtectionConfig;
  merge: (base: ProtectionConfig, override: Partial<ProtectionConfig>) => ProtectionConfig;
}

// Performance monitoring
export interface ProtectionPerformance {
  renderTime: number;
  detectionOverhead: number;
  memoryUsage: number;
  cpuUsage: number;
  violationProcessingTime: number;
}

export interface ProtectionPerformanceMonitor {
  start: (operation: string) => void;
  end: (operation: string) => number;
  getMetrics: () => ProtectionPerformance;
  reset: () => void;
}