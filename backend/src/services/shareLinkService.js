const { db } = require('../database/db');
const { formatBoolean } = require('../utils/dbCompat');
const { extractShareToken, isPotentialShareToken, buildSharePath } = require('../utils/shareLinkUtils');
const { getFrontendBaseUrl } = require('../utils/frontendUrl');

const SETTING_KEY = 'general_short_gallery_urls';
const CACHE_TTL_MS = 60_000;

let cachedSetting = null;
let cacheExpiresAt = 0;

const parseSettingValue = (rawValue) => {
  if (rawValue === undefined || rawValue === null) {
    return null;
  }

  if (typeof rawValue === 'boolean') {
    return rawValue;
  }

  if (typeof rawValue === 'number') {
    return rawValue !== 0;
  }

  if (typeof rawValue === 'string') {
    const trimmed = rawValue.trim();
    if (!trimmed) {
      return null;
    }

    try {
      const parsed = JSON.parse(trimmed);
      return parseSettingValue(parsed);
    } catch {
      const normalized = trimmed.toLowerCase();
      if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
        return true;
      }
      if (normalized === 'false' || normalized === '0' || normalized === 'no') {
        return false;
      }
      return null;
    }
  }

  if (typeof rawValue === 'object') {
    try {
      return parseSettingValue(JSON.parse(JSON.stringify(rawValue)));
    } catch {
      return null;
    }
  }

  return null;
};

const getRawSettingValue = async () => {
  try {
    const setting = await db('app_settings').where({ setting_key: SETTING_KEY }).first();
    return setting?.setting_value ?? null;
  } catch (error) {
    console.error('Failed to read gallery URL setting:', error.message);
    return null;
  }
};

const isShortGalleryUrlsEnabled = async () => {
  if (cachedSetting !== null && Date.now() < cacheExpiresAt) {
    return cachedSetting;
  }

  const rawValue = await getRawSettingValue();
  const parsed = parseSettingValue(rawValue);
  cachedSetting = parsed === null ? false : Boolean(parsed);
  cacheExpiresAt = Date.now() + CACHE_TTL_MS;
  return cachedSetting;
};

const clearShareLinkSettingsCache = () => {
  cachedSetting = null;
  cacheExpiresAt = 0;
};

const buildShareLinkVariants = async ({ slug, shareToken }) => {
  if (!shareToken) {
    throw new Error('shareToken is required to build share link variants');
  }

  const shortEnabled = await isShortGalleryUrlsEnabled();
  const sharePath = buildSharePath(slug, shareToken, shortEnabled);
  const frontendBase = await getFrontendBaseUrl();
  const shareUrl = frontendBase ? `${frontendBase}${sharePath}` : sharePath;

  return {
    shortEnabled,
    sharePath,
    shareUrl,
    shareLinkToStore: sharePath
  };
};

const getEventShareToken = (event) => {
  if (!event) {
    return null;
  }

  if (event.share_token) {
    return event.share_token;
  }

  return extractShareToken(event.share_link);
};

const ACTIVE_EVENT_FILTER = {
  is_active: formatBoolean(true),
  is_archived: formatBoolean(false),
  is_draft: formatBoolean(false)
};

const resolveShareIdentifier = async (identifier) => {
  if (!identifier) {
    return null;
  }

  const trimmed = String(identifier).trim();
  if (!trimmed) {
    return null;
  }

  const baseQuery = db('events')
    .select(
      'id',
      'slug',
      'share_link',
      'share_token',
      'require_password',
      'event_name',
      'event_type',
      'event_date',
      'expires_at',
      'is_active',
      'is_archived'
    )
    .where(ACTIVE_EVENT_FILTER);

  let event = await baseQuery.clone().where({ slug: trimmed }).first();
  if (event) {
    return { event, matchType: 'slug', shareToken: getEventShareToken(event) };
  }

  event = await baseQuery.clone().where({ share_token: trimmed }).first();
  if (event) {
    return { event, matchType: 'token', shareToken: getEventShareToken(event) };
  }

  event = await baseQuery.clone().where({ share_link: trimmed }).first();
  if (event) {
    return { event, matchType: 'link', shareToken: getEventShareToken(event) };
  }

  event = await baseQuery.clone().where('share_link', 'like', `%/${trimmed}`).first();
  if (event) {
    return { event, matchType: 'link_partial', shareToken: getEventShareToken(event) };
  }

  // As a final fallback, if identifier looks like a token but we did not match via share_token
  if (isPotentialShareToken(trimmed)) {
    event = await baseQuery.clone().whereRaw('LOWER(share_token) = ?', [trimmed.toLowerCase()]).first();
    if (event) {
      return { event, matchType: 'token_case_insensitive', shareToken: getEventShareToken(event) };
    }
  }

  return null;
};

module.exports = {
  isShortGalleryUrlsEnabled,
  clearShareLinkSettingsCache,
  buildShareLinkVariants,
  getEventShareToken,
  resolveShareIdentifier
};
