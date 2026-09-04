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

/**
 * Decode CSS escape sequences.
 *
 * `\72` is a legal way to write `r`, so `u\72l(https://evil.example/x.gif)`
 * IS a url() to a browser while matching no literal pattern for "url(".
 * Decoding first means the scanner below sees what the browser will see. The
 * decoded form is what gets stored, which is safe: the same stylesheet,
 * spelled unambiguously.
 *
 * Per CSS syntax: a backslash plus 1-6 hex digits and one optional trailing
 * whitespace, or a backslash plus any other single character.
 */
function decodeCssEscapes(css) {
  return String(css).replace(
    /\\([0-9a-fA-F]{1,6})[ \t\n\f]?|\\([^0-9a-fA-F])/g,
    (match, hex, literal) => {
      if (hex) {
        const code = parseInt(hex, 16);
        // Null, out-of-range and surrogate escapes are invalid; leave them
        // exactly as written rather than throwing.
        if (!Number.isFinite(code) || code === 0 || code > 0x10FFFF
          || (code >= 0xD800 && code <= 0xDFFF)) return match;
        return String.fromCodePoint(code);
      }
      return literal;
    }
  );
}

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
  // Escapes decoded first, so the scan sees what a browser would parse.
  const input = decodeCssEscapes(css == null ? '' : String(css));
  let out = '';
  let blocked = 0;
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    // Inside a string, copy verbatim through the closing quote. `content:`
    // values and font names live here and are not resource requests — a raw
    // replace corrupted `content: "url(https://docs.example)"` into "none",
    // a visible change to a page that never made a request.
    if (ch === '"' || ch === '\'') {
      const quote = ch;
      let j = i + 1;
      while (j < input.length && input[j] !== quote) {
        j += input[j] === '\\' ? 2 : 1;
      }
      out += input.slice(i, Math.min(j + 1, input.length));
      i = j + 1;
      continue;
    }

    // A url( token, outside any string.
    if ((ch === 'u' || ch === 'U') && /^url\s*\(/i.test(input.slice(i, i + 8))) {
      const open = input.indexOf('(', i);
      let j = open + 1;
      let target = '';
      while (j < input.length && /\s/.test(input[j])) j += 1;

      if (input[j] === '"' || input[j] === '\'') {
        // Quoted: the quote closes the value, so ")" inside it is content.
        const quote = input[j];
        j += 1;
        while (j < input.length && input[j] !== quote) {
          target += input[j];
          j += 1;
        }
        j += 1;
      } else {
        while (j < input.length && input[j] !== ')') {
          target += input[j];
          j += 1;
        }
      }
      while (j < input.length && input[j] !== ')') j += 1;

      if (j >= input.length) {
        // Unterminated url( — malformed. Copy the remainder verbatim rather
        // than swallowing the rest of the stylesheet.
        out += input.slice(i);
        break;
      }

      if (ALLOWED_URL_TARGET.test(target.trim())) {
        out += input.slice(i, j + 1);
      } else {
        blocked += 1;
        out += 'none';
      }
      i = j + 1;
      continue;
    }

    out += ch;
    i += 1;
  }

  return { sanitized: out, blocked };
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

  // Remove HTML comments that might be used for injection
  sanitized = sanitized.replace(/<!--[\s\S]*?-->/g, '');

  // URLs are scanned AFTER the comment strip, not before. Removing
  // `<!--x-->` from `u<!--x-->rl(https://evil.example/p.gif)` JOINS the
  // remaining characters into a live `url(...)` — so a scan that ran first
  // saw no token, reported the input clean, and the transformation below it
  // then produced exactly the request the scan was there to prevent. Any
  // pass that can join tokens has to happen before validation, not after.
  const urlPass = stripDisallowedUrls(sanitized);
  if (urlPass.blocked > 0) {
    warnings.push(
      `Blocked ${urlPass.blocked} external URL reference${urlPass.blocked === 1 ? '' : 's'}. `
      + 'Only data: URIs are allowed for images.'
    );
    sanitized = urlPass.sanitized;
  }

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
