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

// Any `url(...)` token, quoted or unquoted. A URL containing a literal ")"
// is not matched — it would have to be escaped to be valid CSS anyway.
const URL_TOKEN_PATTERN = /url\s*\(\s*(['"]?)([^)'"]*)\1\s*\)/gi;

// The only target a url() may name: an inline raster data: image. Anything
// else is a request to a third party from someone else's browser.
const ALLOWED_URL_TARGET = /^data:image\/(?:jpeg|jpg|png|gif|webp)/i;

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

  // eslint-disable-next-line no-control-regex -- intentional: strips control chars from untrusted CSS
  sanitized = sanitized.replace(/[\u0000-\u001F\u007F]/g, '');

  const MAX_LENGTH = 100 * 1024;
  if (sanitized.length > MAX_LENGTH) {
    sanitized = sanitized.slice(0, MAX_LENGTH);
  }

  return sanitized.trim();
}

/**
 * Replace every `url(...)` that does not name an inline data: image with the
 * inert keyword `none`.
 *
 * This REPLACES an earlier implementation that prefixed the offending token
 * with a `/* BLOCKED URL *\/` comment and left the URL in place. CSS comments
 * are discarded during tokenization, so the declaration a browser actually
 * parsed still carried the live URL — the "block" was inert, while the
 * warning returned to the caller said it had worked:
 *
 *   before: '.a{background:url(https://x/p.gif)}'
 *        →  '.a{background:/* BLOCKED URL *\/ url(https://x/p.gif)}'
 *        →  parsed as '.a{background: url(https://x/p.gif)}'
 *
 * `none` is used rather than deleting the declaration because it is valid in
 * the shorthand positions these appear in (`background: #fff none no-repeat`)
 * and leaves the rest of the rule intact.
 *
 * @param {string} css
 * @returns {{ sanitized: string, blocked: number }}
 */
function stripDisallowedUrls(css) {
  let blocked = 0;
  const sanitized = String(css == null ? '' : css).replace(
    URL_TOKEN_PATTERN,
    (match, _quote, target) => {
      if (ALLOWED_URL_TARGET.test(String(target).trim())) return match;
      blocked += 1;
      return 'none';
    }
  );
  return { sanitized, blocked };
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

  // Block external URLs (only inline data: images are allowed).
  const urlPass = stripDisallowedUrls(sanitized);
  if (urlPass.blocked > 0) {
    warnings.push(
      `Blocked ${urlPass.blocked} external URL reference${urlPass.blocked === 1 ? '' : 's'}. `
      + 'Only data: URIs are allowed for images.'
    );
    sanitized = urlPass.sanitized;
  }

  // Remove HTML comments that might be used for injection
  sanitized = sanitized.replace(/<!--[\s\S]*?-->/g, '');

  // Remove control characters
  // eslint-disable-next-line no-control-regex -- intentional: strips control chars from untrusted CSS
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
  stripDisallowedUrls,
  validateCSS,
  scopeToGalleryPage,
  MAX_CSS_SIZE
};
