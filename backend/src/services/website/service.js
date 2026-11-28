/**
 * The website builder's service (issue 2618): what its routes and the server
 * call. The draft and publishing (draft.js), what a page is rendered with
 * (context.js), the public pages (publicPages.js) and the landing page a
 * website may start from (legacyLanding.js) each have their module.
 */
const { db } = require('../../database/db');
const { formatBoolean } = require('../../utils/dbCompat');
const { AppError } = require('../../utils/errors');
const { clearWebsiteCache } = require('./cache');
const draft = require('./draft');
const context = require('./context');
const publicPages = require('./publicPages');
const legacyLanding = require('./legacyLanding');

async function setGalleryOnWebsite(eventId, enabled) {
  const updated = await db('events').where({ id: eventId }).update({ show_on_website: formatBoolean(Boolean(enabled)) });
  if (!updated) throw new AppError('Gallery not found', 404, 'EVENT_NOT_FOUND');
  clearWebsiteCache();
}

module.exports = {
  FLAG: publicPages.FLAG,
  getEditorState: draft.getEditorState,
  saveDraft: draft.saveDraft,
  publish: draft.publish,
  renderPreview: draft.renderPreview,
  referencesAdminMay: draft.referencesAdminMay,
  setSiteVisible: draft.setSiteVisible,
  resolvePublicPage: publicPages.resolvePublicPage,
  isWebsiteActive: publicPages.isWebsiteActive,
  publishedPhotoIds: publicPages.publishedPhotoIds,
  mediaRobotsTag: publicPages.mediaRobotsTag,
  sitemapXml: publicPages.sitemapXml,
  publishedDocument: publicPages.publishedDocument,
  legacyLandingNotice: legacyLanding.legacyLandingNotice,
  dismissLegacyLandingNotice: legacyLanding.dismissLegacyLandingNotice,
  bookingOptions: context.bookingOptions,
  buildContext: context.buildContext,
  packageOffer: context.packageOffer,
  setGalleryOnWebsite,
  _internal: { initialDocument: legacyLanding.initialDocument, importRefusal: legacyLanding.importRefusal, loadPackages: context.loadPackages },
};
