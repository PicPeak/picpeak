const { db } = require('../database/db');
const logger = require('../utils/logger');
const { ensureThumbnail } = require('./imageProcessor');
const { getStorage } = require('./storage');

const SOCIAL_CRAWLER_PATTERNS = [
  /facebookexternalhit/i,
  /facebot/i,
  /Twitterbot/i,
  // WhatsApp's main app crawler is "WhatsApp/X.Y.Z"; the Business
  // API and some Cloud API senders use "WhatsAppBot" or "wa-bot/" —
  // detect both so API-driven sends get the rich preview too (#521).
  /WhatsApp/i,
  /WhatsAppBot/i,
  /wa-bot/i,
  /Slackbot/i,
  /TelegramBot/i,
  /SkypeUriPreview/i,
  /Discordbot/i,
  /LinkedInBot/i,
  /Pinterest/i,
  /vkShare/i,
  /redditbot/i,
  /Embedly/i,
  /iframely/i,
  /Snapchat/i,
  /Applebot/i,
  /quora link preview/i,
  /Mastodon/i,
  /Bluesky/i,
  /OpenGraph/i,
  /opengraph/i,
  // Generic preview/scrape services commonly used in business
  // messaging stacks (Twilio, LinkPreview.net, etc.). Match the
  // canonical lowercase substring; the /i flag handles case.
  /LinkPreview/i,
  /Slack-ImgProxy/i
];

function isSocialCrawler(userAgent) {
  if (!userAgent) return false;
  return SOCIAL_CRAWLER_PATTERNS.some((re) => re.test(userAgent));
}

function parseSettingValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function fetchBranding() {
  const rows = await db('app_settings')
    .whereIn('setting_key', [
      'branding_company_name',
      'branding_company_tagline',
      'branding_logo_url'
    ]);

  const branding = { companyName: null, companyTagline: null, logoUrl: null };
  for (const row of rows) {
    const parsed = parseSettingValue(row.setting_value);
    switch (row.setting_key) {
    case 'branding_company_name':
      branding.companyName = parsed || null;
      break;
    case 'branding_company_tagline':
      branding.companyTagline = parsed || null;
      break;
    case 'branding_logo_url':
      branding.logoUrl = parsed || null;
      break;
    default:
      break;
    }
  }
  return branding;
}

async function resolveSlug(slug) {
  let event = await db('events').where('slug', slug).first();
  if (event) return event;
  // Honour slug redirects so renamed galleries still get rich previews.
  const hasRedirects = await db.schema.hasTable('event_slug_redirects');
  if (hasRedirects) {
    const redirect = await db('event_slug_redirects').where('old_slug', slug).first();
    if (redirect) {
      event = await db('events').where('slug', redirect.new_slug).first();
    }
  }
  if (event) return event;
  // Fall back to share-token lookup (#699). Operators share both
  // forms — the slug-based URL (`/gallery/<slug>` after #525's
  // short-URLs option strips the slug into the token-only form) AND
  // the historical token URL (`/gallery/<32-hex>`). The token URL
  // would otherwise route here with `slug=<token>`, fail the slug
  // lookup, and serve the fallback site-wide OG — which is what
  // alex hit when he ran the Cloudflare Worker as a workaround.
  if (/^[a-f0-9]{32}$/i.test(slug)) {
    event = await db('events').where('share_token', slug).first();
    if (event) return event;
  }
  return null;
}

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function absoluteUrl(maybeRelative, base) {
  if (!maybeRelative) return null;
  if (/^https?:\/\//i.test(maybeRelative)) return maybeRelative;
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return null;
  }
}

function frontendBase() {
  return (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
}

// Render the event date for the OG preview card respecting the
// admin-configured `general_date_format` (defaults to DD.MM.YYYY when
// unset). Previously hardcoded en-US "May 20, 2026" which ignored the
// operator's locale.
async function formatEventDate(value) {
  if (!value) return null;
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    const { formatDate } = require('../utils/dateFormatter');
    return await formatDate(d);
  } catch {
    return null;
  }
}

async function buildOgMetadata(slug, requestPath) {
  const event = await resolveSlug(slug);
  const branding = await fetchBranding();
  const base = frontendBase();
  const siteName = branding.companyName || 'PicPeak';
  const logoUrl = absoluteUrl(branding.logoUrl, base) || `${base}/picpeak-logo-transparent.png`;

  if (!event) {
    return {
      title: siteName,
      description: branding.companyTagline || 'Photo gallery shared with PicPeak.',
      image: logoUrl,
      url: `${base}${requestPath}`,
      siteName
    };
  }

  const eventName = event.event_name || 'Photo Gallery';
  const eventDate = await formatEventDate(event.event_date);
  const titleParts = [eventName];
  if (siteName && siteName !== eventName) titleParts.push(siteName);
  const title = titleParts.join(' — ');

  let description;
  if (event.welcome_message) {
    description = String(event.welcome_message).replace(/\s+/g, ' ').trim().slice(0, 200);
  } else if (eventDate) {
    description = `Photo gallery from ${eventName} on ${eventDate}.`;
  } else {
    description = `Photo gallery from ${eventName}.`;
  }

  // Per-event hero-photo opt-in (#474). When the admin has flipped
  // events.og_image_share_enabled AND a hero_photo_id is set AND that
  // photo has a generated thumbnail, point og:image at the public
  // cover endpoint instead of the brand logo. Falls back silently to
  // the logo on any of those misses so a half-configured event still
  // gets a polished link preview rather than a broken image.
  let image = logoUrl;
  if (event.og_image_share_enabled && event.hero_photo_id) {
    const heroPhoto = await db('photos')
      .where({ id: event.hero_photo_id, event_id: event.id })
      .select('id', 'thumbnail_path')
      .first();
    if (heroPhoto && heroPhoto.thumbnail_path) {
      image = `${base}/og/gallery/${event.slug}/cover`;
    }
  }

  return {
    title,
    description,
    image,
    url: `${base}/gallery/${event.slug}`,
    siteName,
    eventName,
    eventDate
  };
}

