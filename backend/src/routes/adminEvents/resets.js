// Extracted verbatim from the original routes/adminEvents.js (see ./index.js).
// Exports a register function; ./index.js calls the sub-routers in the original
// registration order so Express route matching is unchanged.

const { db, logActivity } = require('../../database/db');
const { adminAuth } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permissions');
const bcrypt = require('bcrypt');
const { queueEmail } = require('../../services/emailProcessor');
const { validatePasswordInContext, getBcryptRounds } = require('../../utils/passwordValidation');
const logger = require('../../utils/logger');
const { errorResponse } = require('../../utils/routeHelpers');
const { buildShareLinkVariants } = require('../../services/shareLinkService');
const { requireEventOwnership } = require('../../middleware/ownership');

module.exports = (router) => {


  // Reset event password
  router.post('/:id/reset-password', adminAuth, requirePermission('events.edit'), requireEventOwnership, async (req, res) => {
    try {
      const { id } = req.params;
      const { sendEmail = true, password: clientPassword } = req.body;

      let eventQuery = db('events').where('id', id);
      // Editor role can only edit their own events
      if (req.admin.roleName === 'editor') {
        eventQuery = eventQuery.where('created_by', req.admin.id);
      }
      const event = await eventQuery.first();
      if (!event) {
        return res.status(404).json({ error: 'Event not found' });
      }

      if (event.is_archived) {
        return res.status(400).json({ error: 'Cannot reset password for archived event' });
      }

      // Use the admin-supplied password when provided; otherwise auto-generate
      // (preserves the previous one-click behaviour for callers/cron that don't
      // pass a body). Validation matches the create-event flow so the same
      // strength rules apply both ways.
      let newPassword;
      if (typeof clientPassword === 'string' && clientPassword.length > 0) {
        const passwordValidation = await validatePasswordInContext(clientPassword, 'gallery', {
          eventName: event.event_name
        });
        if (!passwordValidation.valid) {
          return res.status(400).json({
            error: 'Password does not meet security requirements',
            details: passwordValidation.errors,
            score: passwordValidation.score,
            feedback: passwordValidation.feedback
          });
        }
        newPassword = clientPassword;
      } else {
        const { generateReadablePassword } = require('../../utils/passwordGenerator');
        newPassword = generateReadablePassword();
      }
      const passwordHash = await bcrypt.hash(newPassword, getBcryptRounds());

      // Update event with new password
      await db('events')
        .where('id', id)
        .update({
          password_hash: passwordHash
        });

      // Log activity
      await logActivity('password_reset',
        { eventName: event.event_name, emailSent: sendEmail },
        id,
        { type: 'admin', id: req.admin.id, name: req.admin.username }
      );

      // Queue email notification if requested
      if (sendEmail) {
        const recipientEmail = event.customer_email || event.host_email;
        const recipientName = event.customer_name || event.host_name || (recipientEmail ? recipientEmail.split('@')[0] : null);
        // event.share_link is the path-only form (`/gallery/<slug>/<token>`).
        // Use the full URL so customers can click straight from the email.
        const { shareUrl } = await buildShareLinkVariants({ slug: event.slug, shareToken: event.share_token });

        await queueEmail(id, recipientEmail, 'gallery_created', {
          customer_name: recipientName,
          customer_email: recipientEmail,
          host_name: recipientName,
          event_name: event.event_name,
          event_date: event.event_date,  // Pass raw date - will be formatted by email processor
          gallery_link: shareUrl,
          gallery_password: newPassword,
          expiry_date: event.expires_at  // Pass raw date - will be formatted by email processor
        });
      }

      res.json({
        message: 'Password reset successfully',
        newPassword: newPassword,
        emailSent: sendEmail
      });
    } catch (error) {
      errorResponse(res, error, 500, 'Failed to reset password');
    }
  });

  // Resend creation email
  router.post('/:id/resend-email', adminAuth, requirePermission('events.edit'), requireEventOwnership, async (req, res) => {
    try {
      const { id } = req.params;

      // Get event details
      let eventQuery = db('events').where('id', id);
      // Editor role can only edit their own events
      if (req.admin.roleName === 'editor') {
        eventQuery = eventQuery.where('created_by', req.admin.id);
      }
      const event = await eventQuery.first();

      if (!event) {
        return res.status(404).json({ error: 'Event not found' });
      }
    
      // The email processor will determine the language based on:
      // 1. Event language setting
      // 2. App settings general_default_language  
      // 3. Email config default language
      // 4. Domain-based detection
      // So we don't need to determine it here
    
      // For resending creation email, we need the actual password
      // First, try to get it from the request body if provided
      // Use optional chaining to handle cases where req.body might be undefined
      let galleryPassword = req.body?.password;
    
      // If no password provided, we can't decrypt the existing one
      // So we'll show a security message
      if (!galleryPassword) {
      // We'll let the email processor determine the language for the security message
        galleryPassword = '{{password_security_message}}';
      }
    
      // Dates will be formatted by the email processor based on recipient language
    
      // Queue the email
      const recipientEmail = event.customer_email || event.host_email;
      const recipientName = event.customer_name || event.host_name || (recipientEmail ? recipientEmail.split('@')[0] : null);
      // event.share_link is the path-only form; use the full URL so the
      // customer's mail client renders a clickable absolute link.
      const { shareUrl } = await buildShareLinkVariants({ slug: event.slug, shareToken: event.share_token });

      await queueEmail(id, recipientEmail, 'gallery_created', {
        customer_name: recipientName,
        customer_email: recipientEmail,
        host_name: recipientName,
        event_name: event.event_name,
        event_date: event.event_date,  // Pass raw date - will be formatted by email processor
        gallery_link: shareUrl,
        gallery_password: galleryPassword,
        expiry_date: event.expires_at,  // Pass raw date - will be formatted by email processor
        welcome_message: event.welcome_message || '',
        eventId: id,
        isResend: true // Flag to indicate this is a resend
      });
    
      // Log the activity using the proper schema
      try {
        await logActivity('email_resent', {
          email_type: 'gallery_created',
          recipient: recipientEmail,
          ip_address: req.ip || '0.0.0.0',
          user_agent: req.get('user-agent') || 'Unknown'
        }, id, {
          type: 'admin',
          id: req.admin.id,
          name: req.admin.username
        });
      } catch (logError) {
        logger.error('Warning: Failed to log activity:', logError);
      // Don't fail the request if activity logging fails
      }
    
      res.json({ 
        success: true,
        message: 'Creation email has been queued for sending'
      });
    } catch (error) {
      logger.error('Error resending creation email:', error);
      errorResponse(res, error, 500, 'Failed to resend creation email');
    }
  });

};
