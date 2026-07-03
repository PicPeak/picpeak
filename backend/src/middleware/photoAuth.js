const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { db } = require('../database/db');
const { formatBoolean } = require('../utils/dbCompat');
const { getGalleryTokenFromRequest } = require('../utils/tokenUtils');
const logger = require('../utils/logger');

async function photoAuth(req, res, next) {
  try {
    // Extract event slug from the path
    let eventSlug;
    
    // For thumbnails, we need to parse the filename to get the event info
    if (req.path.startsWith('/thumb_')) {
      // For now, we'll rely on JWT token for thumbnail access
      eventSlug = null;
    } else {
      // For regular photos, the slug is the first part of the path
      eventSlug = req.path.split('/')[1];
    }
    
    // First check for JWT token (from gallery access)
    const tokenFromRequest = getGalleryTokenFromRequest(req, eventSlug);
    if (tokenFromRequest) {
      const token = tokenFromRequest;
      try {
        // Try to verify with issuer first, fallback to no issuer for backward compatibility
        let decoded;
        try {
          decoded = jwt.verify(token, process.env.JWT_SECRET, {
            issuer: 'picpeak-auth'
          });
        } catch (issuerError) {
          // If verification fails with issuer, try without issuer (backward compatibility)
          if (issuerError.name === 'JsonWebTokenError' && issuerError.message.includes('jwt issuer invalid')) {
            decoded = jwt.verify(token, process.env.JWT_SECRET);
          } else {
            throw issuerError;
          }
        }
        
        // Check if it's a gallery token
        if (decoded.type === 'gallery') {
          // For thumbnails, we need to verify the token is for a valid event
          if (!eventSlug) {
            // Extract event ID from the decoded token
            if (decoded.eventId) {
              const event = await db('events')
                .where({ id: decoded.eventId, is_active: formatBoolean(true) })
                .first();
              if (event) {
                req.event = event;
                return next();
              }
            }
            // Fallback to slug
            const event = await db('events')
              .where({ slug: decoded.eventSlug, is_active: formatBoolean(true) })
              .first();
            if (event) {
              req.event = event;
              return next();
            }
          }
          // For regular photos, check if token matches the event
          else if (decoded.eventSlug === eventSlug) {
            const event = await db('events')
              .where({ slug: eventSlug, is_active: formatBoolean(true) })
              .first();
            if (event) {
              req.event = event;
              return next();
            }
          }
        }
        
        // Check if it's an admin token (admins can view all photos)
        if (decoded.type === 'admin') {
          // For both thumbnails and photos with admin token, allow access
          return next();
        }
    } catch (err) {
      // Token invalid, fall through to password check
      logger.warn('JWT verification failed in photoAuth', { error: err.message });
      }
    }
    
    // Check for password header (legacy support)
    const password = req.headers['x-gallery-password'];
    
    // If no eventSlug (thumbnails), and we don't have valid auth yet, deny access
    if (!eventSlug && !password && !tokenFromRequest) {
      return res.status(401).json({ error: 'Authentication required for thumbnails' });
    }

    const event = await db('events').where({ slug: eventSlug, is_active: formatBoolean(true) }).first();
    if (!event) {
      return res.status(404).json({ error: 'Gallery not found' });
    }

    const requiresPassword = !(event.require_password === false || event.require_password === 0 || event.require_password === '0');

    if (!requiresPassword) {
      req.event = event;
      return next();
    }
    
    if (!password && !tokenFromRequest) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (password) {
      const validPassword = await bcrypt.compare(password, event.password_hash);
      if (!validPassword) {
        await db('access_logs').insert({
          event_id: event.id,
          ip_address: req.ip,
          user_agent: req.headers['user-agent'],
          action: 'login_fail'
        });
        return res.status(401).json({ error: 'Invalid password' });
      }
    } else {
      // No valid authentication
      return res.status(401).json({ error: 'Invalid authentication' });
    }
    
    req.event = event;
    next();
  } catch (error) {
    logger.error('Photo auth error', { error: error.message, stack: error.stack });
    res.status(500).json({ error: 'Authentication error' });
  }
}

module.exports = photoAuth;
