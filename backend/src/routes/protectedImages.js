const express = require('express');
const { db } = require('../database/db');
const { formatBoolean } = require('../utils/dbCompat');
const { verifyGalleryAccess } = require('../middleware/gallery');
const { blockHiddenGallery, bypassesReveal, isGalleryHidden } = require('../utils/revealMode');
const watermarkService = require('../services/watermarkService');
const secureImageService = require('../services/secureImageService');
const { getStorage } = require('../services/storage');
const { resolvePhotoStorageKey, resolvePhotoFilePath } = require('../services/photoResolver');
const { withLocalCopy } = require('../services/imageProcessor');
const { isPhotoHiddenFromViewer, canSeeHiddenPhotos } = require('../utils/photoVisibility');
const crypto = require('crypto');
const logger = require('../utils/logger');
const { timingSafeEqualStr } = require('../utils/timingSafe');

const router = express.Router();

/**
 * Generate a signed URL token for image access
 */
function generateImageToken(photoId, expiresIn = 3600, revealBypass = false, clientBypass = false) {
  const secret = process.env.JWT_SECRET;
  const expires = Date.now() + (expiresIn * 1000);
  // Third segment (#838): whether the minting context bypasses reveal mode
  // (slideshow/client/admin). Fourth segment: whether the minter was a
  // PIN-client, allowing the serve route to still deliver a photo that was
  // hidden AFTER minting (TOCTOU) — a guest's token carries 0, so it stops
  // working the moment the photo is hidden. Old shorter tokens verify
  // unchanged and read both flags as no-bypass.
  const data = `${photoId}:${expires}:${revealBypass ? 1 : 0}:${clientBypass ? 1 : 0}`;
  const signature = crypto.createHmac('sha256', secret).update(data).digest('hex');
  return `${Buffer.from(data).toString('base64')}.${signature}`;
}

/**
 * Verify image token
 */
function verifyImageToken(token) {
  try {
    const secret = process.env.JWT_SECRET;
    const [data, signature] = token.split('.');
    const decoded = Buffer.from(data, 'base64').toString();
    const [photoId, expires, bypassFlag, clientFlag] = decoded.split(':');

    // Verify signature (constant-time — avoids leaking the HMAC byte-by-byte)
    const expectedSignature = crypto.createHmac('sha256', secret).update(decoded).digest('hex');
    if (!timingSafeEqualStr(signature, expectedSignature)) {
      return null;
    }

    // Check expiration
    if (Date.now() > parseInt(expires)) {
      return null;
    }

    return {
      photoId: parseInt(photoId),
      expires: parseInt(expires),
      revealBypass: bypassFlag === '1',
      clientBypass: clientFlag === '1',
    };
  } catch (error) {
    return null;
  }
}

/**
 * Serve protected image with enhanced security
 */