function renderOgHtml(meta) {
  const t = escapeHtml(meta.title);
  const d = escapeHtml(meta.description);
  const i = escapeHtml(meta.image);
  const u = escapeHtml(meta.url);
  const s = escapeHtml(meta.siteName);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${t}</title>
  <meta name="description" content="${d}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="${s}" />
  <meta property="og:title" content="${t}" />
  <meta property="og:description" content="${d}" />
  <meta property="og:url" content="${u}" />
  <meta property="og:image" content="${i}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${t}" />
  <meta name="twitter:description" content="${d}" />
  <meta name="twitter:image" content="${i}" />
  <link rel="canonical" href="${u}" />
</head>
<body>
  <h1>${t}</h1>
  <p>${d}</p>
  <p><a href="${u}">View gallery</a></p>
</body>
</html>`;
}

async function handleGalleryOgRequest(req, res) {
  try {
    const { slug } = req.params;
    if (!slug || !/^[a-zA-Z0-9_-]{1,255}$/.test(slug)) {
      res.status(400).type('text/plain').send('Invalid gallery slug');
      return;
    }
    const meta = await buildOgMetadata(slug, req.originalUrl);
    res.set('Cache-Control', 'public, max-age=300');
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(renderOgHtml(meta));
  } catch (error) {
    logger.error('Failed to render gallery OG page', { error: error.message });
    res.status(500).type('text/plain').send('Internal server error');
  }
}

/**
 * Public cover-image endpoint for OG/Twitter Card previews (#474).
 *
 * Streams the gallery's hero-photo thumbnail unauthenticated — but
 * ONLY when the admin has flipped events.og_image_share_enabled on
 * that event. Any miss (slug not found, opt-in not set, no hero, no
 * thumbnail) returns 404; buildOgMetadata above falls back to the
 * brand logo for the og:image when this would 404, so callers never
 * see a broken-image preview.
 *
 * Why a dedicated endpoint instead of reusing /api/gallery/:slug/
 * thumbnail/:photoId — the latter is gated by verifyGalleryAccess
 * (gallery JWT or per-event password). Social crawlers don't carry
 * either, so we need a separate, explicitly-public path that the
 * admin opted into.
 */
async function handleGalleryOgCover(req, res) {
  try {
    const { slug } = req.params;
    if (!slug || !/^[a-zA-Z0-9_-]{1,255}$/.test(slug)) {
      res.status(400).type('text/plain').send('Invalid gallery slug');
      return;
    }
    const event = await resolveSlug(slug);
    if (!event || !event.og_image_share_enabled || !event.hero_photo_id) {
      res.status(404).type('text/plain').send('Cover not available');
      return;
    }

    const photo = await db('photos')
      .where({ id: event.hero_photo_id, event_id: event.id })
      .first();
    if (!photo) {
      res.status(404).type('text/plain').send('Cover not available');
      return;
    }

    const thumbnailPath = await ensureThumbnail(photo);
    if (!thumbnailPath) {
      res.status(404).type('text/plain').send('Cover not available');
      return;
    }

    const storage = getStorage();
    const stat = await storage.stat(thumbnailPath);
    if (!stat) {
      res.status(404).type('text/plain').send('Cover not available');
      return;
    }

    // ETag = thumbnail mtime + photo id so a regenerated thumb (e.g.
    // after the admin changes thumbnail fit mode) busts crawler
    // caches. Keep the cache window short on the response itself —
    // crawlers like WhatsApp re-fetch eagerly; admins shouldn't have
    // to wait an hour for a swap to land in chat previews.
    const mtimeMs = stat.mtime ? stat.mtime.getTime() : 0;
    const etag = `"og-cover-${photo.id}-${mtimeMs}"`;
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }
    res.set({
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'ETag': etag,
    });
    if (stat.size) res.setHeader('Content-Length', stat.size);
    const stream = await storage.get(thumbnailPath);
    stream.pipe(res);
  } catch (error) {
    logger.error('Failed to stream gallery OG cover', { error: error.message });
    res.status(500).type('text/plain').send('Internal server error');
  }
}

module.exports = {
  isSocialCrawler,
  buildOgMetadata,
  renderOgHtml,
  handleGalleryOgRequest,
  handleGalleryOgCover
};
