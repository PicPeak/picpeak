const express = require('express');
const { body, validationResult } = require('express-validator');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { db } = require('../database/db');
const { formatBoolean } = require('../utils/dbCompat');
const { slugify } = require('../utils/slug');
const { validatePasswordInContext, getBcryptRounds } = require('../utils/passwordValidation');
const { adminAuth } = require('../middleware/auth');
const fs = require('fs').promises;
const path = require('path');
const router = express.Router();
const { buildShareLinkVariants } = require('../services/shareLinkService');
const { parseBooleanInput, parseStringInput } = require('../utils/parsers');
const eventTypeService = require('../services/eventTypeService');

// Use parseStringInput from shared parsers for customer data extraction
const getCustomerNameFromPayload = (payload = {}) => parseStringInput(payload.customer_name);
const getCustomerEmailFromPayload = (payload = {}) => parseStringInput(payload.customer_email);

const mapEventForApi = (event) => {
  if (!event || typeof event !== 'object') {
    return event;
  }

  const {
    host_name,
    host_email,
    customer_name,
    customer_email,
    ...rest
  } = event;

  return {
    ...rest,
    customer_name: customer_name ?? host_name ?? null,
    customer_email: customer_email ?? host_email ?? null
  };
};

let customerColumnCache = null;
const hasCustomerContactColumns = async () => {
  if (customerColumnCache === true) {
    return true;
  }

  try {
    const hasColumn = await db.schema.hasColumn('events', 'customer_email');
    if (hasColumn) {
      customerColumnCache = true;
    }
    return hasColumn;
  } catch (error) {
    return false;
  }
};

