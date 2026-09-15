// Extracted verbatim from the original routes/adminEvents.js (see ./index.js).
// Exports a register function; ./index.js calls the sub-routers in the original
// registration order so Express route matching is unchanged.

const { db, logActivity } = require('../../database/db');
const { adminAuth } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permissions');
const bcrypt = require('bcrypt');
const { queueEmail } = require('../../services/emailProcessor');
const { galleryPasswordColumns, readGalleryPassword, dropCopiesIfStorageOff } = require('../../utils/galleryPasswordVault');
const { credentialChangeColumns, sameAsStored } = require('../../utils/galleryCredentialCutoff');
const { validatePasswordInContext, getBcryptRounds } = require('../../utils/passwordValidation');
const logger = require('../../utils/logger');
const { errorResponse } = require('../../utils/routeHelpers');
const { buildShareLinkVariants } = require('../../services/shareLinkService');
const { requireEventOwnership } = require('../../middleware/ownership');
const { getAbsoluteFrontendUrl } = require('../../utils/frontendUrl');
const { parseBooleanInput } = require('../../utils/parsers');

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
      const passwordUnchanged = newPassword === clientPassword && await sameAsStored(newPassword, event.password_hash);

      // Update event with new password
      await db('events')
        .where('id', id)
        .update({
          ...(passwordUnchanged ? {} : { password_hash: passwordHash }),
          // #1271 — same statement as the hash, so a concurrent reset can
          // never leave a copy that does not match the hash next to it
          ...(await galleryPasswordColumns({ password: newPassword })),
          // Guests who got in with the old password must log in again. A
          // generated password is always new; an admin-supplied one may be the
          // current password, which is not a change.
          ...(passwordUnchanged ? {} : await credentialChangeColumns('gallery')),
        });
      await dropCopiesIfStorageOff(id);

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
      // Without a password in the request: use the recoverable copy when the
      // operator opted into keeping one (#1271), else the security sentinel —
      // the hash cannot be turned back into the password.
      let usedStoredPassword = false;
      const stored = await readGalleryPassword(id);
      if (!galleryPassword) {
        if (stored.password) {
          galleryPassword = stored.password;
          usedStoredPassword = true;
        } else {
          // We'll let the email processor determine the language for the security message
          galleryPassword = '{{password_security_message}}';
        }
      }
    
      // Dates will be formatted by the email processor based on recipient language
    
      // Queue the email
      const recipientEmail = event.customer_email || event.host_email;
      const recipientName = event.customer_name || event.host_name || (recipientEmail ? recipientEmail.split('@')[0] : null);
      // event.share_link is the path-only form; use the full URL so the
      // customer's mail client renders a clickable absolute link.
      const { shareUrl } = await buildShareLinkVariants({ slug: event.slug, shareToken: event.share_token });

      const emailData = {
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
      };
      // The creation mail carries the client link and PIN (#172). A resend can
      // only do the same when a stored PIN exists (#1271); otherwise the client
      // section is left out rather than sent with a placeholder.
      if (parseBooleanInput(event.client_access_enabled, false) && stored.clientPassword && event.client_share_token) {
        const frontendUrl = await getAbsoluteFrontendUrl(req, { override: process.env.APP_URL });
        emailData.client_link = `${frontendUrl}/gallery/${event.slug}/client-access?token=${event.client_share_token}`;
        emailData.client_password = stored.clientPassword;
      }
      await queueEmail(id, recipientEmail, 'gallery_created', emailData);
    
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
        usedStoredPassword, 
        success: true,
        message: 'Creation email has been queued for sending'
      });
    } catch (error) {
      logger.error('Error resending creation email:', error);
      errorResponse(res, error, 500, 'Failed to resend creation email');
    }
  });

};
