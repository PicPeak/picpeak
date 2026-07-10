const nodemailer = require('nodemailer');
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { getFrontendBaseUrl } = require('../utils/frontendUrl');
const {
  snapToBusinessHours,
  normaliseSchedule,
} = require('../utils/businessHours');
const { hasColumnCached } = require('../utils/schemaCache');

let transporter = null;
let lastConfigHash = null;

// Generate hash from config for change detection
function generateConfigHash(config) {
  const crypto = require('crypto');
  const configString = `${config.smtp_host}:${config.smtp_port}:${config.smtp_user}:${config.smtp_pass}:${config.smtp_secure}:${config.tls_reject_unauthorized}`;
  return crypto.createHash('md5').update(configString).digest('hex');
}

// Initialize transporter from database config
async function initializeTransporter(forceReinit = false) {
  try {
    const config = await db('email_configs').first();
    
    if (!config) {
      logger.warn('No email configuration found');
      return null;
    }

    // Check if configuration has changed
    const currentConfigHash = generateConfigHash(config);
    if (!forceReinit && transporter && currentConfigHash === lastConfigHash) {
      // Configuration hasn't changed, return existing transporter
      return transporter;
    }

    // Configuration has changed or first initialization
    logger.info('Initializing email transporter' + (lastConfigHash && currentConfigHash !== lastConfigHash ? ' (configuration changed)' : ''));

    // PR #603 review follow-up #3 — release the previous transporter before
    // swapping it. Harmless today (no connection pool), but prevents a
    // socket/connection leak if `pool: true` is ever enabled on the transport.
    if (transporter && typeof transporter.close === 'function') {
      try { transporter.close(); } catch (_) { /* best-effort */ }
    }

    transporter = nodemailer.createTransport({
      host: config.smtp_host,
      port: config.smtp_port,
      secure: config.smtp_secure,
      auth: config.smtp_user ? {
        user: config.smtp_user,
        pass: config.smtp_pass
      } : undefined,
      tls: {
        // Allow ignoring SSL certificate errors when tls_reject_unauthorized is false
        rejectUnauthorized: config.tls_reject_unauthorized !== false
      }
    });

    // Verify configuration
    await transporter.verify();
    logger.info('Email transporter initialized successfully');
    
    // Update the config hash
    lastConfigHash = currentConfigHash;
    
    return transporter;
  } catch (error) {
    logger.error('Failed to initialize email transporter:', error);
    transporter = null;
    lastConfigHash = null;
    return null;
  }
}

// Read the support contact email used in customer-facing notifications
// (gallery_expired, archive_complete, …). Looks up `branding_support_email`
// from app_settings (JSON-encoded), falling back to the SMTP from-address
// so templates that reference {{support_email}} never render the literal
// placeholder. Returns '' when neither is configured — templates should
// degrade by hiding the line via a {{#if support_email}} block.
async function getSupportEmail() {
  try {
    const row = await db('app_settings')
      .where('setting_key', 'branding_support_email')
      .first();
    if (row && row.setting_value) {
      try {
        const parsed = JSON.parse(row.setting_value);
        if (typeof parsed === 'string' && parsed.trim()) return parsed.trim();
      } catch (e) {
        if (typeof row.setting_value === 'string' && row.setting_value.trim()) {
          return row.setting_value.trim();
        }
      }
    }
  } catch (err) {
    logger.debug('getSupportEmail: app_settings lookup failed', { error: err.message });
  }
  try {
    const config = await db('email_configs').first();
    if (config && config.from_email) return config.from_email;
  } catch (err) {
    logger.debug('getSupportEmail: email_configs lookup failed', { error: err.message });
  }
  return '';
}

// Get the appropriate language for a recipient
async function getRecipientLanguage(email, eventId = null) {
  // First priority: Check event language setting if eventId is provided
  if (eventId) {
    try {
      const event = await db('events').where('id', eventId).first();
      if (event && event.language) {
        return event.language;
      }
    } catch (error) {
      logger.error('Error fetching event language:', error);
    }
  }

  // Second priority: customer_accounts.preferred_language matched by
  // recipient email. Honours the customer's own preference instead of
  // the app-wide default — fixes the CRM bug where every quote /
  // invoice / customer email shipped in the app default language
  // (German on a German-locale install) even when the customer was
  // explicitly set to English. Falls through silently on miss so admin
  // recipients (no customer_accounts row) still see the app default.
  if (email) {
    try {
      const customer = await db('customer_accounts')
        .where('email', String(email).toLowerCase().trim())
        .select('preferred_language')
        .first();
      if (customer && customer.preferred_language) {
        return customer.preferred_language;
      }
    } catch (error) {
      logger.debug('Skip customer_accounts language lookup', { error: error.message });
    }
  }

  // Third priority: Check app_settings for general default language
  try {
    const langSetting = await db('app_settings')
      .where('setting_key', 'general_default_language')
      .first();
    if (langSetting && langSetting.setting_value) {
      let lang = langSetting.setting_value;
      try { lang = JSON.parse(lang); } catch (_) {}
      if (typeof lang === 'string' && lang.trim()) return lang.trim();
    }
  } catch (error) {
    logger.error('Error fetching app settings language:', error);
  }
  
  // Fourth priority: Check email configs for default language
  try {
    const emailConfig = await db('email_configs').first();
    if (emailConfig && emailConfig.default_language) {
      return emailConfig.default_language;
    }
  } catch (error) {
    logger.error('Error fetching email config language:', error);
  }

  // Fifth priority: Check if the email domain suggests a language
  if (email) {
    const domain = email.toLowerCase();
    const domainLanguageMap = [
      { domains: ['.de', '.at', '.ch', '.li'], language: 'de' },
      { domains: ['.nl', '.be'], language: 'nl' },
      { domains: ['.br', '.pt'], language: 'pt' },
      { domains: ['.ru', '.su'], language: 'ru' },
      { domains: ['.es'], language: 'es' },
      { domains: ['.si'], language: 'sl' },
    ];
    for (const { domains, language: lang } of domainLanguageMap) {
      if (domains.some(d => domain.endsWith(d))) {
        return lang;
      }
    }
  }

  return 'en'; // Default to English
}