router.get('/:slug/photo/:photoId/view', verifyGalleryAccess, blockHiddenGallery, async (req, res) => {
  try {
    const { photoId } = req.params;
    const { protectionLevel = 'standard', token } = req.query;
    
    // Create client fingerprint
    const clientFingerprint = secureImageService.createClientFingerprint(req);
    
    // Check rate limiting
    if (!secureImageService.checkRateLimit(clientFingerprint, 30, 60000)) {
      return res.status(429).json({ error: 'Rate limit exceeded' });
    }
    
    // Get photo details
    const photo = await db('photos')
      .where({
        id: photoId,
        event_id: req.event.id
      })
      .first();
    
    if (!photo) {
      return res.status(404).json({ error: 'Photo not found' });
    }

    // Block guest access to hidden/client-only photos (parity with the
    // gallery single-photo routes).
    if (isPhotoHiddenFromViewer(photo, req.accessLevel)) {
      return res.status(403).json({ error: 'Photo not available' });
    }

    // Check for suspicious activity
    const isSuspicious = await secureImageService.detectSuspiciousActivity(clientFingerprint, photoId);
    if (isSuspicious) {
      return res.status(429).json({ error: 'Suspicious activity detected' });
    }
    
    // Log access
    await secureImageService.logImageAccess(photoId, req.event.id, {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      fingerprint: clientFingerprint
    }, 'view');
    
    // Get protection settings from event
    const eventProtectionLevel = req.event.protection_level || protectionLevel;
    const protectionSettings = {
      protectionLevel: eventProtectionLevel,
      quality: req.event.image_quality || 85,
      addFingerprint: req.event.add_fingerprint !== false,
      fragmentImage: eventProtectionLevel === 'maximum'
    };

    // Resolve photo location through the storage backend (managed) or local
    // disk (external reference mode).
    const storageKey = resolvePhotoStorageKey(req.event, photo);
    const storage = getStorage();

    const needsProcessing = eventProtectionLevel === 'enhanced' ||
                            eventProtectionLevel === 'maximum' ||
                            protectionSettings.addFingerprint;

    let finalImage;

    if (!needsProcessing) {
      // Serve original bytes via the storage backend (or local disk for external).
      if (storageKey) {
        const stream = await storage.get(storageKey);
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        finalImage = Buffer.concat(chunks);
      } else {
        const fs = require('fs').promises;
        finalImage = await fs.readFile(resolvePhotoFilePath(req.event, photo));
      }
    } else {
      // secureImageService.processProtectedImage operates on a local path.
      // Materialize a tmp local copy in S3 mode, then run processing.
      const runProcessing = (lp) => secureImageService.processProtectedImage(lp, protectionSettings);
      const processedImage = storageKey
        ? await withLocalCopy(storageKey, runProcessing)
        : await runProcessing(resolvePhotoFilePath(req.event, photo));

      if (processedImage.type === 'fragmented') {
        return res.json({
          type: 'fragmented',
          fragments: processedImage.fragments.map(f => ({
            index: f.index,
            row: f.row,
            col: f.col,
            data: f.buffer.toString('base64'),
            position: f.position
          })),
          dimensions: processedImage.originalDimensions,
          fragmentDimensions: processedImage.fragmentDimensions
        });
      }

      finalImage = processedImage;
    }
    
    // Set security headers
    res.set({
      'Content-Type': photo.mime_type || 'image/jpeg',
      'Content-Length': finalImage.length,
      'Cache-Control': 'private, no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'X-Download-Options': 'noopen',
      'Content-Disposition': 'inline; filename="protected-image.jpg"'
    });
    
    // Send the protected image
    res.send(finalImage);
    
  } catch (error) {
    logger.error('Error serving protected image:', error);
    res.status(500).json({ error: 'Failed to serve image' });
  }
});

/**
 * Generate secure token for enhanced image access
 */
router.post('/:slug/photo/:photoId/generate-secure-token', verifyGalleryAccess, blockHiddenGallery, async (req, res) => {
  try {
    const { photoId } = req.params;
    const { protectionLevel = 'standard', expiresIn = 300 } = req.body;
    
    // Verify photo belongs to this event
    const photo = await db('photos')
      .where({
        id: photoId,
        event_id: req.event.id
      })
      .first();
    
    if (!photo) {
      return res.status(404).json({ error: 'Photo not found' });
    }

    // Don't mint a secure-image capability for a hidden/client-only photo
    // when the caller isn't a client — the serve route is token-only.
    if (isPhotoHiddenFromViewer(photo, req.accessLevel)) {
      return res.status(403).json({ error: 'Photo not available' });
    }

    // Create client fingerprint
    const clientFingerprint = secureImageService.createClientFingerprint(req);

    // Generate secure token. clientBypass lets a client's token keep serving
    // a photo hidden after minting; a guest's stops at the serve route.
    const token = secureImageService.generateSecureToken(photoId, req.sessionID || 'anonymous', {
      expiresIn,
      maxUses: protectionLevel === 'maximum' ? 1 : 3,
      clientFingerprint,
      protectionLevel,
      clientBypass: canSeeHiddenPhotos(req.accessLevel)
    });
    
    res.json({ 
      token,
      expiresIn,
      protectionLevel,
      maxUses: protectionLevel === 'maximum' ? 1 : 3
    });
    
  } catch (error) {
    logger.error('Error generating secure token:', error);
    res.status(500).json({ error: 'Failed to generate token' });
  }
});

/**
 * Generate signed URL for image access (legacy support)
 */
