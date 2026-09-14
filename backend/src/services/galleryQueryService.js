const { toIso } = require('../utils/dateNormalize');
const { db } = require('../database/db');
const { parseBooleanInput } = require('../utils/parsers');
const { getAppSetting } = require('../utils/appSettings');
const { formatBoolean } = require('../utils/dbCompat');
const { SHARED_COLOR_LABEL_IDENTITY } = require('../constants/colorLabels');
const watermarkService = require('./watermarkService');
const logger = require('../utils/logger');
const { getEventCategoriesOrdered } = require('../utils/categoryOrder');
const { getUseOriginalFilenames } = require('./downloadFilenameService');
const { resolveEventDownloadPolicy } = require('../utils/downloadResolutions');
const { resolveHeroLogoVisible, originalNeedsPreview } = require('./galleryModel');
const { applyFeedbackFilter } = require('./galleryPhotoQuery');
async function getGalleryPhotos({ event, query = {}, identity, accessLevel, adminPreview, hiddenForGuest, slug }) {
  // Get filter and sort parameters from query
  // `guest_id` is deliberately NOT read from the query string: the viewer's
  // own feedback is resolved from the request identity instead (see the
  // filter block). The frontend still sends it; it is ignored.
  const { filter, sort = 'upload_date', order = 'desc' } = query;

  // Get watermark settings to generate cache-busting version for URLs
  const watermarkSettings = await watermarkService.getWatermarkSettings();
  const wmVersion = watermarkSettings?.enabled
    ? `wm=${watermarkSettings.opacity}${watermarkSettings.position}${watermarkSettings.size}`
    : '';

  // Build the query with sorting
  const sortOrder = order === 'asc' ? 'asc' : 'desc';
  const isClient = accessLevel === 'client';
  let photosQuery = db('photos')
    .where('photos.event_id', event.id)
  // Guests/clients never see photos still being processed by the
  // background worker — the original is on disk but the thumbnail
  // / dimensions / EXIF haven't landed yet. Photos with a NULL
  // processing_status are pre-async-migration rows and are treated
  // as complete (the migration's column default is 'complete' so
  // this is just defensive against partial migration states).
    .where(function() {
      this.where('photos.processing_status', 'complete').orWhereNull('photos.processing_status');
    })
    .select('photos.*');

  // Guests only see visible photos; clients see all
  if (!isClient) {
    photosQuery = photosQuery.where(function() {
      this.where('photos.visibility', 'visible').orWhereNull('photos.visibility');
    });
  }

  // Live Slideshow category filter (#202). Enforced server-side so the kiosk
  // viewer can't widen the set: when the event pins show_category_id, the
  // slideshow only sees that category. NULL = all photos (unchanged).
  if (accessLevel === 'slideshow' && event.show_category_id) {
    photosQuery = photosQuery.where('photos.category_id', event.show_category_id);
  }

  // Apply sort option.
  //
  // Every branch carries photos.id as a tiebreaker (#1172). Without one the
  // order within a tie is whatever the engine happens to return, and ties are
  // the normal case rather than the exception: a bulk import writes hundreds
  // of rows inside the same second, so uploaded_at collapses — and with
  // captured_at NULL the COALESCE below collapses onto it too. The visible
  // symptom is a grid that reshuffles between page loads. id is insertion
  // order, so it also makes the fallback ordering meaningful rather than
  // arbitrary.
  if (sort === 'capture_date') {
    // Sort by capture date, falling back to uploaded_at if capture date is null.
    //
    // On SQLite that fallback cannot be a plain COALESCE, because the two
    // columns do not hold one type. photos.captured_at ends up carrying three
    // different storage classes:
    //
    //   integer  managed uploads — photoProcessor.js:488 writes a Date, which
    //            the sqlite3 binding stores as epoch milliseconds
    //   text     external imports and the backfill, which write ISO-8601
    //            ('2026-06-03T01:15:00.000Z') per the CLAUDE.md rule that
    //            Dates must not be handed to the binding in tests
    //   null     no capture date, so the sort falls through to uploaded_at —
    //            usually text in knex's 'YYYY-MM-DD HH:MM:SS' default shape,
    //            but epoch milliseconds on rows written by a legacy archive
    //            restore (see __tests__/integration/sqliteEpochTimestamps.js),
    //            so that column needs the same two branches
    //
    // SQLite orders INTEGER before TEXT unconditionally, so every managed
    // photo carrying EXIF sorted ahead of every photo that did not, whatever
    // the actual dates — a 2027 capture landing before a 2020 one. Among the
    // text values the 'T' separator (0x54) also outranks the space (0x20), so
    // a same-day ISO 01:15 sorted after a fallback 23:00.
    //
    // Normalising in the ORDER BY rather than rewriting the column: the data
    // fix would have to touch every existing row and every writer, which is a
    // much heavier change than the sort it is meant to correct. The cost here
    // is that this sort stops using idx_photos_captured_at on SQLite — an
    // acceptable trade on the fallback engine, where the alternative is an
    // index-assisted wrong answer.
    //
    // Postgres is untouched: captured_at is a real timestamp there, so
    // COALESCE already compares correctly.
    if (db.client.config.client === 'pg') {
      photosQuery = photosQuery
        .orderByRaw('COALESCE(photos.captured_at, photos.uploaded_at) ' + sortOrder);
    } else {
      photosQuery = photosQuery.orderByRaw(`CASE
            WHEN typeof(photos.captured_at) IN ('integer', 'real') THEN datetime(photos.captured_at / 1000, 'unixepoch')
            WHEN photos.captured_at IS NOT NULL THEN replace(replace(substr(photos.captured_at, 1, 19), 'T', ' '), 'Z', '')
            WHEN typeof(photos.uploaded_at) IN ('integer', 'real') THEN datetime(photos.uploaded_at / 1000, 'unixepoch')
            ELSE substr(photos.uploaded_at, 1, 19)
          END ${sortOrder}`);
    }
    photosQuery = photosQuery.orderBy('photos.id', sortOrder);
  } else if (sort === 'filename') {
    photosQuery = photosQuery.orderBy('photos.filename', sortOrder).orderBy('photos.id', sortOrder);
  } else {
    // Default: sort by upload date
    photosQuery = photosQuery.orderBy('photos.uploaded_at', sortOrder).orderBy('photos.id', sortOrder);
  }

  // Reveal mode (#838): while the gallery is hidden, plain guests get
  // the event shell with an empty photo/category set plus the
  // hidden_until_reveal flag — the frontend renders the upload-only view
  // from it. Slideshow, client access and the admin preview bypass
  // (guestBlockedByReveal). Enforced here, not just in the UI.


  // Check if feedback should be visible to guests. Read BEFORE the filter
  // block, not after: the filters below consult it, because a filter that
  // selects on other people's feedback is a way of reading that feedback.
  const feedbackService = require('./feedbackService');
  const feedbackSettings = await feedbackService.getEventFeedbackSettings(event.id);
  const showFeedbackToGuests = isClient || parseBooleanInput(feedbackSettings.show_feedback_to_guests, true);
  // One identity-less colour tag per photo, any guest may overwrite it
  // (#1197). Read in three places below: the colour filters, the per-viewer
  // badge, and the "other viewers" dots that must not double-render it.
  const sharedColorMode = feedbackSettings?.identity_mode === 'shared';

  applyFeedbackFilter(photosQuery, { filter, event, identity, sharedColorMode, showFeedbackToGuests });
  const limit = query.limit === undefined ? null : Math.min(250, Math.max(1, parseInt(query.limit, 10) || 100));
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const countRow = hiddenForGuest ? { total: 0 } : await photosQuery.clone().clearSelect().clearOrder().count('photos.id as total').first();
  const total = Number(countRow.total);
  if (limit) photosQuery.limit(limit).offset((page - 1) * limit);
  const photos = hiddenForGuest ? [] : await photosQuery;

  // Then get comment counts separately
  const commentCounts = await db('photo_feedback')
    .whereIn('photo_id', photos.map(p => p.id))
    .where('feedback_type', 'comment')
    .where('is_approved', formatBoolean(true))
    .where('is_hidden', formatBoolean(false))
    .groupBy('photo_id')
    .select('photo_id', db.raw('COUNT(*) as comment_count'));
    
  // Create a map for quick lookup
  const commentMap = {};
  commentCounts.forEach(c => {
    commentMap[c.photo_id] = parseInt(c.comment_count);
  });

  // Per-viewer "is_liked" set (#590 follow-up). Hard refresh on the
  // gallery grid used to reset every heart to empty because the lifted
  // likedPhotoIds state started as a fresh Set on mount — even photos
  // the viewer had actually liked. Surface a per-viewer flag so the
  // frontend can seed correctly. Prefers identity.guestId when a verified
  // guest token is present (per-person identity), falls back to the
  // IP+UA hash that the original like was recorded under — same model
  // the /my-feedback endpoint uses.
  //
  // NOT gated on showFeedbackToGuests (#1286). This query is filtered to
  // the VIEWER — by guest_id or by their own identifier — so what it
  // returns is their own selection, not shared aggregate data. Gating it
  // emptied every heart the guest had set themselves on a gallery with
  // sharing off, which reads as the gallery silently discarding their
  // choices. Same reasoning the colour-label block below already applies;
  // this was the one per-viewer field that disagreed with it.
  const likedPhotoIds = new Set();
  if (photos.length > 0) {
    const likeQuery = db('photo_feedback')
    // Hidden rows are not there, for the viewer's OWN feedback as much as
    // anyone's (#1150). getPhotoFeedback drops them, the filter drops them
    // and updatePhotoFeedbackStats does not count them — leaving the heart
    // filled was the one place that disagreed, so a like the photographer
    // had hidden still showed as liked on a photo whose like_count was 0.
      .where({ event_id: event.id, feedback_type: 'like', is_hidden: formatBoolean(false) })
      .whereIn('photo_id', photos.map(p => p.id));
    if (identity.guestId) {
      likeQuery.where('guest_id', identity.guestId);
    } else {
      likeQuery.where('guest_identifier', identity.guestIdentifier);
    }
    const likedRows = await likeQuery.select('photo_id');
    likedRows.forEach(row => likedPhotoIds.add(row.photo_id));
  }

  // Per-viewer colour label (#1044), same identity resolution as the likes
  // above. NOT gated on showFeedbackToGuests: a guest's own label is their
  // own selection, not shared aggregate data, and hiding it would blank the
  // grid badges on every refresh in a gallery with sharing switched off.
  //
  // In shared identity mode (#1197) there is no per-viewer label to read:
  // the photo carries one tag and it belongs to everyone, so it arrives on
  // this same field. The badge, the lightbox swatch and the keyboard
  // shortcuts then work unchanged — they were already reading "the colour on
  // this photo, from my point of view", which is precisely what the shared
  // tag is.
  const myColorLabelByPhoto = {};
  if (photos.length > 0 && sharedColorMode) {
    Object.assign(
      myColorLabelByPhoto,
      await feedbackService.getSharedColorLabels(event.id, photos.map(p => p.id)),
    );
  } else if (photos.length > 0) {
    const colorQuery = db('photo_feedback')
    // Same rule as the heart above (#1150).
      .where({ event_id: event.id, feedback_type: 'color_label', is_hidden: formatBoolean(false) })
      .whereIn('photo_id', photos.map(p => p.id));
    if (identity.guestId) {
      colorQuery.where('guest_id', identity.guestId);
    } else {
      colorQuery.where('guest_identifier', identity.guestIdentifier);
    }
    const colorRows = await colorQuery.select('photo_id', 'color_label');
    colorRows.forEach(row => {
      if (row.color_label) myColorLabelByPhoto[row.photo_id] = row.color_label;
    });
  }

  // OTHER viewers' colour labels, per photo (#1178).
  //
  // The lightbox has always shown these — /photos/:id/feedback returns
  // per-colour tallies across everyone — but the grid had no field carrying
  // them, so a label set by one guest was visible in fullscreen and invisible
  // on the tile. With sharing on, that is just a hole.
  //
  // DISTINCT colours, not counts: a tile has room for a couple of dots, and
  // "who else marked this, and how" is a lightbox question. The viewer's own
  // colour is excluded here so the badge and the dots never say the same
  // thing twice — the frontend renders `my_color_label` as the badge and
  // these beside it.
  //
  // Gated on showFeedbackToGuests, like every other aggregate: this is other
  // people's feedback, unlike my_color_label above.
  //
  // Skipped entirely in shared mode (#1197). There are no other viewers'
  // labels there — there is one tag, already delivered as my_color_label
  // above. Without this the shared row would come back here too (its
  // reserved identity is not the viewer's), and every tile would render the
  // same colour twice: once as the badge, once as a dot beside it.
  const otherColorLabelsByPhoto = {};
  if (photos.length > 0 && showFeedbackToGuests && !sharedColorMode) {
    const othersQuery = db('photo_feedback')
      .where({ event_id: event.id, feedback_type: 'color_label', is_hidden: formatBoolean(false) })
      .whereIn('photo_id', photos.map(p => p.id))
      .whereNotNull('color_label')
    // The other direction of the same rule (#1197): an event switched back
    // out of shared mode keeps its shared tag, and it is nobody's — so
    // without this it would show up as an anonymous other viewer's dot on
    // every tile that still carries one.
      .where(function () {
        this.whereNot('guest_identifier', SHARED_COLOR_LABEL_IDENTITY).orWhereNull('guest_identifier');
      });
    if (identity.guestId) {
      othersQuery.where(function () {
        this.whereNot('guest_id', identity.guestId).orWhereNull('guest_id');
      });
    } else {
      const mine = identity.guestIdentifier;
      othersQuery.where(function () {
        this.whereNot('guest_identifier', mine).orWhereNull('guest_identifier');
      });
    }
    const otherRows = await othersQuery.distinct('photo_id', 'color_label');
    otherRows.forEach(row => {
      if (!otherColorLabelsByPhoto[row.photo_id]) otherColorLabelsByPhoto[row.photo_id] = [];
      if (!otherColorLabelsByPhoto[row.photo_id].includes(row.color_label)) {
        otherColorLabelsByPhoto[row.photo_id].push(row.color_label);
      }
    });
  }

  // People in each photo (#1074). Two independent gates: the feature must
  // be on for this event AND, for a plain guest, the photographer must have
  // left the strip visible. A client (PIN access) is the photographer's own
  // view, so faces_visible_to_guests doesn't restrict them.
  //
  // `photos` is already visibility-filtered above, and this only ever asks
  // about ids in that set, so it cannot widen what the caller sees.
  let peopleEnabled = false;
  let personIdsByPhoto = new Map();
  try {
    const { isEnabledForEvent, areFacesVisibleToGuests } = require('./faceSettings');
    if (photos.length > 0 && await isEnabledForEvent(event)) {
      peopleEnabled = isClient || areFacesVisibleToGuests(event);
      if (peopleEnabled) {
        const { getPersonIdsByPhoto } = require('./facePeopleService');
        personIdsByPhoto = await getPersonIdsByPhoto(
          event.id,
          photos.map(p => p.id),
          { forAdmin: isClient }
        );
      }
    }
  } catch (err) {
    // A face-feature failure must never take down the gallery payload.
    logger.warn(`gallery: person_ids lookup failed for event ${event.id}`, { error: err.message });
    peopleEnabled = false;
    personIdsByPhoto = new Map();
  }

  // Get actual categories used by photos in this event
  // This includes both global categories and event-specific ones
  const usedCategoryIds = hiddenForGuest ? [] : await db('photos')
    .where('event_id', event.id)
    .whereNotNull('category_id')
    .distinct('category_id')
    .pluck('category_id');

  // Fetch category details from photo_categories table
  let categories = [];
  if (usedCategoryIds.length > 0) {
    // Resolved category order (#782): per-event override, else global
    // default, else name — restricted to categories that have photos.
    const categoryDetails = await getEventCategoriesOrdered(event.id, {
      onlyIds: usedCategoryIds,
      select: ['c.id', 'c.name', 'c.slug', 'c.is_global', 'c.hero_photo_id', 'c.allow_downloads', 'c.is_folder'],
    });

    categories = categoryDetails.map(cat => ({
      id: cat.id,
      name: cat.name,
      slug: cat.slug,
      is_global: cat.is_global,
      hero_photo_id: cat.hero_photo_id || null,
      // Per-category download flag (#640). false explicitly disables; the
      // gallery hides the download button. Defaults true so categories
      // created before migration 135 keep working.
      allow_downloads: parseBooleanInput(cat.allow_downloads, true),
      // Folder vs filter (#1160). true = the category CONTAINS its photos:
      // they leave the root grid and only render inside the folder. Defaults
      // false so categories predating migration 185 keep filtering.
      is_folder: parseBooleanInput(cat.is_folder, false)
    }));
  }

  // Build a map for quick category lookup
  const categoryMap = {};
  categories.forEach(cat => {
    categoryMap[cat.id] = cat;
  });
    
  // Include protection settings in response
  const protectionSettings = {
    protection_level: event.protection_level || 'standard',
    image_quality: event.image_quality || 85,
    use_canvas_rendering: parseBooleanInput(event.use_canvas_rendering, false),
    overlay_protection: parseBooleanInput(event.overlay_protection, true)
  };

  // Lightbox preview tier (#492). When the admin opts in, the
  // photos response carries a preview_url alongside url/thumbnail_url
  // — the lightbox uses preview_url when present and falls back to
  // url when not, so existing galleries continue working before
  // any preview has actually been generated.
  let lightboxPreviewEnabled = false;
  try {
    const setting = await db('app_settings')
      .where('setting_key', 'lightbox_preview_enabled')
      .first();
    if (setting) {
      const raw = setting.setting_value;
      // setting_value is JSON-stringified per migration 104; tolerate
      // raw boolean/string for forward-compat.
      const parsed = typeof raw === 'string' ? (() => {
        try { return JSON.parse(raw); } catch { return raw; }
      })() : raw;
      lightboxPreviewEnabled = parsed === true || parsed === 'true' || parsed === 1;
    }
  } catch (e) {
    // Setting missing / DB blip → fall back to off so the lightbox
    // keeps working with the original. logger.debug to avoid noise.
    logger.debug('lightbox_preview_enabled lookup failed, treating as off', { error: e?.message });
  }

  // #508: when the admin has flipped the "use original camera filenames"
  // toggle (#493), the lightbox surfaces each photo's original_filename
  // alongside the position counter so the photographer can map a guest's
  // selection back to source files. Tied to the same toggle as downloads —
  // one switch controls both surfaces.
  const useOriginalFilenames = await getUseOriginalFilenames();
  const globalHeroLogoVisible = await getAppSetting('branding_logo_display_hero', true);
  const globalLogoSize = await getAppSetting('branding_logo_size', 'medium');
  const downloadPolicy = await resolveEventDownloadPolicy(event);

  return {
    pagination: { page, limit: limit || total, total, has_more: !!limit && page * limit < total },
    event: {
      id: event.id,
      event_name: event.event_name,
      event_type: event.event_type,
      event_date: event.event_date,
      welcome_message: event.welcome_message,
      color_theme: event.color_theme,
      expires_at: event.expires_at,
      hero_photo_id: event.hero_photo_id,
      // Defaults match /info: downloads on unless explicitly disabled,
      // uploads off unless explicitly enabled (#1028).
      allow_downloads: parseBooleanInput(event.allow_downloads, true),
      allow_user_uploads: parseBooleanInput(event.allow_user_uploads, false),
      // Download resolutions (#858). `choices` drives the picker modal and is
      // empty when the picker is off, so the UI can never offer a size the
      // server would reject.
      download_resolution: {
        standard: downloadPolicy.standard,
        picker_enabled: downloadPolicy.pickerEnabled,
        choices: downloadPolicy.pickerEnabled ? downloadPolicy.choices : [],
      },
      // Reveal mode (#838): armed flag lets an open VISIBLE gallery keep
      // polling so a re-hide propagates without a manual reload.
      reveal_armed: parseBooleanInput(event.reveal_mode, false),
      disable_right_click: parseBooleanInput(event.disable_right_click, false),
      watermark_downloads: parseBooleanInput(event.watermark_downloads, false),
      watermark_text: event.watermark_text,
      enable_devtools_protection: parseBooleanInput(event.enable_devtools_protection, false),
      use_canvas_rendering: parseBooleanInput(event.use_canvas_rendering, false),
      hero_logo_visible: resolveHeroLogoVisible(event.hero_logo_visible, globalHeroLogoVisible),
      hero_logo_size: event.hero_logo_size || globalLogoSize || 'medium',
      hero_logo_position: event.hero_logo_position || 'top',
      hero_logo_url: event.hero_logo_url || null,
      header_style: event.header_style || 'standard',
      hero_divider_style: event.hero_divider_style || 'wave',
      hero_image_anchor: event.hero_image_anchor || 'center',
      default_photo_sort: event.default_photo_sort || 'upload_date_desc',
      // Promo banner override (#440). GalleryView has always read
      // promo_mode from THIS payload, but it was never sent — so every
      // per-event promo override silently resolved to 'inherit' and a
      // gallery set to 'off' still showed the global banner.
      promo_mode: event.promo_mode || 'inherit',
      promo_markdown: event.promo_markdown || null,
      // Info banner override (#932). GalleryAuthContext refreshes its cached
      // event from THIS payload, so the fields have to travel here — /info
      // alone isn't enough, the context stops reading it once the guest is
      // authenticated.
      info_mode: event.info_mode || 'inherit',
      info_markdown: event.info_markdown || null,
      download_zip_ready: !!(event.download_zip_path && event.download_zip_generated_at),
      // Mirror of the admin-side toggle so the lightbox can decide
      // whether to surface original camera filenames (#508).
      use_original_filenames: useOriginalFilenames,
      // "People in this gallery" (#1074). False whenever the global flag
      // is off, detection is off for this event, or the photographer chose
      // to keep the strip to themselves — the frontend renders no face UI
      // at all in that case.
      people_enabled: peopleEnabled,
      ...protectionSettings
    },
    // Reveal mode (#838): the guest UI switches to the upload-only view
    // on this flag; reveal_at lets it show the scheduled time.
    hidden_until_reveal: hiddenForGuest,
    reveal_at: hiddenForGuest ? (event.reveal_at || null) : undefined,
    categories: categories,
    photos: photos.map(photo => {
      // Videos always take the JWT route (#1370). The secure-images template
      // below can never serve one — the route runs the bytes through sharp,
      // which throws on an mp4 — and nothing substitutes the {{token}}
      // placeholder for the <video> element either, so under enhanced/maximum
      // a video resolved to a 403 and the lightbox sat at 0:00. The matching
      // exemption is in routes/gallery/media.js.
      const isVideo = photo.media_type === 'video'
        || (photo.mime_type && photo.mime_type.startsWith('video/'));
      const useJwtUrl = isVideo
        || protectionSettings.protection_level === 'basic'
        || protectionSettings.protection_level === 'standard';
      // Watermark version (cache-busting) + admin-preview flag (#868). In
      // preview mode no gallery cookie is minted, so each <img> request must
      // re-assert the admin session — thread the flag onto every /api/gallery
      // image URL so the browser sends it (the admin_token cookie rides along
      // same-origin).
      const imgQuery = [wmVersion, adminPreview ? 'admin_preview=1' : ''].filter(Boolean).join('&');
      const wmQuery = imgQuery ? `?${imgQuery}` : '';
      const photoUrl = useJwtUrl ?
        `/api/gallery/${slug}/photo/${photo.id}${wmQuery}` :
        `/api/secure-images/${slug}/secure/${photo.id}/{{token}}`;

      return {
        id: photo.id,
        filename: photo.filename,
        // Raw camera filename (or null for pre-migration-062 uploads).
        // The lightbox renders it when `use_original_filenames` is on.
        original_filename: photo.original_filename || null,
        url: photoUrl,
        // Videos are offered the thumbnail route even with no thumbnail_path
        // recorded yet (#1414). The route regenerates lazily, and for a video
        // it now produces a poster frame or the SVG placeholder rather than
        // failing — whereas a null here makes every grid layout fall back to
        // `thumbnail_url || url` and render the ORIGINAL VIDEO into an <img>,
        // which is both a broken tile and a full download of the file. Images
        // keep the old behaviour: for them the original is a usable fallback.
        thumbnail_url: (photo.thumbnail_path || isVideo)
          ? `/api/gallery/${slug}/thumbnail/${photo.id}${wmQuery}`
          : null,
        // Hero-optimized image URL (1920x1080) for full-width hero sections
        hero_url: `/api/gallery/${slug}/hero/${photo.id}${wmQuery}`,
        // Lightbox preview URL (#492). Only emitted when the admin
        // has flipped lightbox_preview_enabled — the frontend
        // lightbox reads preview_url with a fallback to url so
        // installs that haven't opted in keep loading the original
        // (current behaviour). Skipped for videos since they don't
        // get a preview tier; lightbox will use the original .url.
        preview_url: (lightboxPreviewEnabled || originalNeedsPreview(photo))
            && photo.media_type !== 'video'
            && (!photo.mime_type || !photo.mime_type.startsWith('video/'))
          ? `/api/gallery/${slug}/preview/${photo.id}${wmQuery}`
          : null,
        // Slideshow source (#1015). Same preview tier, but emitted
        // unconditionally: the slideshow has no `url` fallback worth
        // taking (originals are projector-sized) and must never land on
        // `hero_url`, which is cover-cropped to 16:9 — that made the
        // "no crop" fit letterbox an already-cropped frame. The preview
        // route generates lazily and redirects to the original on any
        // failure, so this is safe even where no preview exists yet.
        slideshow_url: photo.media_type !== 'video'
            && (!photo.mime_type || !photo.mime_type.startsWith('video/'))
          ? `/api/gallery/${slug}/preview/${photo.id}${wmQuery}`
          : null,
        secure_url_template: `/api/secure-images/${slug}/secure/${photo.id}/{{token}}`,
        download_url_template: `/api/secure-images/${slug}/secure-download/${photo.id}/{{token}}`,
        type: photo.type,
        category_id: photo.category_id || null,
        category_name: photo.category_id && categoryMap[photo.category_id] ? categoryMap[photo.category_id].name : null,
        // Per-category download permission (#640). Defaults true for photos
        // without a category or for categories that pre-date migration 135.
        category_allow_downloads: photo.category_id && categoryMap[photo.category_id]
          ? parseBooleanInput(categoryMap[photo.category_id].allow_downloads, true)
          : true,
        category_slug: photo.category_id && categoryMap[photo.category_id] ? categoryMap[photo.category_id].slug : null,
        size: photo.size_bytes,
        // toIso: on SQLite installs rows written with a raw Date (e.g.
        // the pre-fix archive-restore path) hold epoch numbers — the
        // Timeline layout's parseISO() crashes on those (#485 class).
        uploaded_at: toIso(photo.uploaded_at),
        // Image dimensions for layout calculations
        width: photo.width || null,
        height: photo.height || null,
        // Fixed: Use the calculated useJwtUrl variable instead of recalculating
        requires_token: !useJwtUrl,
        // EXIF capture date
        captured_at: toIso(photo.captured_at) || null,
        // Media type
        media_type: photo.media_type || null,
        mime_type: photo.mime_type || null,
        duration: photo.duration || null,
        // Feedback data (hidden when show_feedback_to_guests is disabled)
        has_feedback: showFeedbackToGuests ? (commentMap[photo.id] > 0 || photo.average_rating > 0 || photo.like_count > 0) : false,
        average_rating: showFeedbackToGuests ? (photo.average_rating || 0) : 0,
        comment_count: showFeedbackToGuests ? (commentMap[photo.id] || 0) : 0,
        like_count: showFeedbackToGuests ? (photo.like_count || 0) : 0,
        // Per-viewer flag (#590 follow-up) — true when this viewer has
        // an active like row for this photo, false otherwise. Lets the
        // grid seed its lifted likedPhotoIds correctly on hard refresh.
        // Survives show_feedback_to_guests being off (#1286): the viewer's
        // own heart is theirs, and the like_count beside it stays hidden.
        is_liked: likedPhotoIds.has(photo.id),
        favorite_count: showFeedbackToGuests ? (photo.favorite_count || 0) : 0,
        // Colour labels (#1044). The COUNT is aggregate data and follows
        // show_feedback_to_guests like its siblings; the viewer's OWN label
        // is not aggregate and must survive with sharing off, otherwise the
        // grid badge disappears on refresh for the very guest who set it.
        color_label_count: showFeedbackToGuests ? (photo.color_label_count || 0) : 0,
        my_color_label: myColorLabelByPhoto[photo.id] || null,
        // Distinct colours other viewers put on this photo (#1178), so the
        // grid can show them beside the viewer's own badge. Empty with
        // sharing off — it is other people's feedback.
        other_color_labels: otherColorLabelsByPhoto[photo.id] || [],
        // People in this photo (#1074). Empty array when the feature is
        // off for this event or hidden from guests, so the frontend has
        // one shape to handle. Riding along on this payload is what keeps
        // face filtering client-side and instant, like the category and
        // liked/rated filters.
        person_ids: personIdsByPhoto.get(photo.id) || [],
        // Visibility (only included for clients)
        ...(isClient ? { visibility: photo.visibility || 'visible' } : {})
      };
    })
  };
}
module.exports = { getGalleryPhotos };