// Darken a hex color by a percentage (0-1)
function darkenColor(hex, amount = 0.15) {
  const num = parseInt(hex.replace('#', ''), 16);
  const r = Math.max(0, Math.min(255, ((num >> 16) & 0xFF) * (1 - amount)));
  const g = Math.max(0, Math.min(255, ((num >> 8) & 0xFF) * (1 - amount)));
  const b = Math.max(0, Math.min(255, (num & 0xFF) * (1 - amount)));
  return `#${(1 << 24 | Math.round(r) << 16 | Math.round(g) << 8 | Math.round(b)).toString(16).slice(1)}`;
}

// Wrap HTML body in the styled email template with header, footer, and logo
async function wrapEmailHtml(htmlBody, subject, language = 'en') {
  // Email colour palette. The two original settings (email_primary_color and
  // email_secondary_color) keep their existing semantics so emails sent by
  // upgraded instances render byte-for-byte identically until an admin
  // touches the new fields. The six new tokens unlock full email theming
  // (body bg, container card, list panel, body text, muted text, button text)
  // and default to the previously hard-coded literals when absent.
  let logoUrl = '';
  let companyName = 'PicPeak';
  let primaryColor = '#5C8762';
  let secondaryColor = '#f9f9f9';
  let bodyBgColor = '#f5f5f5';        // outer wrapper + body background
  let containerBgColor = '#ffffff';    // email card
  let listBgColor = '#f9f9f9';         // <ul> info panel inside content
  let bodyTextColor = '#333333';       // paragraph text + <strong>
  let mutedTextColor = '#666666';      // footer text
  let buttonTextColor = '#ffffff';     // CTA text on primary button
  try {
    const brandingSettings = await db('app_settings')
      .whereIn('setting_key', [
        'branding_logo_url', 'branding_company_name',
        'email_primary_color', 'email_secondary_color',
        'email_body_bg_color', 'email_container_bg_color',
        'email_list_bg_color', 'email_body_text_color',
        'email_muted_text_color', 'email_button_text_color'
      ])
      .select('setting_key', 'setting_value');

    const readSetting = (val, fallback) => {
      if (!val) return fallback;
      try { return JSON.parse(val); } catch (e) { return val; }
    };

    brandingSettings.forEach(setting => {
      const val = setting.setting_value;
      switch (setting.setting_key) {
      case 'branding_logo_url':       logoUrl = readSetting(val, logoUrl); break;
      case 'branding_company_name':   companyName = readSetting(val, companyName); break;
      case 'email_primary_color':     primaryColor = readSetting(val, primaryColor); break;
      case 'email_secondary_color':   secondaryColor = readSetting(val, secondaryColor); break;
      case 'email_body_bg_color':     bodyBgColor = readSetting(val, bodyBgColor); break;
      case 'email_container_bg_color': containerBgColor = readSetting(val, containerBgColor); break;
      case 'email_list_bg_color':     listBgColor = readSetting(val, listBgColor); break;
      case 'email_body_text_color':   bodyTextColor = readSetting(val, bodyTextColor); break;
      case 'email_muted_text_color':  mutedTextColor = readSetting(val, mutedTextColor); break;
      case 'email_button_text_color': buttonTextColor = readSetting(val, buttonTextColor); break;
      default: break;
      }
    });
  } catch (error) {
    logger.error('Error fetching branding settings:', error);
  }

  const hoverColor = darkenColor(primaryColor, 0.15);

  // Build full logo URL - ensure logoUrl is a valid non-empty string
  const frontendUrl = (await getFrontendBaseUrl()) || 'http://localhost:3000';
  const logoPath = (typeof logoUrl === 'string' && logoUrl.trim()) ? logoUrl : '/picpeak-logo-transparent.png';
  const logoFullUrl = `${frontendUrl}${logoPath.startsWith('/') ? '' : '/'}${logoPath}`;
  logger.debug('Email logo URL:', { frontendUrl, logoPath, logoFullUrl });

  const year = new Date().getFullYear();
  // PR review follow-up — Outlook (Word engine) and Apple Mail under some
  // configs STRIP the <head><style>, so any element styled only by a class
  // loses its design (the CTA rendered as a plain link, the header card +
  // button vanished). Fix: inline the CTA button style (themed with the
  // admin's primary colour) on every `class="button"` anchor, keeping the
  // class so style-capable clients still get :hover. The wrapper chrome
  // below is rebuilt as inline-styled tables with bgcolor attrs for the same
  // reason. The <style> block stays as progressive enhancement.
  const buttonInlineStyle = `background-color:${primaryColor};color:${buttonTextColor};display:inline-block;padding:12px 30px;text-decoration:none;border-radius:5px;font-weight:500;`;
  const inlinedBody = (typeof htmlBody === 'string' ? htmlBody : '')
    .replace(/class="button"/g, `class="button" style="${buttonInlineStyle}"`);

  return `
<!DOCTYPE html>
<html lang="${language}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${subject}</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background-color: ${bodyBgColor};
      color: ${bodyTextColor};
    }
    .email-wrapper {
      background-color: ${bodyBgColor};
      padding: 40px 20px;
    }
    .email-container {
      max-width: 600px;
      margin: 0 auto;
      background-color: ${containerBgColor};
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
      overflow: hidden;
    }
    .email-header {
      background-color: ${primaryColor};
      padding: 30px;
      text-align: center;
    }
    .logo {
      max-width: 180px;
      height: auto;
      margin-bottom: 10px;
    }
    .email-content {
      padding: 40px 30px;
    }
    .email-content h2 {
      color: ${primaryColor};
      margin-top: 0;
      margin-bottom: 20px;
      font-size: 24px;
    }
    .email-content p {
      line-height: 1.6;
      margin-bottom: 15px;
    }
    .email-content ul {
      background-color: ${listBgColor};
      padding: 20px 20px 20px 40px;
      border-radius: 5px;
      margin: 20px 0;
    }
    .email-content li {
      margin-bottom: 10px;
    }
    .button {
      display: inline-block;
      padding: 12px 30px;
      background-color: ${primaryColor};
      color: ${buttonTextColor} !important;
      text-decoration: none;
      border-radius: 5px;
      font-weight: 500;
      margin: 20px 0;
    }
    .button:hover {
      background-color: ${hoverColor};
    }
    .email-footer {
      background-color: ${secondaryColor};
      padding: 30px;
      text-align: center;
      border-top: 1px solid #eee;
    }
    .email-footer img {
      max-width: 120px;
      height: auto;
      margin-bottom: 15px;
      opacity: 0.8;
    }
    .email-footer p {
      color: ${mutedTextColor};
      font-size: 14px;
      margin: 5px 0;
    }
    a {
      color: ${primaryColor};
      text-decoration: underline;
    }
    a:hover {
      color: ${hoverColor};
    }
    strong {
      color: ${bodyTextColor};
    }
    @media only screen and (max-width: 600px) {
      .email-wrapper {
        padding: 20px 10px;
      }
      .email-content {
        padding: 30px 20px;
      }
      .email-header {
        padding: 20px;
      }
      .logo {
        max-width: 150px;
      }
    }
  </style>
</head>
<body style="margin:0;padding:0;background-color:${bodyBgColor};color:${bodyTextColor};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${bodyBgColor}" style="background-color:${bodyBgColor};" class="email-wrapper">
    <tr>
      <td align="center" style="padding:40px 20px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" class="email-container" style="width:100%;max-width:600px;background-color:${containerBgColor};border-radius:8px;overflow:hidden;">
          <tr>
            <td align="center" bgcolor="${primaryColor}" class="email-header" style="background-color:${primaryColor};padding:30px;text-align:center;">
              <img src="${logoFullUrl}" alt="${companyName}" width="180" class="logo" style="max-width:180px;height:auto;display:inline-block;border:0;">
            </td>
          </tr>
          <tr>
            <td class="email-content" style="padding:40px 30px;">
              ${inlinedBody}
            </td>
          </tr>
          <tr>
            <td align="center" bgcolor="${secondaryColor}" class="email-footer" style="background-color:${secondaryColor};padding:30px;text-align:center;border-top:1px solid #eeeeee;">
              <img src="${logoFullUrl}" alt="${companyName}" width="120" style="max-width:120px;height:auto;opacity:0.8;margin-bottom:15px;border:0;">
              <p style="color:${mutedTextColor};font-size:14px;margin:5px 0;">${companyName}</p>
              <p style="font-size:12px;color:#999999;margin:5px 0;">© ${year} ${companyName}. All rights reserved.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// Convert an HTML body to a plain-text fallback. The naive
// `html.replace(/<[^>]*>/g, '')` strips angle-bracket tags but leaves the
// *contents* of <style> and <script> intact — so any HTML wrapped by
// wrapEmailHtml() (which embeds a 100+ line <style> block) produced a
// "plain-text" email starting with `body { margin: 0; padding: 0; … }`.
// Strip those blocks first, then drop the rest of the markup, then collapse
// runs of whitespace so the result is presentable in a plain-text reader.
function htmlToText(html) {
  if (typeof html !== 'string' || html.length === 0) return '';
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Keys whose values are already HTML or are server-generated URLs and so
// must NOT be HTML-escaped on substitution into the HTML body. Everything
// else (event_name, host_name, customer_name, …) is admin-supplied free
// text and gets escaped to prevent stored-HTML injection in customer mail.
const HTML_PASSTHROUGH_KEYS = new Set([
  'welcome_message',     // already HTML (formatWelcomeMessage escapes + nl2br)
  'gallery_link',        // server-generated URL (adminEvents.js)
  'client_link',         // server-generated URL (adminEvents.js)
  // customer_gallery_assigned template (#354 follow-up): server-rendered
  // <ul> of newly-added galleries. Built in customerAccountsService from
  // trusted DB rows (event_name comes from admin-owned events; the date
  // is server-rendered) — escaping it here would double-escape the markup.
  'gallery_list_html',
]);

const { escapeHtml } = require('../utils/formatters');

// Render a template string against a flat variables map.
// Supports two constructs only — no code execution:
//   - {{var}}              → variables[var] if defined, else left as-is
//   - {{#if var}}…{{/if}}  → inner content if variables[var] is truthy,
//                            else dropped entirely
//
// Conditionals are resolved before variable substitution so {{var}} inside
// a kept block still gets filled in. Nested {{#if}} blocks are not
// supported — the non-greedy match closes on the first {{/if}} and the
// outer block would be left malformed; switch to a real template engine
// if nesting is ever needed.
//
// Pass `{ escapeHtml: true }` for the HTML body so admin-supplied text is
// HTML-escaped on substitution; subject/textBody bodies should leave it off.
function safeTemplateReplace(template, variables, options = {}) {
  if (typeof template !== 'string' || template.length === 0) {
    return template;
  }
  const escapeOnSubstitute = options.escapeHtml === true;
  const conditionalsResolved = template.replace(
    /\{\{#if\s+(\w+)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_match, key, inner) => {
      const v = variables ? variables[key] : undefined;
      const truthy = v !== undefined && v !== null && v !== '' && v !== false && v !== 0;
      return truthy ? inner : '';
    }
  );
  return conditionalsResolved.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (!variables || !Object.prototype.hasOwnProperty.call(variables, key)) {
      return match;
    }
    const raw = String(variables[key]);
    if (escapeOnSubstitute && !HTML_PASSTHROUGH_KEYS.has(key)) {
      return escapeHtml(raw);
    }
    return raw;
  });
}

// Process email template with variables
async function processTemplate(template, variables, language = 'en') {
  // Import date formatter and text formatters
  const { formatDate } = require('../utils/dateFormatter');
  const { formatWelcomeMessage } = require('../utils/formatters');

  // Get translation from email_template_translations table with fallback chain
  let subject = '';
  let htmlBody = '';
  let textBody = '';

  try {
    // Try requested language first, then English, then any available
    let translation = await db('email_template_translations')
      .where({ template_id: template.id, language })
      .first();

    if (!translation && language !== 'en') {
      translation = await db('email_template_translations')
        .where({ template_id: template.id, language: 'en' })
        .first();
    }

    if (!translation) {
      translation = await db('email_template_translations')
        .where({ template_id: template.id })
        .first();
    }

    if (translation) {
      subject = translation.subject || '';
      htmlBody = translation.body_html || '';
      textBody = translation.body_text || '';
    }
  } catch (error) {
    logger.warn('email_template_translations table not available, falling back to columns:', error.message);
  }

  // Fallback to legacy column-based fields if no translation found
  if (!subject && !htmlBody) {
    const subjectField = language === 'de' ? 'subject_de' : 'subject_en';
    const htmlField = language === 'de' ? 'body_html_de' : 'body_html_en';
    const textField = language === 'de' ? 'body_text_de' : 'body_text_en';
    subject = template[subjectField] || template.subject_en || template.subject || '';
    htmlBody = template[htmlField] || template.body_html_en || template.body_html || '';
    textBody = template[textField] || template.body_text_en || template.body_text || '';
  }

  // Process variables before template compilation
  const processedVariables = { ...variables };

  // Handle password security message
  const passwordSecurityI18n = {
    en: '(Not shown for security reasons)',
    de: '(Aus Sicherheitsgründen nicht angezeigt)',
    nl: '(Om veiligheidsredenen niet weergegeven)',
    pt: '(Não exibido por motivos de segurança)',
    ru: '(Не показано в целях безопасности)',
    es: '(No se muestra por razones de seguridad)',
  };
  const noPasswordI18n = {
    en: 'No password required',
    de: 'Kein Passwort erforderlich',
    nl: 'Geen wachtwoord vereist',
    pt: 'Nenhuma senha necessária',
    ru: 'Пароль не требуется',
    es: 'No se requiere contraseña',
  };
  // Sent by the publish-from-draft flow (adminEvents.js): by the time the
  // event is published, only the bcrypt hash is stored, so the plaintext
  // password can't be re-included in the email. The route emits the literal
  // sentinel '(set at creation)' which we localise here.
  const passwordSetAtCreationI18n = {
    en: 'The password you set when creating the gallery',
    de: 'Das bei der Erstellung der Galerie gesetzte Passwort',
    nl: 'Het wachtwoord dat u bij het aanmaken van de galerij hebt ingesteld',
    pt: 'A senha definida ao criar a galeria',
    ru: 'Пароль, заданный при создании галереи',
    es: 'La contraseña que estableciste al crear la galería',
  };

  if (processedVariables.gallery_password === '{{password_security_message}}') {
    processedVariables.gallery_password = passwordSecurityI18n[language] || passwordSecurityI18n.en;
  }

  if (processedVariables.gallery_password === 'No password required') {
    processedVariables.gallery_password = noPasswordI18n[language] || noPasswordI18n.en;
  }

  if (processedVariables.gallery_password === '(set at creation)') {
    processedVariables.gallery_password = passwordSetAtCreationI18n[language] || passwordSetAtCreationI18n.en;
  }

  // Format dates if they exist
  if (processedVariables.event_date) {
    processedVariables.event_date = await formatDate(processedVariables.event_date, language);
  }
  if (processedVariables.expiry_date) {
    processedVariables.expiry_date = await formatDate(processedVariables.expiry_date, language);
  }
  if (processedVariables.archive_date) {
    processedVariables.archive_date = await formatDate(processedVariables.archive_date, language);
  }
  if (processedVariables.expires_at) {
    processedVariables.expires_at = await formatDate(processedVariables.expires_at, language);
  }

  // Format welcome message for HTML display (preserve line breaks)
  if (processedVariables.welcome_message) {
    processedVariables.welcome_message = formatWelcomeMessage(processedVariables.welcome_message);
  }

  subject = safeTemplateReplace(subject, processedVariables);
  htmlBody = safeTemplateReplace(htmlBody, processedVariables, { escapeHtml: true });
  textBody = safeTemplateReplace(textBody, processedVariables);

  // Inject client access section if client_link is provided (#172)
  if (processedVariables.client_link) {
    const clientAccessI18n = {
      de: {
        label: 'Kundenzugang (Privat)',
        desc: 'Fotos überprüfen und deren Sichtbarkeit festlegen, bevor die Galerie geteilt wird:',
        link: 'Kundenzugang öffnen',
        warning: 'Diesen Link nicht teilen — er ermöglicht das Ausblenden von Fotos in der Gästegalerie.',
        pin: 'PIN',
      },
      ru: {
        label: 'Доступ клиента (Личный)',
        desc: 'Просмотрите и управляйте видимостью фотографий перед тем, как поделиться галереей с гостями:',
        link: 'Открыть доступ клиента',
        warning: 'Не делитесь этой ссылкой — она позволяет скрывать фотографии из гостевой галереи.',
        pin: 'ПИН-код',
      },
      nl: {
        label: 'Klanttoegang (Privé)',
        desc: 'Bekijk en beheer de zichtbaarheid van foto\'s voordat u deelt met gasten:',
        link: 'Klanttoegang openen',
        warning: 'Deel deze link niet — hiermee kunnen foto\'s worden verborgen in de gastengalerij.',
        pin: 'PIN',
      },
      pt: {
        label: 'Acesso do Cliente (Privado)',
        desc: 'Revise e gerencie a visibilidade das fotos antes de compartilhar com os convidados:',
        link: 'Abrir Acesso do Cliente',
        warning: 'Não compartilhe este link — ele permite ocultar fotos da galeria de convidados.',
        pin: 'PIN',
      },
      en: {
        label: 'Client Access (Private)',
        desc: 'Review and manage photo visibility before sharing with guests:',
        link: 'Open Client Access',
        warning: 'Do not share this link — it allows hiding photos from the guest gallery.',
        pin: 'PIN',
      },
    };
    const ci18n = clientAccessI18n[language] || clientAccessI18n.en;

    // The client-access CTA used to be a hard-coded #5C8762 fill; now it
    // mirrors the configurable email_primary_color so the brand colour is
    // consistent across every button in the email. Defaults match the
    // historical literal so unchanged installs render identically.
    let cli_primary = '#5C8762';
    let cli_buttonText = '#ffffff';
    try {
      const rows = await db('app_settings')
        .whereIn('setting_key', ['email_primary_color', 'email_button_text_color'])
        .select('setting_key', 'setting_value');
      rows.forEach((row) => {
        if (!row.setting_value) return;
        let parsed;
        try { parsed = JSON.parse(row.setting_value); } catch (e) { parsed = row.setting_value; }
        if (row.setting_key === 'email_primary_color') cli_primary = parsed || cli_primary;
        if (row.setting_key === 'email_button_text_color') cli_buttonText = parsed || cli_buttonText;
      });
    } catch (e) {
      // Non-fatal — fall back to literals so the email still renders.
      logger.warn('Failed to read email colours for client-access block', { error: e.message });
    }

    htmlBody += `
      <div style="margin-top: 24px; padding: 20px; background: #fff3cd; border-left: 4px solid #ffc107; border-radius: 4px;">
        <strong style="font-size: 15px;">&#128274; ${ci18n.label}</strong>
        <p style="margin: 10px 0 8px;">${ci18n.desc}</p>
        <p style="margin: 8px 0;">
          <a href="${processedVariables.client_link}" style="display: inline-block; padding: 10px 20px; background-color: ${cli_primary}; color: ${cli_buttonText}; text-decoration: none; border-radius: 6px; font-weight: 600;">${ci18n.link}</a>
        </p>
        <p style="margin: 8px 0;">${ci18n.pin}: <strong>${processedVariables.client_password}</strong></p>
        <p style="color: #856404; font-size: 12px; margin: 8px 0 0;">&#9888;&#65039; ${ci18n.warning}</p>
      </div>`;

    // Mirror the same section in the plain-text body — without this, recipients
    // on a text-only mail client never saw the client link or PIN.
    if (textBody) {
      textBody += `\n\n${ci18n.label}\n${ci18n.desc}\n${processedVariables.client_link}\n${ci18n.pin}: ${processedVariables.client_password}\n${ci18n.warning}\n`;
    }
  }

  // Wrap HTML body in styled template
  const styledHtmlBody = await wrapEmailHtml(htmlBody, subject, language);

  return { subject, htmlBody: styledHtmlBody, textBody };
}

// Send email using template
async function sendTemplateEmail(to, templateKey, variables) {
  try {
    // Always check for configuration changes before sending
    transporter = await initializeTransporter();
    if (!transporter) {
      throw new Error('Email service not configured');
    }

    // Get email template
    const template = await db('email_templates')
      .where('template_key', templateKey)
      .first();
    
    if (!template) {
      throw new Error(`Email template '${templateKey}' not found`);
    }

    // Get email config for from address
    const config = await db('email_configs').first();
    if (!config) {
      throw new Error('Email configuration not found');
    }

    // Determine recipient language. An explicit `__language` in the email data
    // wins (CRM/billing emails set it to the customer/invoice language so a
    // gallery event's language can't override a dunning notice — see #760);
    // otherwise fall back to the event-first recipient resolution.
    const language = variables.__language || await getRecipientLanguage(to, variables.eventId || null);

    // Process template with variables
    const { subject, htmlBody, textBody } = await processTemplate(template, variables, language);

    // Optional plumbing — quote/invoice emails set these. Attachments
    // are passed by callers as [{ filename, contentPath }] where the
    // file is already written to disk; nodemailer streams it.
    const ccList = Array.isArray(variables.cc)
      ? variables.cc.filter(Boolean)
      : (typeof variables.cc === 'string' && variables.cc.trim())
        ? variables.cc.split(/[,;]+/).map((s) => s.trim()).filter(Boolean)
        : undefined;
    const attachments = Array.isArray(variables.attachments)
      ? variables.attachments
          .filter((a) => a && (a.contentPath || a.path || a.content))
          .map((a) => ({
            filename: a.filename,
            path: a.contentPath || a.path,
            content: a.content,
            contentType: a.contentType,
          }))
      : undefined;

    // Send email
    const info = await transporter.sendMail({
      from: `${config.from_name} <${config.from_email}>`,
      to: to,
      cc: ccList,
      subject: subject,
      html: htmlBody,
      text: textBody || htmlToText(htmlBody),
      attachments,
    });

    logger.info(`Email sent successfully: ${info.messageId} (${language})`);
    // Return the rendered HTML so the queue processor can persist the ACTUAL
    // sent body (email_queue.rendered_html) for the Project Overview preview.
    return { success: true, messageId: info.messageId, language, html: htmlBody };
  } catch (error) {
    logger.error('Error sending template email:', error);
    throw error;
  }
}

/**
 * Render a queued email's HTML WITHOUT sending it. Used by the Project
 * Overview cockpit to preview emails that predate the rendered_html column
 * (so nothing was stored at send time). The result is rendered from the
 * CURRENT template + the row's stored variables, so it's a faithful
 * approximation rather than the exact bytes that were sent — callers flag
 * it as a re-render. Returns null when the template no longer exists.
 */
async function renderQueuedEmail(templateKey, variables = {}, to = '') {
  const template = await db('email_templates').where('template_key', templateKey).first();
  if (!template) return null;
  const language = variables.__language || await getRecipientLanguage(to, variables.eventId || null);
  const { subject, htmlBody } = await processTemplate(template, variables, language);
  return { subject, html: htmlBody };
}

// Process email queue.
//
// Options:
//   ignoreSchedule  when true, send every pending email regardless of its
//                   `scheduled_at` floor (used by the admin "send now" flush
//                   before maintenance/updates). The scheduled interval run
//                   leaves it false so future-dated emails keep waiting.
//   limit           max emails per pass. The flush raises this to drain the
//                   whole queue in a single pass (no re-query, so a failing
//                   email isn't retried in a tight loop within one flush).
//   onlyId          when set, process EXACTLY this one queue row. Used by the
//                   cockpit "send now" so a forced send never sweeps up OTHER
//                   dead-lettered emails (those past the retry cap) just
//                   because ignoreSchedule also bypasses that cap.
//
// Returns { processed, sent, failed }.
async function processEmailQueue({ ignoreSchedule = false, limit = 10, onlyId = null } = {}) {
  logger.info('Email queue processor: Checking for pending emails...');
  const result = { processed: 0, sent: 0, failed: 0 };

  try {
    // Try to initialize transporter if it's null (in case it failed at startup)
    if (!transporter) {
      logger.info('Transporter not initialized, attempting to initialize...');
      transporter = await initializeTransporter();
      if (!transporter) {
        logger.warn('Email transporter could not be initialized, skipping queue processing');
        return result;
      }
    }

    let pendingEmails = [];
    try {
      // Pick up emails that are pending AND either have no `scheduled_at`
      // or whose scheduled_at is in the past. Used by CRM invoices to
      // queue split-payment emails relative to the event date.
      const now = new Date();
      const query = db('email_queue')
        .where('status', 'pending');
      // Targeted single-email flush (cockpit "send now"): scope to that row
      // only, so we never force-retry other dead-lettered emails.
      if (onlyId != null) query.where('id', onlyId);
      if (!ignoreSchedule) {
        // Automatic runs: respect the retry cap (don't hammer a failing
        // address) AND the schedule (business-hours floor / future send).
        query.where('retry_count', '<', 3).andWhere(function() {
          this.whereNull('scheduled_at').orWhere('scheduled_at', '<=', now);
        });
      }
      // A manual "send now" (ignoreSchedule) deliberately bypasses BOTH the
      // schedule and the retry cap: the admin is forcing a retry, typically
      // right after fixing SMTP. Without this, emails that failed 3× during
      // an SMTP outage are stuck "pending" forever with no way to resend.
      pendingEmails = await query
        .orderBy('scheduled_at', 'asc')
        .orderBy('created_at', 'asc')
        .limit(limit);
    } catch (dbError) {
      logger.error('Failed to query email queue:', dbError);
      return result;
    }

    if (pendingEmails.length === 0) {
      logger.info('Email queue processor: No pending emails found');
      return result;
    }

    logger.info(`Processing ${pendingEmails.length} emails from queue`);
    result.processed = pendingEmails.length;

    for (const email of pendingEmails) {
      try {
        const emailData = typeof email.email_data === 'string'
          ? JSON.parse(email.email_data || '{}')
          : email.email_data || {};

        // Language is resolved from emailData.eventId (event.language is the top
        // priority). queueEmail injects it, but direct email_queue inserts (e.g.
        // the gallery-publish notification) only set the event_id COLUMN — so
        // backfill from the authoritative column so every send path resolves the
        // recipient language from the event consistently.
        if (emailData.eventId == null && email.event_id != null) {
          emailData.eventId = email.event_id;
        }

        const sendResult = await sendTemplateEmail(
          email.recipient_email,
          email.email_type,
          emailData
        );

        // Mark as sent, persisting the actual rendered HTML for the Project
        // Overview email preview (guarded — older installs without migration
        // 119 just skip it).
        const sentUpdate = { status: 'sent', sent_at: new Date() };
        try {
          if (sendResult && sendResult.html && await hasColumnCached('email_queue', 'rendered_html')) {
            sentUpdate.rendered_html = sendResult.html;
          }
        } catch (_) { /* best-effort — never block the send on the preview */ }
        await db('email_queue')
          .where('id', email.id)
          .update(sentUpdate);

        result.sent += 1;
        logger.info(`Email ${email.id} sent successfully`);
      } catch (error) {
        result.failed += 1;
        // Increment retry count
        try {
          await db('email_queue')
            .where('id', email.id)
            .update({
              retry_count: email.retry_count + 1,
              error_message: error.message
            });
        } catch (updateError) {
          logger.error(`Failed to update email retry count for ${email.id}:`, updateError);
          // If update fails due to column issue, try without any potential auto-added fields
          if (updateError.message && updateError.message.includes('updated_at')) {
            logger.warn('Detected updated_at column issue, attempting raw query...');
            await db.raw(
              'UPDATE email_queue SET retry_count = ?, error_message = ? WHERE id = ?',
              [email.retry_count + 1, error.message, email.id]
            );
          }
        }
          
        logger.error(`Failed to send email ${email.id}:`, error);
      }
    }
  } catch (error) {
    logger.error('Error processing email queue:', error);
  }

  return result;
}

// Load + normalise the business-hours config used by queueEmail. The
// definition lives on the singleton business_profile row (migration 114):
//   business_hours                 JSON, per-ISO-weekday opening blocks
//   scheduled_email_floor_enabled  master on/off switch
//   timezone                       IANA zone the blocks are read in
// Any failure (column missing on a half-migrated install, bad data) or an
// unconfigured schedule degrades to `enabled: false` so a queued email is
// never lost — it just sends at its original time.
async function getScheduledEmailConfig() {
  try {
    if (!(await hasColumnCached('business_profile', 'business_hours'))) {
      return { enabled: false };
    }
    const hasToggle = await hasColumnCached('business_profile', 'scheduled_email_floor_enabled');
    const cols = ['business_hours', 'timezone'];
    if (hasToggle) cols.push('scheduled_email_floor_enabled');
    const profile = await db('business_profile').where({ id: 1 }).first(cols);
    if (!profile) return { enabled: false };

    const enabled = hasToggle
      ? (profile.scheduled_email_floor_enabled === true
        || profile.scheduled_email_floor_enabled === 1
        || profile.scheduled_email_floor_enabled === '1')
      : true;
    if (!enabled) return { enabled: false };

    const schedule = normaliseSchedule(profile.business_hours);

    let timezone = (profile.timezone || '').trim();
    if (!timezone) {
      // PR #603 review follow-up #4 — business hours are configured but the
      // profile timezone is blank, so we fall back to the SERVER's tz (usually
      // UTC on a Docker host). That silently shifts every business-hours
      // calculation. Warn loudly so the admin sets business_profile.timezone.
      timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      logger.warn(
        'Scheduled-email business hours are set but business_profile.timezone is blank — '
        + `falling back to the server timezone (${timezone}). Set the profile timezone `
        + 'so business-hours snapping uses your local time, not the server\'s.',
      );
    }
    // Reject a bogus tz before it reaches Intl in the snap helper.
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    } catch (_) {
      timezone = 'UTC';
    }

    return { enabled: true, timezone, schedule };
  } catch (err) {
    logger.warn(`Business-hours config unavailable, skipping email floor: ${err.message}`);
    return { enabled: false };
  }
}

// Queue an email for sending. Optionally takes a 5th `options` arg:
//   options.scheduledAt — Date | ISO string; row only picks up once
//                         this moment has passed (used by CRM split-
//                         payment invoices). NULL = send immediately.
//   options.respectBusinessHours — when true, snap the send time to the
//                         next open business-hours block (from "now").
//                         Use for automated/relationship mail (dunning
//                         reminders, gallery-expiry warnings) so we don't
//                         ping customers overnight. No-op when the floor
//                         is off / business hours unconfigured / already
//                         inside a block. Leave it off for transactional
//                         + admin-initiated mail so those send instantly.
// Attachments + cc travel inside `emailData` (keys: attachments, cc)
// so callers don't need a new signature for every email shape.
async function queueEmail(eventId, recipientEmail, emailType, emailData, options = {}) {
  try {
    // Add eventId to emailData for language detection
    emailData.eventId = eventId;
    const row = {
      event_id: eventId,
      recipient_email: recipientEmail,
      email_type: emailType,
      email_data: JSON.stringify(emailData),
      status: 'pending',
      retry_count: 0,
      created_at: new Date(),
    };
    let snappedFrom = null;
    // Base time to schedule from:
    //   - explicit options.scheduledAt (CRM split-payment invoices), OR
    //   - "now" when the caller opts into the business-hours floor via
    //     options.respectBusinessHours — automated / relationship mail
    //     like dunning reminders + gallery-expiry warnings, so we don't
    //     ping the customer at 02:00.
    // Both snap to the next open business-hours block. No-op when the
    // floor is disabled, business hours are unconfigured, or the instant
    // already lands inside a block. Transactional / admin-initiated mail
    // (invoice_sent, storno, invitations, password resets) passes neither
    // option and sends immediately.
    const baseTime = options.scheduledAt
      ? (options.scheduledAt instanceof Date ? options.scheduledAt : new Date(options.scheduledAt))
      : (options.respectBusinessHours ? new Date() : null);
    if (baseTime) {
      const cfg = await getScheduledEmailConfig();
      const snapped = snapToBusinessHours(baseTime, cfg);
      if (snapped.getTime() !== baseTime.getTime()) snappedFrom = baseTime;
      // Persist a future scheduled_at for an explicit scheduledAt always;
      // for the respectBusinessHours floor only when it actually moved the
      // time forward (inside hours → leave null → processor sends at once).
      if (options.scheduledAt || snappedFrom) row.scheduled_at = snapped;
    }
    await db('email_queue').insert(row);

    logger.info(`Email queued: ${emailType} to ${recipientEmail}${
      row.scheduled_at ? ` (scheduled ${row.scheduled_at.toISOString()}${
        snappedFrom ? `, floored from ${snappedFrom.toISOString()}` : ''
      })` : ''
    }`);
  } catch (error) {
    logger.error('Error queueing email:', error);
    throw error;
  }
}

// Test email connection
async function testEmailConnection() {
  try {
    if (!transporter) {
      await initializeTransporter();
    }
    if (!transporter) {
      return false;
    }
    await transporter.verify();
    return true;
  } catch (error) {
    logger.error('Email connection test failed:', error);
    return false;
  }
}

// Start email queue processor
let emailQueueInterval = null;

function startEmailQueueProcessor() {
  logger.info('Email queue processor: Attempting to start...');
  
  if (!emailQueueInterval) {
    // Process immediately on start
    processEmailQueue().catch(err => {
      logger.error('Email queue processor: Initial processing failed:', err);
    });
    
    // Then process every minute
    emailQueueInterval = setInterval(() => {
      processEmailQueue().catch(err => {
        logger.error('Email queue processor: Periodic processing failed:', err);
      });
    }, 60000);
    
    logger.info('Email queue processor started successfully');
  } else {
    logger.info('Email queue processor: Already running');
  }
}

function stopEmailQueueProcessor() {
  if (emailQueueInterval) {
    clearInterval(emailQueueInterval);
    emailQueueInterval = null;
    logger.info('Email queue processor stopped');
  }
}

// Initialize on module load - DISABLED for production startup
// This will be called from server.js after database is ready
// initializeTransporter().then(() => {
//   startEmailQueueProcessor();
// });

module.exports = {
  initializeTransporter,
  startEmailQueueProcessor,
  sendTemplateEmail,
  renderQueuedEmail,
  processEmailQueue,
  queueEmail,
  stopEmailQueueProcessor,
  testEmailConnection,
  wrapEmailHtml,
  safeTemplateReplace,
  getSupportEmail,
  htmlToText
};