router.post('/:slug/photo/:photoId/generate-url', verifyGalleryAccess, async (req, res) => {
  // Reveal-gated for plain guests; bypass callers get a token that stays
  // valid at SERVE time too (third token segment below).
  if (require('../utils/revealMode').guestBlockedByReveal(req)) {
    return res.status(403).json({ error: 'Gallery is hidden until reveal', code: 'GALLERY_HIDDEN' });
  }
  try {
    const { photoId } = req.params;
    
    // Verify photo belongs to this event
    const photo = await db('photos')
      .where({
        id: photoId,
        event_id: req.event.id
      })
      .first();
    
    if (!photo) {
      return res.status(404).json({ error: 'Photo not found' });
    }

    // Refuse to mint a signed URL for a hidden/client-only photo when the
    // caller isn't a client. The signed-serve route below is token-only
    // (no gallery auth), so the access decision has to happen here at mint
    // time — mirroring how the reveal-bypass flag is baked into the token.
    if (isPhotoHiddenFromViewer(photo, req.accessLevel)) {
      return res.status(403).json({ error: 'Photo not available' });
    }

    // Generate signed token. The client-bypass flag lets a PIN-client's
    // token keep serving a photo hidden after minting; a guest's token
    // (clientBypass=0) stops the moment the photo is hidden.
    const token = generateImageToken(photoId, 3600, bypassesReveal(req), canSeeHiddenPhotos(req.accessLevel));
    const signedUrl = `/api/images/${req.params.slug}/photo/${photoId}/signed/${token}`;
    
    res.json({ 
      url: signedUrl,
      expiresIn: 3600 // 1 hour
    });
    
  } catch (error) {
    logger.error('Error generating signed URL:', error);
    res.status(500).json({ error: 'Failed to generate URL' });
  }
});

/**
 * Serve image with signed URL (no gallery auth required, token is the auth)
 */
router.get('/:slug/photo/:photoId/signed/:token', async (req, res) => {
  try {
    const { slug, photoId, token } = req.params;
    
    // Verify token
    const tokenData = verifyImageToken(token);
    if (!tokenData || tokenData.photoId !== parseInt(photoId)) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    
    // Get event
    const event = await db('events')
      .where({ slug })
      .where('is_active', formatBoolean(true))
      .first();
    
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // Reveal mode (#838): a signed URL minted before a re-hide must not keep
    // serving hidden photos; tokens minted by bypass contexts carry the flag.
    if (isGalleryHidden(event) && !tokenData.revealBypass) {
      return res.status(403).json({ error: 'Gallery is hidden until reveal', code: 'GALLERY_HIDDEN' });
    }

    // Get photo
    const photo = await db('photos')
      .where({
        id: photoId,
        event_id: event.id
      })
      .first();
    
    if (!photo) {
      return res.status(404).json({ error: 'Photo not found' });
    }

    // Recheck visibility at serve time (TOCTOU): a photo hidden AFTER the
    // URL was minted must stop serving, unless the token was minted by a
    // client (clientBypass) — mirroring the reveal-mode check above.
    if (photo.visibility === 'hidden' && !tokenData.clientBypass) {
      return res.status(403).json({ error: 'Photo not available' });
    }

    // Get watermark settings
    const watermarkSettings = await watermarkService.getWatermarkSettings();

    // Apply watermark — managed photos are sourced via the storage backend
    // (S3 mode materializes a tmp local copy via withLocalCopy).
    const storageKey = resolvePhotoStorageKey(event, photo);
    const imageBuffer = storageKey
      ? await withLocalCopy(storageKey, (lp) => watermarkService.applyWatermark(lp, watermarkSettings))
      : await watermarkService.applyWatermark(resolvePhotoFilePath(event, photo), watermarkSettings);
    
    // Set appropriate headers
    res.set({
      'Content-Type': photo.mime_type || 'image/jpeg',
      'Content-Length': imageBuffer.length,
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff'
    });
    
    // Send the watermarked image
    res.send(imageBuffer);
    
  } catch (error) {
    logger.error('Error serving signed image:', error);
    res.status(500).json({ error: 'Failed to serve image' });
  }
});

module.exports = router;