/**
 * Migration: Re-theme the customer_invitation email's CTA button.
 *
 * The original 087 seed inlined `background-color: #5C8762` on the
 * "Set up your account" anchor, which locked the button to the legacy
 * green regardless of the admin's `email_primary_color` setting
 * (Settings → Branding → Email palette). The wrapper template
 * (emailProcessor.wrapEmailHtml) already exposes a `.button` class
 * that inherits the configured palette — switching the anchor over
 * is a one-line change, but existing installs already have the bad
 * HTML in their email_template_translations rows. This migration
 * rewrites those rows so the next outbound invitation picks up the
 * brand colour.
 *
 * Idempotent: only updates rows whose stored body still contains the
 * old hardcoded anchor markup. If the admin has hand-edited the
 * template (typical for non-English locales they translated
 * themselves) the row is left alone.
 */

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  if (!(await knex.schema.hasTable('email_template_translations'))) return;

  const master = await knex('email_templates')
    .where('template_key', 'customer_invitation')
    .first();
  if (!master) return; // 087 hasn't run on this install — nothing to fix.

  // English translation
  const enRow = await knex('email_template_translations')
    .where({ template_id: master.id, language: 'en' })
    .first();
  if (enRow && typeof enRow.body_html === 'string'
      && enRow.body_html.includes('background-color: #5C8762')
      && enRow.body_html.includes('Set up your account')) {
    const newHtml = `
<h2>Welcome to your photo galleries</h2>
<p>You've been invited to create a customer account so you can view all of your event galleries in one place — no more juggling separate links and passwords.</p>
<div style="text-align: center; margin: 30px 0;">
  <a href="{{invite_link}}" class="button">Set up your account</a>
</div>
<p>This invitation expires on {{expires_at}}. If the link doesn't work, copy and paste it into your browser:</p>
<p style="word-break: break-all; font-size: 13px; color: #666;">{{invite_link}}</p>
<p>If you weren't expecting this email, you can safely ignore it.</p>`;
    await knex('email_template_translations')
      .where({ id: enRow.id })
      .update({ body_html: newHtml, updated_at: new Date() });
  }

  // German translation
  const deRow = await knex('email_template_translations')
    .where({ template_id: master.id, language: 'de' })
    .first();
  if (deRow && typeof deRow.body_html === 'string'
      && deRow.body_html.includes('background-color: #5C8762')
      && deRow.body_html.includes('Konto einrichten')) {
    const newHtml = `
<h2>Willkommen bei Ihren Fotogalerien</h2>
<p>Sie wurden eingeladen, ein Kundenkonto anzulegen, damit Sie alle Ihre Eventgalerien an einem Ort einsehen können — ohne mehrere Links und Passwörter verwalten zu müssen.</p>
<div style="text-align: center; margin: 30px 0;">
  <a href="{{invite_link}}" class="button">Konto einrichten</a>
</div>
<p>Diese Einladung läuft am {{expires_at}} ab. Falls der Link nicht funktioniert, kopieren Sie ihn in Ihren Browser:</p>
<p style="word-break: break-all; font-size: 13px; color: #666;">{{invite_link}}</p>
<p>Wenn Sie diese E-Mail nicht erwartet haben, können Sie sie ignorieren.</p>`;
    await knex('email_template_translations')
      .where({ id: deRow.id })
      .update({ body_html: newHtml, updated_at: new Date() });
  }

  // Legacy single-language column on the master row, if present.
  // Older installs may also have a hardcoded body_html on email_templates
  // itself (pre-translations table). Same idempotent rewrite logic.
  if (typeof master.body_html === 'string'
      && master.body_html.includes('background-color: #5C8762')) {
    await knex('email_templates')
      .where({ id: master.id })
      .update({
        body_html: '<p>You\'ve been invited to create a customer account. <a href="{{invite_link}}" class="button">Set up your account</a> (expires {{expires_at}}).</p>',
        updated_at: new Date(),
      });
  }
};

exports.down = async function(/* knex */) {
  // No-op: rolling back the visual fix would intentionally restore the
  // bug. Admins who want the old green button can edit the template
  // from Settings → Email Templates.
};
