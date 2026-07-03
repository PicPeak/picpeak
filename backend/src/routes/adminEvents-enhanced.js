// This is a partial file showing the enhanced event creation with password validation
// Only the relevant parts are shown - merge with existing adminEvents.js

const { validatePasswordInContext, getBcryptRounds } = require('../utils/passwordValidation');
const { buildShareLinkVariants } = require('../services/shareLinkService');
const { requirePermission } = require('../middleware/permissions');
const { IDENTITY_PRESERVING_NORMALIZE_EMAIL } = require('../utils/emailNormalization');

// Enhanced event creation with password validation
// Note: This is a partial/reference file - dynamic event type validation should be implemented
// similar to adminEvents.js using eventTypeService.isValidEventType()
router.post('/', adminAuth, requirePermission('events.create'), [
  body('event_type').notEmpty().trim(), // Dynamic validation via eventTypeService
  body('event_name').notEmpty().trim(),
  body('event_date').isDate(),
  body('customer_email').isEmail().normalizeEmail(IDENTITY_PRESERVING_NORMALIZE_EMAIL),
  body('admin_email').isEmail().normalizeEmail(IDENTITY_PRESERVING_NORMALIZE_EMAIL),
  body('password').notEmpty(), // Remove the weak isLength validation
  body('expiration_days').isInt({ min: 1, max: 365 }).optional(),
  body('welcome_message').optional().trim(),
  body('color_theme').optional().trim(),
  body('allow_user_uploads').optional().isBoolean().toBoolean(),
  body('upload_category_id').optional({ nullable: true, checkFalsy: true }).isInt(),
  body('customer_name').notEmpty().trim()
], async (req, res) => {
  try {
    console.log('Create event request body:', req.body);
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.error('Validation errors:', errors.array());
      return res.status(400).json({ errors: errors.array() });
    }
    
    const {
      event_type,
      event_name,
      event_date,
      customer_name,
      customer_email,
      admin_email,
      password,
      welcome_message = '',
      color_theme = null,
      expiration_days = 30,
      allow_user_uploads = false,
      upload_category_id = null,
      photo_cap = null
    } = req.body;
    
    // Validate password strength for gallery
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
    
    // Generate unique slug
    const baseSlug = `${event_type}-${event_name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${event_date}`;
    let slug = baseSlug;
    let counter = 1;
    
    while (await db('events').where({ slug }).first()) {
      slug = `${baseSlug}-${counter}`;
      counter++;
    }
    
    // Generate share link based on configured style
    const shareToken = crypto.randomBytes(16).toString('hex');
    const { shareUrl, shareLinkToStore } = await buildShareLinkVariants({ slug, shareToken });
    
    // Hash password with configurable rounds
    const password_hash = await bcrypt.hash(password, getBcryptRounds());
    
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
      customer_name,
      customer_email,
      host_name: customer_name,
      host_email: customer_email,
      admin_email,
      password_hash,
      welcome_message,
      color_theme,
      share_link: shareLinkToStore,
      share_token: shareToken,
      expires_at: expires_at.toISOString(),
      created_at: new Date().toISOString(),
      allow_user_uploads,
      upload_category_id,
      photo_cap: photo_cap || null
    }).returning('id');
    
    // Handle both PostgreSQL (returns array of objects) and SQLite (returns array of IDs)
    const eventId = insertResult[0]?.id || insertResult[0];
    
    // Log activity
    await logActivity('event_created', 
      { 
        event_type, 
        expires_at,
        password_strength: passwordValidation.score 
      }, 
      eventId, 
      { type: 'admin', id: req.admin.id, name: req.admin.username }
    );
    
    // Rest of the implementation remains the same...
    // Queue creation email, etc.
  } catch (error) {
    console.error('Error creating event:', error);
    res.status(500).json({ error: 'Failed to create event' });
  }
});
