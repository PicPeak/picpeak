'use strict';

/**
 * Extract user-facing "What's New" bullets from a GitHub release body.
 *
 * Prefers the curated block the release CI injects via GitHub Models:
 *   <!-- whatsnew -->\n- bullet\n- bullet\n<!-- /whatsnew -->
 * and falls back to the release-please "### Features" section for releases
 * created before that CI step existed — so the feature works against
 * today's releases too (just with longer, auto-cleaned lines).
 *
 * Returns at most MAX_BULLETS cleaned strings.
 */

const MAX_BULLETS = 8;

/**
 * Decode the handful of HTML entities release-please escapes into changelog
 * text (a raw "/s/<slug>" in a commit subject lands as "/s/&lt;slug&gt;").
 * Without this the banner shows the literal entity, since React renders text
 * nodes verbatim. `&amp;` is decoded last so "&amp;lt;" stays "&lt;".
 */
function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&#x0*27;|&apos;/gi, '\'')
    .replace(/&amp;/g, '&');
}

/** Strip list markers, conventional-commit scope, and trailing PR/sha links. */
function cleanBullet(line) {
  return decodeEntities(line
    .replace(/^\s*[-*]\s+/, '')                  // "- " / "* " marker
    .replace(/^\*\*([^:*]+):\*\*\s*/, '')         // "**scope:** " prefix
    .replace(/\s*\(\[[^\]]*\]\([^)]*\)\)/g, '')   // " ([#41](url))" / " ([sha](url))"
    .replace(/\s*\(#\d+\)/g, '')                  // bare " (#41)"
    .replace(/`/g, ''))
    // Drop a trailing "— implementation detail" clause so a release highlight
    // reads as the headline ("branded URL shortener"), not the commit subject
    // ("branded URL shortener — /s/<slug> with OG injection"). Em dash only, so
    // hyphenated words ("mark-paid") are untouched. Skipped if it would empty
    // the bullet (i.e. nothing before the dash).
    .replace(/^(.+?\S)\s+—\s+.*$/, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Pull the lines under a "## Features" / "### Features" heading. */
function extractFeaturesSection(body) {
  const out = [];
  let inFeatures = false;
  for (const raw of body.split('\n')) {
    const line = raw.trimEnd();
    if (/^#{2,4}\s+Features\b/i.test(line)) { inFeatures = true; continue; }
    if (inFeatures && /^#{1,4}\s+\S/.test(line)) break; // next heading ends the section
    if (inFeatures) out.push(line);
  }
  return out.join('\n');
}

/**
 * @param {string} body release notes markdown
 * @returns {string[]} up to 8 user-facing bullet strings
 */
function parseWhatsNew(body) {
  if (!body || typeof body !== 'string') return [];
  const block = body.match(/<!--\s*whatsnew\s*-->([\s\S]*?)<!--\s*\/whatsnew\s*-->/i);
  const src = block ? block[1] : extractFeaturesSection(body);
  const bullets = src
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s+/.test(l))
    .map(cleanBullet)
    .filter((l) => l.length > 0);
  // De-dup while preserving order, then cap.
  const seen = new Set();
  const unique = [];
  for (const b of bullets) {
    const key = b.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(b);
  }
  return unique.slice(0, MAX_BULLETS);
}

module.exports = { parseWhatsNew };
