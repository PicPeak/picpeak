'use strict';
const helmet = require('helmet');
const providers = require('./providers');

function siteDirectives() {
  return {
    defaultSrc: ['\'self\''], scriptSrc: ['\'self\'', 'https://www.google.com', 'https://www.gstatic.com'],
    styleSrc: ['\'self\'', '\'unsafe-inline\'', 'https:'], imgSrc: ['\'self\'', 'data:', 'https:', 'blob:'],
    connectSrc: ['\'self\'', 'https://www.google.com', 'https://www.gstatic.com'],
    fontSrc: ['\'self\'', 'https:', 'data:'], objectSrc: ['\'none\''], mediaSrc: ['\'self\'', 'blob:'],
    frameSrc: ['\'self\'', 'https://www.google.com'],
    ...(process.env.ENABLE_HSTS === 'true' ? { upgradeInsecureRequests: [] } : {}),
  };
}
const SNIPCART_SOURCES = {
  scriptSrc: ['\'unsafe-eval\'', 'https://cdn.snipcart.com'],
  connectSrc: ['https://app.snipcart.com', 'https://api.snipcart.com', 'https://payment.snipcart.com', 'https://cdn.snipcart.com'],
  frameSrc: ['https://app.snipcart.com', 'https://payment.snipcart.com'],
};
function withPhotoSalesSources(directives) {
  const result = { ...directives };
  for (const [name, sources] of Object.entries(SNIPCART_SOURCES)) result[name] = [...(directives[name] || []), ...sources];
  return result;
}
async function galleryPolicy(req, res, next) {
  try {
    const enabled = (await providers.configuration()).available.includes('snipcart');
    const directives = enabled ? withPhotoSalesSources(siteDirectives()) : siteDirectives();
    helmet.contentSecurityPolicy({ useDefaults: false, directives })(req, res, next);
  } catch (error) { next(error); }
}
module.exports = { siteDirectives, galleryPolicy, SNIPCART_SOURCES, withPhotoSalesSources };
