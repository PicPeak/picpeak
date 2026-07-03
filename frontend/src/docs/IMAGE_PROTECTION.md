# Enhanced Image Protection System

This document describes the enhanced client-side image protection system implemented for the wedding photo sharing platform.

## Overview

The image protection system provides multiple layers of security to prevent unauthorized downloading, copying, and screenshot capture of protected images. It includes JavaScript-based protection, CSS layers, canvas rendering, and DevTools detection.

## Protection Levels

### Basic
- Context menu blocking
- Drag and drop prevention
- Text selection blocking
- Basic CSS protection

### Standard
- All Basic features
- Enhanced keyboard shortcut blocking
- CSS overlay protection
- Print protection

### Enhanced
- All Standard features
- Advanced keyboard shortcut blocking
- Print screen detection
- Fragment grid rendering (optional)
- Visible watermarking
- Copy/paste detection

### Maximum
- All Enhanced features
- DevTools detection and blocking
- Canvas rendering with scrambled fragments
- Invisible steganographic watermarking
- Random noise injection
- Complete interaction blocking
- Automatic violation response (close/redirect)

## Components

### useDevToolsProtection Hook

Detects when developer tools are opened using multiple methods:

```typescript
import { useDevToolsProtection } from '../hooks/useDevToolsProtection';

const { isDetected, reset } = useDevToolsProtection({
  enabled: true,
  detectionSensitivity: 'high', // 'low' | 'medium' | 'high'
  onDevToolsDetected: () => console.log('DevTools detected!'),
  redirectOnDetection: true,
  redirectUrl: '/'
});
```

**Detection Methods:**
- Timing-based detection (console.log performance)
- Window size monitoring
- Console usage tracking
- Debugger statement timing
- Element inspection detection
- Function toString override

### Enhanced useImageProtection Hook

Provides comprehensive image protection with violation reporting:

```typescript
import { useImageProtection } from '../hooks/useImageProtection';

const protection = useImageProtection({
  enabled: true,
  protectionLevel: 'enhanced',
  blockKeyboardShortcuts: true,
  detectPrintScreen: true,
  overlayProtection: true,
  onProtectionViolation: (violationType) => {
    console.warn('Protection violation:', violationType);
  }
});
```

**Features:**
- Context menu blocking
- Drag and drop prevention
- Keyboard shortcut detection (F12, Ctrl+S, Print Screen, etc.)
- Print screen detection via canvas monitoring
- Clipboard operation blocking
- Visibility change detection
- CSS protection layers

### ProtectedImage Component

Canvas-based image rendering for maximum protection:

```typescript
import { ProtectedImage } from '../components/common/ProtectedImage';

<ProtectedImage
  src="/path/to/image.jpg"
  alt="Protected image"
  protectionLevel="maximum"
  watermarkText="© Protected Content"
  fragmentGrid={true}
  gridSize={6}
  scrambleFragments={true}
  invisibleWatermark={true}
  onProtectionViolation={(violation) => handleViolation(violation)}
/>
```

**Features:**
- Canvas-based rendering
- Fragment grid with optional scrambling
- Visible and invisible watermarking
- Steganographic data embedding
- Random noise injection
- Pixel-level protection

### Enhanced AuthenticatedImage Component

Secure image loading with authentication and protection:

```typescript
import { AuthenticatedImage } from '../components/common/AuthenticatedImage';

<AuthenticatedImage
  src="/api/gallery/photo/123"
  alt="Gallery photo"
  protectionLevel="enhanced"
  useEnhancedProtection={true}
  useCanvasRendering={true}
  fragmentGrid={true}
  blockKeyboardShortcuts={true}
  detectPrintScreen={true}
  detectDevTools={true}
  watermarkText="Protected Gallery"
  onProtectionViolation={handleViolation}
/>
```

### useCSSProtection Hook

Applies CSS-based protection layers:

```typescript
import { useCSSProtection } from '../hooks/useCSSProtection';

const containerRef = useCSSProtection({
  enabled: true,
  protectionLevel: 'enhanced',
  applyWatermark: true,
  watermarkText: 'Protected',
  antiScreenshot: true
});
```

## CSS Protection Layers

The system includes comprehensive CSS protection located in `src/styles/image-protection.css`:

- **Base Protection**: User selection, drag prevention, context menu blocking
- **Visual Layers**: Subtle overlays and patterns to defeat screenshot tools
- **Print Protection**: Hide images when printing
- **Mobile Protection**: Touch callout and highlight prevention
- **Accessibility**: High contrast and reduced motion support

