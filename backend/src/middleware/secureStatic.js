const path = require('path');
const express = require('express');
const { safePathJoin, isPathSafe } = require('../utils/fileSecurityUtils');

/**
 * Create a secure static file serving middleware that prevents path traversal attacks
 * @param {string} basePath - The base directory to serve files from
 * @param {Object} options - Express static options
 * @returns {Function} - Express middleware
 */
function secureStatic(basePath, options = {}) {
  const normalizedBase = path.resolve(basePath);
  
  return (req, res, next) => {
    // Get the requested file path - remove leading slash for validation
    const requestedPath = req.path.startsWith('/') ? req.path.substring(1) : req.path;
    
    // Validate the path doesn't contain dangerous patterns
    if (!isPathSafe(requestedPath)) {
      console.warn(`Potential path traversal attempt blocked: ${requestedPath}`);
      return res.status(403).json({ error: 'Access denied' });
    }
    
    try {
      // Validate the full path is within the base directory
      const fullPath = safePathJoin(normalizedBase, requestedPath);
      
      // If validation passes, use express.static
      const staticMiddleware = express.static(normalizedBase, {
        ...options,
        // Disable directory listing for security
        index: false,
        // Don't allow dotfiles
        dotfiles: 'deny',
        setHeaders: (resp, filePath) => {
          // Preserve any caller-provided header logic (e.g. font caching).
          if (typeof options.setHeaders === 'function') options.setHeaders(resp, filePath);
          // SVGs are admin-uploadable (logos, favicon). Served from our
          // own origin, a malicious SVG opened directly could run embedded
          // <script>/on* handlers (stored XSS). A restrictive CSP lets the
          // browser RENDER the vector but blocks all script execution —
          // so we keep real SVGs (scalable) instead of rasterising them.
          // `default-src 'none'` already implies script-src 'none';
          // style-src + img-src(data:) keep normal SVG rendering working.
          if (/\.svg$/i.test(filePath)) {
            resp.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:");
            resp.setHeader('X-Content-Type-Options', 'nosniff');
          }
        }
      });
      
      return staticMiddleware(req, res, next);
    } catch (error) {
      // Path traversal detected
      console.error(`Path traversal blocked: ${requestedPath}`, error.message);
      return res.status(403).json({ error: 'Access denied' });
    }
  };
}

module.exports = secureStatic;