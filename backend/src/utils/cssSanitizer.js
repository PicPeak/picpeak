/**
 * CSS Sanitizer
 * Sanitizes user-provided CSS to prevent security vulnerabilities
 */

// Patterns that should be blocked for security
const FORBIDDEN_PATTERNS = [
  // JavaScript execution
  /expression\s*\(/gi,
  /javascript:/gi,
  /behavior\s*:/gi,
  /-moz-binding/gi,
  /vbscript:/gi,

  // External resources (potential data exfiltration)
  /@import/gi,

  // Dangerous at-rules
  /@charset/gi,
  /@namespace/gi,

  // IE-specific exploits
  /\\0/g,  // Null byte
  /\\9/g,  // IE CSS hack

  // Script injection attempts
  /<script/gi,
  /<\/script/gi,
  /on\w+\s*=/gi, // onclick=, onload=, etc.
];

// Pattern for external URLs (block external, allow only safe raster data: images)
const EXTERNAL_URL_PATTERN = /url\s*\(\s*["']?(?!data:image\/(?:jpeg|jpg|png|gif|webp))/gi;

// Maximum CSS size in bytes (100KB)
const MAX_CSS_SIZE = 100 * 1024;

/**
 * Basic CSS sanitization (original function, kept for compatibility)
 */
function sanitizeCss(css) {
  if (!css || typeof css !== 'string') {
    return '';
  }

  let sanitized = css;

  const disallowedPatterns = [
    /@import[^;]+;?/gi,
    /@charset[^;]+;?/gi,
    /expression\s*\([^)]*\)/gi,
    /url\s*\(\s*(['"])\s*javascript:[^)]*\)/gi,
    /url\s*\(\s*(['"])\s*data:text\/javascript[^)]*\)/gi,
    /url\s*\(\s*(['"]?)\s*data:image\/svg\+xml[^)]*\)/gi
  ];

  disallowedPatterns.forEach((pattern) => {
    sanitized = sanitized.replace(pattern, '');
  });

  sanitized = sanitized.replace(/[\u0000-\u001F\u007F]/g, '');

  const MAX_LENGTH = 100 * 1024;
  if (sanitized.length > MAX_LENGTH) {
    sanitized = sanitized.slice(0, MAX_LENGTH);
  }

  return sanitized.trim();
}

/**
 * Enhanced CSS sanitization with warnings
 * @param {string} cssContent - Raw CSS content
 * @returns {Object} - { sanitized: string, warnings: string[] }
 */
function sanitizeCSS(cssContent) {
  if (!cssContent || typeof cssContent !== 'string') {
    return { sanitized: '', warnings: [] };
  }

  const warnings = [];
  let sanitized = cssContent;

  // Check size
  if (sanitized.length > MAX_CSS_SIZE) {
    warnings.push(`CSS exceeds maximum size of ${MAX_CSS_SIZE / 1024}KB`);
    sanitized = sanitized.substring(0, MAX_CSS_SIZE);
  }

  // Remove forbidden patterns
  for (const pattern of FORBIDDEN_PATTERNS) {
    const patternStr = pattern.toString();
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    if (pattern.test(sanitized)) {
      const patternName = patternStr.replace(/\/[gi]*/g, '').substring(0, 30);
      warnings.push(`Blocked potentially unsafe pattern: ${patternName}`);
      pattern.lastIndex = 0;
      sanitized = sanitized.replace(pattern, '/* BLOCKED */');
    }
  }

  // Block external URLs (only allow data: URIs for images)
  EXTERNAL_URL_PATTERN.lastIndex = 0;
  if (EXTERNAL_URL_PATTERN.test(sanitized)) {
    warnings.push('Blocked external URL references. Only data: URIs are allowed for images.');
    EXTERNAL_URL_PATTERN.lastIndex = 0;
    sanitized = sanitized.replace(EXTERNAL_URL_PATTERN, '/* BLOCKED URL */ url(');
  }

  // Remove HTML comments that might be used for injection
  sanitized = sanitized.replace(/<!--[\s\S]*?-->/g, '');

  // Remove control characters
  sanitized = sanitized.replace(/[\u0000-\u001F\u007F]/g, '');

  // Remove any remaining script-like content
  sanitized = sanitized.replace(/<[^>]*>/g, '/* BLOCKED TAG */');

  return { sanitized: sanitized.trim(), warnings };
}

/**
 * Validate CSS syntax (basic check)
 * @param {string} cssContent - CSS content to validate
 * @returns {Object} - { valid: boolean, error?: string }
 */
function validateCSS(cssContent) {
  if (!cssContent || cssContent.trim() === '') {
    return { valid: true };
  }

  // Basic bracket matching
  const openBraces = (cssContent.match(/{/g) || []).length;
  const closeBraces = (cssContent.match(/}/g) || []).length;

  if (openBraces !== closeBraces) {
    return {
      valid: false,
      error: `Mismatched braces: ${openBraces} opening, ${closeBraces} closing`
    };
  }

  return { valid: true };
}

/**
 * Scope CSS to gallery page
 * @param {string} cssContent - CSS content
 * @returns {string} - Scoped CSS
 */
function scopeToGalleryPage(cssContent) {
  if (!cssContent || cssContent.trim() === '') {
    return '';
  }

  // If the CSS already uses .gallery-page, return as-is
  if (cssContent.includes('.gallery-page')) {
    return cssContent;
  }

  // Simple scoping: wrap entire content in .gallery-page
  return `.gallery-page {\n${cssContent}\n}`;
}

module.exports = {
  sanitizeCss,
  sanitizeCSS,
  validateCSS,
  scopeToGalleryPage,
  MAX_CSS_SIZE
};