## Usage Examples

### Gallery Implementation

```typescript
// In PhotoGrid component
<AuthenticatedImage
  src={photo.thumbnail_url}
  alt={photo.filename}
  protectionLevel="enhanced"
  useEnhancedProtection={true}
  useCanvasRendering={protectionLevel === 'maximum'}
  fragmentGrid={true}
  blockKeyboardShortcuts={true}
  detectPrintScreen={true}
  detectDevTools={protectionLevel === 'maximum'}
  watermarkText="Protected"
  onProtectionViolation={(violation) => {
    // Track analytics
    umami.track('protection_violation', { violation, protectionLevel });
  }}
/>
```

### Lightbox Implementation

```typescript
// In PhotoLightbox component
<AuthenticatedImage
  src={currentPhoto.url}
  alt={currentPhoto.filename}
  protectionLevel="maximum"
  useEnhancedProtection={true}
  useCanvasRendering={true}
  fragmentGrid={true}
  watermarkText={`${currentPhoto.filename} - Protected`}
  onProtectionViolation={(violation) => {
    if (violation === 'devtools_detected') {
      onClose(); // Close lightbox on DevTools detection
    }
  }}
/>
```

## Violation Types

The system tracks various protection violations:

- `context_menu` - Right-click context menu
- `drag_start` - Drag and drop attempt
- `text_selection` - Text selection attempt
- `keyboard_shortcut_*` - Specific keyboard shortcuts
- `print_screen_detected` - Print screen key detection
- `canvas_access_blocked` - Canvas data access attempt
- `clipboard_copy` - Copy operation
- `clipboard_paste` - Paste operation
- `devtools_detected` - Developer tools opened
- `suspicious_visibility_change` - Page visibility changes
- `canvas_rendering_error` - Canvas rendering failure
- `image_load_error` - Image loading failure

## Analytics Integration

The protection system integrates with Umami analytics:

```typescript
// Automatic tracking of violations
if (window.umami) {
  window.umami.track('protection_violation', {
    type: violationType,
    protectionLevel: 'enhanced',
    photoId: photo.id,
    context: 'gallery'
  });
}
```

## Performance Considerations

- **Basic/Standard**: Minimal performance impact
- **Enhanced**: Moderate impact due to detection intervals
- **Maximum**: Higher impact due to canvas rendering and continuous monitoring

**Optimization strategies:**
- Use basic protection for thumbnails
- Enable enhanced/maximum only for full-size images
- Implement lazy loading for protected images
- Use detection intervals appropriate to protection level

## Browser Compatibility

- **Modern Browsers**: Full support (Chrome 80+, Firefox 75+, Safari 13+)
- **Mobile Browsers**: Full support with touch-specific protections
- **Legacy Browsers**: Graceful degradation with basic protection

## Security Limitations

Client-side protection has inherent limitations:

1. **Determined Users**: Can disable JavaScript or use specialized tools
2. **Screen Recording**: Cannot prevent external screen recording
3. **Camera/Phone**: Cannot prevent physical photography
4. **Browser Extensions**: May interfere with protection

**Mitigation Strategies:**
- Server-side access controls and authentication
- Time-limited access tokens
- IP-based restrictions
- Legal agreements and watermarking for accountability

## Implementation Checklist

- [ ] Import protection CSS in main stylesheet
- [ ] Configure protection levels based on content sensitivity
- [ ] Set up analytics tracking for violations
- [ ] Test across different devices and browsers
- [ ] Document protection policies for users
- [ ] Train administrators on protection settings

## Troubleshooting

### Common Issues

1. **Images not loading**: Check authentication tokens and CORS settings
2. **Protection not working**: Verify CSS is loaded and JavaScript is enabled
3. **False positives**: Adjust detection sensitivity or exclude specific scenarios
4. **Performance issues**: Lower protection level or optimize detection intervals

### Debugging

Enable debug mode:

```typescript
// Add to environment variables
VITE_DEBUG_PROTECTION=true

// Check console for protection events
console.log('Protection violation:', violationType);
```

## Future Enhancements

- Server-side image processing and obfuscation
- Machine learning-based violation detection
- Integration with DRM systems
- Advanced steganographic techniques
- Blockchain-based image provenance

## License and Legal

This protection system is designed to deter casual copying and provide evidence of unauthorized access attempts. It should be combined with proper legal agreements and terms of service for comprehensive protection.

---

*For technical support or feature requests, please contact the development team.*