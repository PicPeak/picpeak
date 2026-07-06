const { db } = require('../database/db');

let cachedRobotsTxt = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60 * 1000; // 60 seconds

function parseSetting(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function getSeoSettings() {
  const rows = await db('app_settings')
    .where('setting_type', 'seo')
    .select('setting_key', 'setting_value');

  const settings = {};
  for (const row of rows) {
    settings[row.setting_key] = parseSetting(row.setting_value);
  }
  return settings;
}

const SOCIAL_BOTS = [
  'Twitterbot',
  'facebookexternalhit',
  'LinkedInBot',
  'Slackbot',
  'WhatsApp',
  'TelegramBot',
  'Discordbot'
];

async function generateRobotsTxt() {
  const now = Date.now();
  if (cachedRobotsTxt && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedRobotsTxt;
  }

  const settings = await getSeoSettings();
  const allowIndexing = settings.seo_allow_indexing === true;
  const blockAiCrawlers = settings.seo_block_ai_crawlers !== false;
  const blockSocialBots = settings.seo_block_social_bots === true;
  const aiAgents = Array.isArray(settings.seo_blocked_ai_agents)
    ? settings.seo_blocked_ai_agents
    : [];
  const customRules = Array.isArray(settings.seo_custom_rules)
    ? settings.seo_custom_rules
    : [];
  const sitemapUrl = settings.seo_sitemap_url || '';

  const lines = [];

  // Always block admin and API paths for all agents
  lines.push('# Protected paths');
  lines.push('User-agent: *');
  lines.push('Disallow: /admin');
  lines.push('Disallow: /api');
  lines.push('');

  if (!allowIndexing) {
    // Block everything for all agents
    lines.push('# Indexing disabled - block all crawlers');
    lines.push('User-agent: *');
    lines.push('Disallow: /');
    lines.push('');
  }

  // Block AI crawlers if enabled
  if (blockAiCrawlers && aiAgents.length > 0) {
    lines.push('# AI/LLM crawler blocking');
    for (const agent of aiAgents) {
      lines.push(`User-agent: ${agent}`);
      lines.push('Disallow: /');
      lines.push('');
    }
  }

  // Block social bots if enabled
  if (blockSocialBots) {
    lines.push('# Social media bot blocking');
    for (const bot of SOCIAL_BOTS) {
      lines.push(`User-agent: ${bot}`);
      lines.push('Disallow: /');
      lines.push('');
    }
  }

  // Custom rules
  if (customRules.length > 0) {
    lines.push('# Custom rules');
    for (const rule of customRules) {
      if (rule.userAgent && Array.isArray(rule.disallow)) {
        lines.push(`User-agent: ${rule.userAgent}`);
        for (const path of rule.disallow) {
          lines.push(`Disallow: ${path}`);
        }
        lines.push('');
      }
    }
  }

  // Sitemap
  if (sitemapUrl) {
    lines.push(`Sitemap: ${sitemapUrl}`);
    lines.push('');
  }

  const result = lines.join('\n');
  cachedRobotsTxt = result;
  cacheTimestamp = now;
  return result;
}

function clearRobotsTxtCache() {
  cachedRobotsTxt = null;
  cacheTimestamp = 0;
}

module.exports = {
  generateRobotsTxt,
  clearRobotsTxtCache
};
