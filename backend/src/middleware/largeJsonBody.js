/**
 * The 50 MB JSON parser, for callers who have already proven who they are.
 *
 * The admin and API-token surfaces need large bodies (restore manifests, CMS
 * and email templates, bulk operations). Mounted plainly on /api/admin and
 * /api/v1 the parser ran before any authentication, so anyone could hand
 * JSON.parse a 50 MB nested body and block the event loop, bounded only by
 * the general rate limiter (security review 2026-09-29).
 *
 * This middleware parses at the large limit only when the request carries an
 * admin JWT whose signature verifies, or an API token that exists. Anything
 * else falls through untouched to the ordinary 2 MB parser registered after
 * it, so an unauthenticated oversized body is refused with 413 before it is
 * ever parsed. Presence of a header is not enough — a forged cookie or a
 * made-up Bearer token must cost the attacker the same as no token at all.
 *
 * The full authentication (revocation, is_active, must_change_password) still
 * happens in adminAuth / apiTokenAuth afterwards; this only decides the body
 * limit — and it decides it only when the decision matters. A body that
 * cannot exceed the ordinary limit (an uncompressed JSON body whose
 * Content-Length is within it, or no JSON body at all) goes straight to the
 * ordinary parser without any check, so
 * the API-token lookup never runs for normal traffic, and a request that
 * merely carries a made-up Bearer header costs the database nothing unless
 * it also claims a body the small parser would refuse.
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { db } = require('../database/db');
const { getAdminTokenFromRequest } = require('../utils/tokenUtils');

const API_TOKEN_PREFIX = 'pp_live_';

function hasVerifiedAdminJwt(req) {
  const token = getAdminTokenFromRequest(req);
  if (!token || token.startsWith(API_TOKEN_PREFIX)) return false;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: 'picpeak-auth',
    });
    return !!decoded && decoded.type === 'admin';
  } catch {
    return false;
  }
}

async function hasKnownApiToken(req) {
  const header = req.headers?.authorization || '';
  if (!header.startsWith(`Bearer ${API_TOKEN_PREFIX}`)) return false;
  const hashed = crypto.createHash('sha256').update(header.slice(7).trim()).digest('hex');
  const row = await db('api_tokens').where({ hashed_token: hashed }).whereNull('revoked_at').select('id').first();
  return !!row;
}

/**
 * Could this body be more than the ordinary parser accepts? Only a JSON body
 * whose declared length is over the small limit, or a chunked JSON body with
 * no declared length, needs the large parser at all.
 */
function mightExceed(req, fallbackLimitBytes) {
  if (!req.is('application/json')) return false;
  // express.json inflates gzip/deflate bodies and applies its limit to the
  // inflated size, so a compressed Content-Length says nothing about it.
  const encoding = String(req.headers['content-encoding'] || 'identity').trim().toLowerCase();
  if (encoding !== 'identity') return true;
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared)) return declared > fallbackLimitBytes;
  return /chunked/i.test(req.headers['transfer-encoding'] || '');
}

function createLargeJsonBody({ limit = '50mb', fallbackLimitBytes = 2 * 1024 * 1024 } = {}) {
  const parser = express.json({ limit });
  return async function largeJsonBody(req, res, next) {
    try {
      if (!mightExceed(req, fallbackLimitBytes)) return next();
      if (hasVerifiedAdminJwt(req) || await hasKnownApiToken(req)) {
        return parser(req, res, next);
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { createLargeJsonBody, hasVerifiedAdminJwt, hasKnownApiToken, mightExceed };
