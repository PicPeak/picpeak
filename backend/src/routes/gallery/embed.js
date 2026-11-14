'use strict';
/**
 * Gallery embed (issue 1112): the two reads the embed page makes. Both resolve
 * the embed first, so a removed token, the flag turned off or a gallery that
 * stopped being public is a 404 on the next request.
 *
 * No session is minted. The photos are those a public viewer of this gallery
 * already gets (the guest list, accessLevel 'guest'), and the image URLs are
 * the guest URLs, which serve such a gallery without a credential. Nothing is
 * written: a page view on someone's website is not a gallery visit, so no
 * access_logs row and no "gallery opened" notification.
 */
const express = require('express');
const { noStoreCache } = require('../../middleware/noStoreCache');
const { handleAsync } = require('../../utils/routeHelpers');
const { NotFoundError } = require('../../utils/errors');
const { publicThemeFields } = require('../../services/galleryTheme');
const { resolveEmbed } = require('../../services/galleryEmbed');

const router = express.Router();
const PAGE_SIZE = 60;

async function eligible(req) {
  const event = await resolveEmbed(req.params.slug, req.params.token);
  if (!event) throw new NotFoundError('Embed');
  return event;
}

router.get('/:slug/embed/:token', noStoreCache, handleAsync(async (req, res) => {
  const event = await eligible(req);
  res.json({
    event: {
      event_name: event.event_name,
      color_theme: (await publicThemeFields(event)).color_theme,
    },
    gallery_path: `/gallery/${event.slug}`,
  });
}));

// The image URLs name the embed (?embed=<token>), so middleware/gallery.js
// serves them as to a public visitor whatever gallery cookie the browser
// sends along.
const withEmbed = (url, token) => `${url}${url.includes('?') ? '&' : '?'}embed=${token}`;

router.get('/:slug/embed/:token/photos', noStoreCache, handleAsync(async (req, res) => {
  const event = await eligible(req);
  const { token } = req.params;
  const page = Math.max(1, Math.min(10000, parseInt(req.query.page, 10) || 1));
  const payload = await require('../../services/galleryQueryService').getGalleryPhotos({
    event,
    slug: event.slug,
    query: { page, limit: PAGE_SIZE },
    // No viewer: a fixed identifier matches no guest's likes or ratings.
    identity: { guestIdentifier: 'embed' },
    accessLevel: 'guest',
    stillsOnly: true,
  });
  res.json({
    pagination: payload.pagination,
    // Stills only (the query left videos out before paging): the embed has
    // no player. The lightbox gets the preview tier (slideshow_url is that
    // URL, emitted for every still regardless of lightbox_preview_enabled),
    // never the original. A still whose thumbnail is not recorded yet gets
    // the thumbnail route, which renders it on first request, as the gallery
    // grid's own tile does.
    photos: (payload.photos || [])
      .filter((photo) => photo.slideshow_url)
      .map((photo) => ({
        id: photo.id,
        width: photo.width ?? null,
        height: photo.height ?? null,
        thumbnail_url: withEmbed(photo.thumbnail_url || `/api/gallery/${event.slug}/thumbnail/${photo.id}`, token),
        preview_url: withEmbed(photo.slideshow_url, token),
      })),
  });
}));

module.exports = router;
