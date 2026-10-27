'use strict';

/**
 * Photo sales — the Content-Security-Policy of gallery pages.
 *
 * Snipcart's v3 cart loads from its CDN, compiles its templates at runtime
 * ('unsafe-eval'), calls its API and frames the payment form. nginx grants
 * that on gallery pages only (`location @gallery_spa` in frontend/nginx.conf);
 * this is the same grant for installs where the backend serves the SPA
 * itself (the all-in-one image, native installs). Every other page keeps the
 * site policy.
 */

const SNIPCART_SOURCES = {
  scriptSrc: ['\'unsafe-eval\'', 'https://cdn.snipcart.com'],
  connectSrc: [
    'https://app.snipcart.com',
    'https://api.snipcart.com',
    'https://payment.snipcart.com',
    'https://cdn.snipcart.com',
  ],
  frameSrc: ['https://app.snipcart.com', 'https://payment.snipcart.com'],
};

/** The site's helmet CSP directives plus what Snipcart's cart needs. */
function withPhotoSalesSources(directives) {
  const result = { ...directives };
  for (const [name, sources] of Object.entries(SNIPCART_SOURCES)) {
    result[name] = [...(directives[name] || []), ...sources];
  }
  return result;
}

module.exports = { SNIPCART_SOURCES, withPhotoSalesSources };