// Create new event
router.post('/', adminAuth, [
  body('event_type').notEmpty().trim().custom(async (value) => {
    const isValid = await eventTypeService.isValidEventType(value);
    if (!isValid) {
      throw new Error('Invalid event type');
    }
    return true;
  }),
  body('event_name').notEmpty(),
  body('event_date').isDate(),
  body('customer_name').notEmpty().trim(),
  body('customer_email').isEmail().normalizeEmail(),
  body('admin_email').isEmail(),
  body('require_password').optional().isBoolean(),
  body('password').optional().isString().custom((value, { req }) => {
    const requirePassword = parseBooleanInput(req.body.require_password, true);
    if (!requirePassword) {
      return true;
    }
    if (typeof value !== 'string' || value.trim().length < 6) {
      throw new Error('Password must be at least 6 characters long');
    }
    return true;
  }),
  body('expiration_days').isInt({ min: 1, max: 365 }).optional()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    const {
      event_type,
      event_name,
      event_date,
      admin_email,
      password,
      require_password: requirePasswordInput = true,
      welcome_message,
      color_theme,
      expiration_days = 30
    } = req.body;

    const customerEmail = getCustomerEmailFromPayload(req.body);
    const customerName = getCustomerNameFromPayload(req.body);

    if (!customerName || !customerEmail) {
      return res.status(400).json({ error: 'customer_name and customer_email are required' });
    }

    const customerColumnsAvailable = await hasCustomerContactColumns();

    const requirePassword = parseBooleanInput(requirePasswordInput, true);

    if (requirePassword) {
      const passwordValidation = await validatePasswordInContext(password, 'gallery', {
        eventName: event_name
      });

      if (!passwordValidation.valid) {
        return res.status(400).json({ 
          error: 'Password does not meet security requirements',
          details: passwordValidation.errors,
          score: passwordValidation.score,
          feedback: passwordValidation.feedback
        });
      }
    }
    
    // Generate unique slug — slugify() handles accents (see #525).
    const baseSlug = `${event_type}-${slugify(event_name)}-${event_date}`;
    let slug = baseSlug;
    let counter = 1;
    
    while (await db('events').where({ slug }).first()) {
      slug = `${baseSlug}-${counter}`;
      counter++;
    }
    
    // Generate share link variants (auto-detects short URL preference)
    const shareToken = crypto.randomBytes(16).toString('hex');
    const { sharePath, shareUrl, shareLinkToStore } = await buildShareLinkVariants({ slug, shareToken });
    
    // Hash password (or placeholder when not required)
    const password_hash = requirePassword
      ? await bcrypt.hash(password, getBcryptRounds())
      : await bcrypt.hash(crypto.randomBytes(32).toString('hex'), getBcryptRounds());
    
    // Calculate expiration date (days after event date)
    const expires_at = new Date(event_date);
    expires_at.setDate(expires_at.getDate() + parseInt(expiration_days, 10));
    
    // Create folder structure
    const storagePath = process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');
    const eventPath = path.join(storagePath, 'events/active', slug);
    await fs.mkdir(path.join(eventPath, 'collages'), { recursive: true });
    await fs.mkdir(path.join(eventPath, 'individual'), { recursive: true });
    
    // Insert into database
    const insertResult = await db('events').insert({
      slug,
      event_type,
      event_name,
      event_date,
      ...(customerColumnsAvailable ? { customer_name: customerName, customer_email: customerEmail } : {}),
      host_name: customerName,
      host_email: customerEmail,
      admin_email,
      password_hash,
      welcome_message,
      color_theme,
      share_link: shareLinkToStore,
      share_token: shareToken,
      expires_at,
      require_password: formatBoolean(requirePassword)
    }).returning('id');
    
    // Handle both PostgreSQL (returns array of objects) and SQLite (returns array of IDs)
    const eventId = insertResult[0]?.id || insertResult[0];
    
    // Queue creation email
    const { queueEmail } = require('../services/emailProcessor');
    await queueEmail(eventId, customerEmail, 'gallery_created', {
      customer_name: customerName,
      customer_email: customerEmail,
      host_name: customerName,
      event_name,
      event_date: event_date,  // Pass raw date - will be formatted by email processor
      gallery_link: shareUrl,
      gallery_password: requirePassword ? password : 'No password required',
      expiry_date: expires_at.toISOString(),  // Pass ISO string - will be formatted by email processor
      welcome_message: welcome_message || ''
    });

    // Webhook lifecycle (#327). Legacy public endpoint — events go live
    // immediately so created + published fire together. Payload uses the
    // canonical event subject (#341) — every event.* webhook now includes
    // customer contact + share_token.
    try {
      const webhookService = require('../services/webhookService');
      const eventSubject = webhookService.buildEventSubject({
        id: eventId,
        slug,
        event_name,
        event_type,
        event_date,
        share_url: shareUrl,
        share_token: shareToken,
        customer_name: customerName,
        customer_email: customerEmail,
      });
      await webhookService.fire('event.created', { event: eventSubject });
      await webhookService.fire('event.published', { event: eventSubject });
    } catch (e) { /* non-fatal */ }

    res.json({
      id: eventId,
      slug,
      share_link: shareUrl,
      expires_at,
      require_password: requirePassword,
      customer_name: customerName,
      customer_email: customerEmail
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create event' });
  }
});

// Get all events (admin)
router.get('/', adminAuth, async (req, res) => {
  try {
    const { status = 'all' } = req.query;
    
    let query = db('events').select('*');
    
    if (status === 'active') {
      query = query.where('is_active', formatBoolean(true));
    } else if (status === 'archived') {
      query = query.where('is_archived', formatBoolean(true));
    }
    
    const events = await query.orderBy('created_at', 'desc');
    
    // Add photo counts
    for (const event of events) {
      const photoCount = await db('photos').where('event_id', event.id).count('id as count').first();
      event.photo_count = photoCount.count;
    }
    
    res.json(events.map(mapEventForApi));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

// Update event
router.put('/:id', adminAuth, [
  body('customer_name').optional().trim().notEmpty(),
  body('customer_email').optional().isEmail().normalizeEmail(),
  body('require_password').optional().isBoolean()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { id } = req.params;
    const updates = { ...req.body };
    const customerColumnsAvailable = await hasCustomerContactColumns();
    
    // Don't allow updating certain fields
    delete updates.id;
    delete updates.slug;
    delete updates.created_at;
    delete updates.password_confirmation;

    if (Object.prototype.hasOwnProperty.call(updates, 'host_name') || Object.prototype.hasOwnProperty.call(updates, 'host_email')) {
      return res.status(400).json({ error: 'host_name and host_email are no longer supported. Use customer_name and customer_email instead.' });
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'customer_name')) {
      const nextName = getCustomerNameFromPayload(updates);
      if (nextName) {
        if (customerColumnsAvailable) {
          updates.customer_name = nextName;
        } else {
          delete updates.customer_name;
        }
        updates.host_name = nextName;
      } else {
        delete updates.customer_name;
      }
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'customer_email')) {
      const nextEmail = getCustomerEmailFromPayload(updates);
      if (nextEmail) {
        if (customerColumnsAvailable) {
          updates.customer_email = nextEmail;
        } else {
          delete updates.customer_email;
        }
        updates.host_email = nextEmail;
      } else {
        delete updates.customer_email;
      }
    }

    const hasRequirePasswordUpdate = Object.prototype.hasOwnProperty.call(updates, 'require_password');
    let requirePasswordUpdate;
    if (hasRequirePasswordUpdate) {
      requirePasswordUpdate = parseBooleanInput(updates.require_password, true);
      updates.require_password = formatBoolean(requirePasswordUpdate);
    }

    let newPasswordPlain;
    if (Object.prototype.hasOwnProperty.call(updates, 'password')) {
      if (updates.password === undefined || updates.password === null || updates.password === '') {
        delete updates.password;
      } else {
        newPasswordPlain = updates.password;
        delete updates.password;
      }
    }

    const event = await db('events').where('id', id).first();
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const currentRequirePassword = parseBooleanInput(event.require_password, true);

    if (hasRequirePasswordUpdate && requirePasswordUpdate === true && !currentRequirePassword && !newPasswordPlain) {
      return res.status(400).json({ error: 'Password must be provided when enabling password requirement.' });
    }

    if (newPasswordPlain) {
      updates.password_hash = await bcrypt.hash(newPasswordPlain, getBcryptRounds());
    } else if (hasRequirePasswordUpdate && requirePasswordUpdate === false && currentRequirePassword) {
      updates.password_hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), getBcryptRounds());
    }
    
    await db('events').where('id', id).update(updates);
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update event' });
  }
});

// Delete event (mark as inactive)
router.delete('/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    
    await db('events').where('id', id).update({ is_active: formatBoolean(false) });
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete event' });
  }
});

// Extend expiration
router.post('/:id/extend', adminAuth, [
  body('days').isInt({ min: 1, max: 365 })
], async (req, res) => {
  try {
    const { id } = req.params;
    const { days } = req.body;
    
    const event = await db('events').where('id', id).first();
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    const newExpiration = new Date(event.expires_at);
    newExpiration.setDate(newExpiration.getDate() + days);
    
    await db('events').where('id', id).update({ 
      expires_at: newExpiration,
      is_active: formatBoolean(true) // Reactivate if expired
    });
    
    res.json({ expires_at: newExpiration });
  } catch (error) {
    res.status(500).json({ error: 'Failed to extend expiration' });
  }
});

module.exports = router;
