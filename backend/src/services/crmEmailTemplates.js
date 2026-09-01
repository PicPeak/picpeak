/**
 * CRM email template definitions (quotes / invoices / Storno / payment-check
 * / paid-admin-notification) — runtime self-heal seeder.
 *
 * Original sources: migrations 102 (8 templates), 112 (quote_accepted_customer),
 * 116 (invoice_payment_check), 122 (storno_issued), 127 (invoice_paid_admin_notification).
 *
 * The consolidated migration (107_crm_consolidated.js) owns SCHEMA only;
 * this service file owns CONTENT. `ensureCrmEmailTemplatesSeeded()` is
 * idempotent — call it from server boot, GET /admin/email/templates,
 * and any code path about to send one of these templates. Missing
 * rows get inserted; existing rows are LEFT ALONE so admin edits are
 * never overwritten.
 *
 * Same pattern as contractEmailTemplates.js + eventReminderTemplates.js
 * — per the maintainer's "never ship compensation migrations" rule,
 * we self-heal at runtime instead of bolting content into the schema diff.
 *
 * Translations: en + de hand-translated; fr/nl/pt/ru intentionally
 * absent. Renderer falls through to en until admin overrides via the
 * Templates UI. Flag for native review in the PR description.
 */

const CRM_EMAIL_TEMPLATES = {
  quote_sent: {
    category: 'quotes', feature_flag: 'quotes',
    variables: ['quote_number', 'customer_name', 'response_url', 'accept_url', 'decline_url',
      'valid_until', 'event_name', 'total_amount'],
    en: {
      subject: 'Your quote {{quote_number}} is ready',
      body_html: `<h2>Quote {{quote_number}}</h2>
<p>Dear {{customer_name}},</p>
<p>Please find the attached quote {{quote_number}}{{#if event_name}} for "{{event_name}}"{{/if}}. Total amount: <strong>{{total_amount}}</strong>.</p>
<p>You can accept or decline this quote directly via the buttons below:</p>
<p style="text-align: center; margin: 30px 0;">
  <a href="{{accept_url}}" class="button">Accept quote</a>
  &nbsp;
  <a href="{{decline_url}}" style="display:inline-block;padding:10px 20px;color:#666;text-decoration:underline;">Decline</a>
</p>
<p>Or open the full quote in your browser:<br>
<span style="word-break: break-all; font-size: 13px;">{{response_url}}</span></p>
{{#if valid_until}}<p style="font-size: 13px; color: #666;">This quote is valid until {{valid_until}}.</p>{{/if}}`,
      body_text: 'Quote {{quote_number}}\n\nDear {{customer_name}},\n\nPlease find the attached quote {{quote_number}}. Total: {{total_amount}}.\n\nRespond: {{response_url}}\nAccept: {{accept_url}}\nDecline: {{decline_url}}\n\n{{#if valid_until}}Valid until {{valid_until}}.{{/if}}',
    },
    de: {
      subject: 'Ihr Angebot {{quote_number}} ist bereit',
      body_html: `<h2>Angebot {{quote_number}}</h2>
<p>Sehr geehrte/r {{customer_name}},</p>
<p>im Anhang finden Sie das Angebot {{quote_number}}{{#if event_name}} für "{{event_name}}"{{/if}}. Gesamtbetrag: <strong>{{total_amount}}</strong>.</p>
<p>Sie können das Angebot direkt über die Schaltflächen unten annehmen oder ablehnen:</p>
<p style="text-align: center; margin: 30px 0;">
  <a href="{{accept_url}}" class="button">Angebot annehmen</a>
  &nbsp;
  <a href="{{decline_url}}" style="display:inline-block;padding:10px 20px;color:#666;text-decoration:underline;">Ablehnen</a>
</p>
<p>Oder öffnen Sie das vollständige Angebot im Browser:<br>
<span style="word-break: break-all; font-size: 13px;">{{response_url}}</span></p>
{{#if valid_until}}<p style="font-size: 13px; color: #666;">Dieses Angebot ist gültig bis {{valid_until}}.</p>{{/if}}`,
      body_text: 'Angebot {{quote_number}}\n\nSehr geehrte/r {{customer_name}},\n\nim Anhang finden Sie das Angebot {{quote_number}}. Gesamtbetrag: {{total_amount}}.\n\nAnsehen: {{response_url}}\nAnnehmen: {{accept_url}}\nAblehnen: {{decline_url}}\n\n{{#if valid_until}}Gültig bis {{valid_until}}.{{/if}}',
    },
  },
  quote_accepted_admin: {
    category: 'quotes', feature_flag: 'quotes',
    variables: ['quote_number', 'customer_email', 'event_name', 'total_amount', 'admin_dashboard_url'],
    en: {
      subject: 'Quote {{quote_number}} accepted by {{customer_email}}',
      body_html: `<h2>Quote accepted</h2><p>{{customer_email}} just accepted quote <strong>{{quote_number}}</strong>{{#if event_name}} for "{{event_name}}"{{/if}}. Total: {{total_amount}}.</p>
<p style="text-align: center; margin: 30px 0;"><a href="{{admin_dashboard_url}}" class="button">Open in admin</a></p>`,
      body_text: 'Quote {{quote_number}} accepted by {{customer_email}}. Open: {{admin_dashboard_url}}',
    },
    de: {
      subject: 'Angebot {{quote_number}} von {{customer_email}} angenommen',
      body_html: `<h2>Angebot angenommen</h2><p>{{customer_email}} hat soeben das Angebot <strong>{{quote_number}}</strong>{{#if event_name}} für "{{event_name}}"{{/if}} angenommen. Gesamtbetrag: {{total_amount}}.</p>
<p style="text-align: center; margin: 30px 0;"><a href="{{admin_dashboard_url}}" class="button">Im Admin-Bereich öffnen</a></p>`,
      body_text: 'Angebot {{quote_number}} von {{customer_email}} angenommen. Öffnen: {{admin_dashboard_url}}',
    },
  },
  quote_declined_admin: {
    category: 'quotes', feature_flag: 'quotes',
    variables: ['quote_number', 'customer_email', 'event_name', 'admin_dashboard_url'],
    en: {
      subject: 'Quote {{quote_number}} declined by {{customer_email}}',
      body_html: `<p>{{customer_email}} declined quote <strong>{{quote_number}}</strong>{{#if event_name}} for "{{event_name}}"{{/if}}.</p>
<p><a href="{{admin_dashboard_url}}">Open quote in admin</a></p>`,
      body_text: 'Quote {{quote_number}} declined by {{customer_email}}. Open: {{admin_dashboard_url}}',
    },
    de: {
      subject: 'Angebot {{quote_number}} von {{customer_email}} abgelehnt',
      body_html: `<p>{{customer_email}} hat das Angebot <strong>{{quote_number}}</strong>{{#if event_name}} für "{{event_name}}"{{/if}} abgelehnt.</p>
<p><a href="{{admin_dashboard_url}}">Angebot im Admin-Bereich öffnen</a></p>`,
      body_text: 'Angebot {{quote_number}} von {{customer_email}} abgelehnt. Öffnen: {{admin_dashboard_url}}',
    },
  },
  invoice_sent: {
    category: 'billing', feature_flag: 'bills',
    variables: ['invoice_number', 'customer_name', 'event_name', 'total_amount', 'due_date',
      'installment_label', 'installment_index', 'installment_total'],
    en: {
      subject: 'Invoice {{invoice_number}} — {{total_amount}}',
      body_html: `<h2>Invoice {{invoice_number}}</h2><p>Dear {{customer_name}},</p>
<p>Please find the attached invoice {{invoice_number}}{{#if event_name}} for "{{event_name}}"{{/if}}.</p>
<p><strong>Amount:</strong> {{total_amount}}<br><strong>Due:</strong> {{due_date}}{{#if installment_label}}<br><strong>Installment:</strong> {{installment_label}} ({{installment_index}}/{{installment_total}}){{/if}}</p>
<p>The payment details and IBAN are on the attached PDF.</p>`,
      body_text: 'Invoice {{invoice_number}}: {{total_amount}}, due {{due_date}}.',
    },
    de: {
      subject: 'Rechnung {{invoice_number}} — {{total_amount}}',
      body_html: `<h2>Rechnung {{invoice_number}}</h2><p>Sehr geehrte/r {{customer_name}},</p>
<p>im Anhang finden Sie die Rechnung {{invoice_number}}{{#if event_name}} für "{{event_name}}"{{/if}}.</p>
<p><strong>Betrag:</strong> {{total_amount}}<br><strong>Fällig:</strong> {{due_date}}{{#if installment_label}}<br><strong>Teilzahlung:</strong> {{installment_label}} ({{installment_index}}/{{installment_total}}){{/if}}</p>
<p>Die Zahlungsdetails und IBAN finden Sie auf dem beigefügten PDF.</p>`,
      body_text: 'Rechnung {{invoice_number}}: {{total_amount}}, fällig {{due_date}}.',
    },
  },
  invoice_reminder_first: {
    category: 'billing', feature_flag: 'bills',
    variables: ['invoice_number', 'customer_name', 'total_amount', 'due_date', 'days_overdue'],
    en: {
      subject: 'Reminder: invoice {{invoice_number}} is overdue',
      body_html: `<h2>Payment reminder</h2><p>Dear {{customer_name}},</p>
<p>Our records show that invoice <strong>{{invoice_number}}</strong> (originally due {{due_date}}) is now {{days_overdue}} days overdue. The outstanding amount is <strong>{{total_amount}}</strong>.</p>
<p>If you have already paid, please ignore this reminder. Otherwise, please find a fresh copy attached.</p>`,
      body_text: 'Invoice {{invoice_number}} is {{days_overdue}} days overdue. Outstanding: {{total_amount}}.',
    },
    de: {
      subject: 'Zahlungserinnerung: Rechnung {{invoice_number}}',
      body_html: `<h2>Zahlungserinnerung</h2><p>Sehr geehrte/r {{customer_name}},</p>
<p>laut unseren Unterlagen ist die Rechnung <strong>{{invoice_number}}</strong> (ursprünglich fällig am {{due_date}}) seit {{days_overdue}} Tagen überfällig. Der offene Betrag beträgt <strong>{{total_amount}}</strong>.</p>
<p>Sollten Sie die Zahlung bereits veranlasst haben, betrachten Sie diese Erinnerung als gegenstandslos. Im Anhang finden Sie eine aktuelle Kopie der Rechnung.</p>`,
      body_text: 'Rechnung {{invoice_number}} ist seit {{days_overdue}} Tagen überfällig. Offen: {{total_amount}}.',
    },
  },
  invoice_reminder_second: {
    category: 'billing', feature_flag: 'bills',
    variables: ['invoice_number', 'customer_name', 'total_amount', 'due_date', 'days_overdue',
      'late_fee_amount', 'new_total_amount'],
    en: {
      subject: 'Second reminder: invoice {{invoice_number}}',
      body_html: `<h2>Second payment reminder</h2><p>Dear {{customer_name}},</p>
<p>Invoice <strong>{{invoice_number}}</strong> is now {{days_overdue}} days overdue. As advised in our payment terms, a late fee of <strong>{{late_fee_amount}}</strong> has been added. The new total is <strong>{{new_total_amount}}</strong>.</p>
<p>Please settle the outstanding amount as soon as possible. A revised invoice is attached.</p>`,
      body_text: 'Second reminder for {{invoice_number}}. Late fee {{late_fee_amount}} added. New total: {{new_total_amount}}.',
    },
    de: {
      subject: 'Zweite Mahnung: Rechnung {{invoice_number}}',
      body_html: `<h2>Zweite Zahlungserinnerung</h2><p>Sehr geehrte/r {{customer_name}},</p>
<p>die Rechnung <strong>{{invoice_number}}</strong> ist nun seit {{days_overdue}} Tagen überfällig. Gemäss unseren Zahlungsbedingungen wurde eine Mahngebühr von <strong>{{late_fee_amount}}</strong> hinzugefügt. Der neue Gesamtbetrag beträgt <strong>{{new_total_amount}}</strong>.</p>
<p>Wir bitten Sie, den offenen Betrag umgehend zu begleichen. Eine aktualisierte Rechnung finden Sie im Anhang.</p>`,
      body_text: 'Zweite Mahnung für {{invoice_number}}. Mahngebühr {{late_fee_amount}} hinzugefügt. Neuer Gesamtbetrag: {{new_total_amount}}.',
    },
  },
  invoice_paid_receipt: {
    category: 'billing', feature_flag: 'bills',
    variables: ['invoice_number', 'customer_name', 'paid_amount', 'paid_at'],
    en: {
      subject: 'Receipt for invoice {{invoice_number}}',
      body_html: `<h2>Payment received</h2><p>Dear {{customer_name}},</p>
<p>We received your payment of <strong>{{paid_amount}}</strong> for invoice {{invoice_number}} on {{paid_at}}. Thank you!</p>`,
      body_text: 'Receipt: {{paid_amount}} received for {{invoice_number}} on {{paid_at}}.',
    },
    de: {
      subject: 'Zahlungsbestätigung für Rechnung {{invoice_number}}',
      body_html: `<h2>Zahlung erhalten</h2><p>Sehr geehrte/r {{customer_name}},</p>
<p>vielen Dank für Ihre Zahlung in Höhe von <strong>{{paid_amount}}</strong> für die Rechnung {{invoice_number}} am {{paid_at}}.</p>`,
      body_text: 'Zahlungsbestätigung: {{paid_amount}} erhalten für {{invoice_number}} am {{paid_at}}.',
    },
  },
  invoice_cancelled: {
    category: 'billing', feature_flag: 'bills',
    variables: ['invoice_number', 'customer_name'],
    en: {
      subject: 'Invoice {{invoice_number}} cancelled',
      body_html: '<p>Dear {{customer_name}},</p><p>Invoice {{invoice_number}} has been cancelled. Please disregard any previous reminders for this invoice.</p>',
      body_text: 'Invoice {{invoice_number}} has been cancelled.',
    },
    de: {
      subject: 'Rechnung {{invoice_number}} storniert',
      body_html: '<p>Sehr geehrte/r {{customer_name}},</p><p>die Rechnung {{invoice_number}} wurde storniert. Bitte ignorieren Sie eventuelle frühere Erinnerungen zu dieser Rechnung.</p>',
      body_text: 'Rechnung {{invoice_number}} wurde storniert.',
    },
  },
  quote_accepted_customer: {
    category: 'quotes',
    feature_flag: 'quotes',
    variables: ['customer_name', 'quote_number', 'event_name', 'total_amount', 'accepted_on_behalf'],
    en: {
      subject: 'Quote {{quote_number}} accepted — thank you',
      body_html: `<h2>Thank you</h2>
<p>Dear {{customer_name}},</p>
<p>This confirms that quote <strong>{{quote_number}}</strong>{{#if event_name}} for "{{event_name}}"{{/if}} has been accepted. Total: <strong>{{total_amount}}</strong>.</p>
{{#if accepted_on_behalf}}<p style="font-size: 13px; color: #666;">This acceptance was recorded on your behalf by your photographer.</p>{{/if}}
<p>We'll be in touch with next steps shortly.</p>`,
      body_text: `Dear {{customer_name}},

This confirms that quote {{quote_number}}{{#if event_name}} for "{{event_name}}"{{/if}} has been accepted. Total: {{total_amount}}.
{{#if accepted_on_behalf}}
This acceptance was recorded on your behalf by your photographer.
{{/if}}
We'll be in touch with next steps shortly.`,
    },
    de: {
      subject: 'Angebot {{quote_number}} angenommen — vielen Dank',
      body_html: `<h2>Vielen Dank</h2>
<p>Sehr geehrte/r {{customer_name}},</p>
<p>hiermit bestätigen wir, dass das Angebot <strong>{{quote_number}}</strong>{{#if event_name}} für „{{event_name}}"{{/if}} angenommen wurde. Gesamtbetrag: <strong>{{total_amount}}</strong>.</p>
{{#if accepted_on_behalf}}<p style="font-size: 13px; color: #666;">Diese Bestätigung wurde stellvertretend durch Ihren Fotografen erfasst.</p>{{/if}}
<p>Wir melden uns in Kürze mit den nächsten Schritten.</p>`,
      body_text: `Sehr geehrte/r {{customer_name}},

hiermit bestätigen wir, dass das Angebot {{quote_number}}{{#if event_name}} für "{{event_name}}"{{/if}} angenommen wurde. Gesamtbetrag: {{total_amount}}.
{{#if accepted_on_behalf}}
Diese Bestätigung wurde stellvertretend durch Ihren Fotografen erfasst.
{{/if}}
Wir melden uns in Kürze mit den nächsten Schritten.`,
    },
  },
  invoice_payment_check: {
    category: 'billing', feature_flag: 'bills',
    variables: ['invoice_number', 'customer_name', 'event_name', 'due_date', 'total_amount', 'paid_url', 'partial_url', 'unpaid_url', 'skonto_url', 'has_skonto', 'skonto_amount', 'late_fee_due', 'late_fee_amount'],
    en: {
      subject: 'Check payment for invoice {{invoice_number}}',
      body_html: `<h2>Time to check on a payment</h2>
<p>Invoice <strong>{{invoice_number}}</strong> for <strong>{{customer_name}}</strong>{{#if event_name}} ({{event_name}}){{/if}} was due on <strong>{{due_date}}</strong>. Total: <strong>{{total_amount}}</strong>.</p>
<p>Please check your bank to confirm what (if anything) has been received, then click the matching button below — no login required.</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 24px auto; border-collapse: collapse;">
  <tr>
    <td style="padding: 0 6px;">
      <a href="{{paid_url}}" style="background: #16a34a; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-weight: 600; display: inline-block;">Paid in full</a>
    </td>
    {{#if has_skonto}}<td style="padding: 0 6px;">
      <a href="{{skonto_url}}" style="background: #0d9488; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-weight: 600; display: inline-block;">Paid with Skonto ({{skonto_amount}})</a>
    </td>{{/if}}
    <td style="padding: 0 6px;">
      <a href="{{partial_url}}" style="background: #2563eb; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-weight: 600; display: inline-block;">Partially paid</a>
    </td>
    <td style="padding: 0 6px;">
      <a href="{{unpaid_url}}" style="background: #dc2626; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-weight: 600; display: inline-block;">Not paid yet</a>
    </td>
  </tr>
</table>
<p style="font-size: 13px; color: #666;">If you select "Not paid yet" or "Partially paid", the system will queue the next reminder to the customer{{#if late_fee_due}} including a late fee of {{late_fee_amount}}{{/if}}.</p>`,
      body_text: `Time to check on a payment

Invoice {{invoice_number}} for {{customer_name}}{{#if event_name}} ({{event_name}}){{/if}} was due on {{due_date}}. Total: {{total_amount}}.

Confirm what was received:
  Paid in full:           {{paid_url}}{{#if has_skonto}}
  Paid with Skonto ({{skonto_amount}}): {{skonto_url}}{{/if}}
  Partial:                {{partial_url}}
  Not paid yet:           {{unpaid_url}}

Selecting "Not paid yet" or "Partially paid" will queue the customer reminder{{#if late_fee_due}} including a late fee of {{late_fee_amount}}{{/if}}.`,
    },
    de: {
      subject: 'Zahlung prüfen für Rechnung {{invoice_number}}',
      body_html: `<h2>Zahlung prüfen</h2>
<p>Rechnung <strong>{{invoice_number}}</strong> für <strong>{{customer_name}}</strong>{{#if event_name}} ({{event_name}}){{/if}} war am <strong>{{due_date}}</strong> fällig. Gesamtbetrag: <strong>{{total_amount}}</strong>.</p>
<p>Bitte prüfen Sie auf Ihrem Konto, was eingegangen ist, und klicken Sie unten den passenden Button — kein Login nötig.</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 24px auto; border-collapse: collapse;">
  <tr>
    <td style="padding: 0 6px;">
      <a href="{{paid_url}}" style="background: #16a34a; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-weight: 600; display: inline-block;">Vollständig bezahlt</a>
    </td>
    {{#if has_skonto}}<td style="padding: 0 6px;">
      <a href="{{skonto_url}}" style="background: #0d9488; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-weight: 600; display: inline-block;">Mit Skonto bezahlt ({{skonto_amount}})</a>
    </td>{{/if}}
    <td style="padding: 0 6px;">
      <a href="{{partial_url}}" style="background: #2563eb; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-weight: 600; display: inline-block;">Teilweise bezahlt</a>
    </td>
    <td style="padding: 0 6px;">
      <a href="{{unpaid_url}}" style="background: #dc2626; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-weight: 600; display: inline-block;">Nicht bezahlt</a>
    </td>
  </tr>
</table>
<p style="font-size: 13px; color: #666;">Bei „Nicht bezahlt" oder „Teilweise bezahlt" wird automatisch die Zahlungserinnerung an den Kunden gesendet{{#if late_fee_due}} inklusive Mahngebühr von {{late_fee_amount}}{{/if}}.</p>`,
      body_text: `Zahlung prüfen

Rechnung {{invoice_number}} für {{customer_name}}{{#if event_name}} ({{event_name}}){{/if}} war am {{due_date}} fällig. Gesamtbetrag: {{total_amount}}.

Bitte bestätigen:
  Vollständig bezahlt:            {{paid_url}}{{#if has_skonto}}
  Mit Skonto bezahlt ({{skonto_amount}}): {{skonto_url}}{{/if}}
  Teilweise:                      {{partial_url}}
  Nicht bezahlt:                  {{unpaid_url}}

Bei „Nicht bezahlt" oder „Teilweise bezahlt" wird automatisch die Zahlungserinnerung gesendet{{#if late_fee_due}} inklusive Mahngebühr von {{late_fee_amount}}{{/if}}.`,
    },
  },
  storno_issued: {
    category: 'billing', feature_flag: 'bills',
    variables: ['storno_number', 'original_invoice_number', 'original_issue_date', 'customer_name', 'total_amount'],
    en: {
      subject: 'Cancellation invoice {{storno_number}} for invoice {{original_invoice_number}}',
      body_html: `<p>Dear {{customer_name}},</p>
<p>Please find attached cancellation invoice <strong>{{storno_number}}</strong>, which formally reverses invoice <strong>{{original_invoice_number}}</strong> dated {{original_issue_date}} for {{total_amount}}.</p>
<p>The original invoice is no longer payable. Please retain the attached PDF for your records and disregard any prior reminders.</p>`,
      body_text: 'Cancellation invoice {{storno_number}} formally reverses invoice {{original_invoice_number}} dated {{original_issue_date}} for {{total_amount}}. The original invoice is no longer payable. PDF attached.',
    },
    de: {
      subject: 'Stornorechnung {{storno_number}} zu Rechnung {{original_invoice_number}}',
      body_html: `<p>Sehr geehrte/r {{customer_name}},</p>
<p>anbei erhalten Sie die Stornorechnung <strong>{{storno_number}}</strong>, mit der die Rechnung <strong>{{original_invoice_number}}</strong> vom {{original_issue_date}} über {{total_amount}} förmlich aufgehoben wird.</p>
<p>Die ursprüngliche Rechnung ist damit nicht mehr zu begleichen. Bitte bewahren Sie die beigefügte PDF für Ihre Unterlagen auf — etwaige vorherige Mahnungen sind hinfällig.</p>`,
      body_text: 'Stornorechnung {{storno_number}} hebt Rechnung {{original_invoice_number}} vom {{original_issue_date}} über {{total_amount}} förmlich auf. Die ursprüngliche Rechnung ist nicht mehr zu begleichen. PDF im Anhang.',
    },
  },
  invoice_paid_admin_notification: {
    category: 'billing', feature_flag: 'bills',
    variables: ['invoice_number', 'customer_name', 'event_name', 'total_amount', 'paid_amount', 'paid_at', 'payment_method', 'payment_reference', 'skonto_applied', 'skonto_percent', 'skonto_discount_amount'],
    en: {
      subject: 'Payment received: invoice {{invoice_number}}',
      body_html: `<h2>Payment recorded</h2>
<p>Invoice <strong>{{invoice_number}}</strong> for <strong>{{customer_name}}</strong>{{#if event_name}} ({{event_name}}){{/if}} has been marked as fully paid.</p>
<table role="presentation" cellpadding="6" cellspacing="0" border="0" style="border-collapse: collapse; margin: 16px 0;">
  <tr><td style="color: #666;">Total invoice amount</td><td><strong>{{total_amount}}</strong></td></tr>
  <tr><td style="color: #666;">Paid total</td><td><strong>{{paid_amount}}</strong></td></tr>
  {{#if skonto_applied}}<tr><td style="color: #0d9488;">Paid with Skonto ({{skonto_percent}}%)</td><td style="color: #0d9488;"><strong>−{{skonto_discount_amount}}</strong></td></tr>{{/if}}
  {{#if payment_method}}<tr><td style="color: #666;">Payment method</td><td>{{payment_method}}</td></tr>{{/if}}
  {{#if payment_reference}}<tr><td style="color: #666;">Reference</td><td>{{payment_reference}}</td></tr>{{/if}}
  <tr><td style="color: #666;">Recorded at</td><td>{{paid_at}}</td></tr>
</table>
<p style="font-size: 13px; color: #666;">This is an automatic notification — no action required.</p>`,
      body_text: `Payment recorded

Invoice {{invoice_number}} for {{customer_name}}{{#if event_name}} ({{event_name}}){{/if}} has been marked as fully paid.

  Total invoice amount:    {{total_amount}}
  Paid total:              {{paid_amount}}{{#if skonto_applied}}
  Paid with Skonto ({{skonto_percent}}%): -{{skonto_discount_amount}}{{/if}}{{#if payment_method}}
  Payment method:          {{payment_method}}{{/if}}{{#if payment_reference}}
  Reference:               {{payment_reference}}{{/if}}
  Recorded at:             {{paid_at}}

This is an automatic notification — no action required.`,
    },
    de: {
      subject: 'Zahlung erhalten: Rechnung {{invoice_number}}',
      body_html: `<h2>Zahlung erfasst</h2>
<p>Rechnung <strong>{{invoice_number}}</strong> für <strong>{{customer_name}}</strong>{{#if event_name}} ({{event_name}}){{/if}} wurde als vollständig bezahlt markiert.</p>
<table role="presentation" cellpadding="6" cellspacing="0" border="0" style="border-collapse: collapse; margin: 16px 0;">
  <tr><td style="color: #666;">Rechnungsbetrag</td><td><strong>{{total_amount}}</strong></td></tr>
  <tr><td style="color: #666;">Eingezahlt</td><td><strong>{{paid_amount}}</strong></td></tr>
  {{#if skonto_applied}}<tr><td style="color: #0d9488;">Mit Skonto bezahlt ({{skonto_percent}}%)</td><td style="color: #0d9488;"><strong>−{{skonto_discount_amount}}</strong></td></tr>{{/if}}
  {{#if payment_method}}<tr><td style="color: #666;">Zahlungsart</td><td>{{payment_method}}</td></tr>{{/if}}
  {{#if payment_reference}}<tr><td style="color: #666;">Referenz</td><td>{{payment_reference}}</td></tr>{{/if}}
  <tr><td style="color: #666;">Erfasst am</td><td>{{paid_at}}</td></tr>
</table>
<p style="font-size: 13px; color: #666;">Automatische Benachrichtigung — keine Aktion erforderlich.</p>`,
      body_text: `Zahlung erfasst

Rechnung {{invoice_number}} für {{customer_name}}{{#if event_name}} ({{event_name}}){{/if}} wurde als vollständig bezahlt markiert.

  Rechnungsbetrag:         {{total_amount}}
  Eingezahlt:              {{paid_amount}}{{#if skonto_applied}}
  Mit Skonto bezahlt ({{skonto_percent}}%): -{{skonto_discount_amount}}{{/if}}{{#if payment_method}}
  Zahlungsart:             {{payment_method}}{{/if}}{{#if payment_reference}}
  Referenz:                {{payment_reference}}{{/if}}
  Erfasst am:              {{paid_at}}

Automatische Benachrichtigung — keine Aktion erforderlich.`,
    },
  },
  invoice_collections_handoff: {
    category: 'billing', feature_flag: 'bills',
    variables: ['invoice_number', 'customer_name', 'customer_email', 'customer_address', 'event_name', 'original_amount', 'late_fee_amount', 'paid_amount', 'outstanding_amount', 'due_date', 'reminder_level'],
    en: {
      subject: 'Collections handoff: invoice {{invoice_number}} still unpaid after dunning',
      body_html: `<h2>Ready to hand to collections</h2>
<p>Invoice <strong>{{invoice_number}}</strong>{{#if event_name}} ({{event_name}}){{/if}} is still unpaid after {{reminder_level}} reminders. The invoice PDF is attached for forwarding.</p>
<table role="presentation" cellpadding="6" cellspacing="0" border="0" style="border-collapse: collapse; margin: 16px 0;">
  <tr><td style="color:#666;">Customer</td><td><strong>{{customer_name}}</strong></td></tr>
  {{#if customer_email}}<tr><td style="color:#666;">Email</td><td>{{customer_email}}</td></tr>{{/if}}
  {{#if customer_address}}<tr><td style="color:#666;">Address</td><td>{{customer_address}}</td></tr>{{/if}}
  <tr><td style="color:#666;">Due date</td><td>{{due_date}}</td></tr>
  <tr><td style="color:#666;">Original amount</td><td>{{original_amount}}</td></tr>
  {{#if late_fee_amount}}<tr><td style="color:#666;">Late fees</td><td>{{late_fee_amount}}</td></tr>{{/if}}
  <tr><td style="color:#666;">Paid</td><td>{{paid_amount}}</td></tr>
  <tr><td style="color:#666;"><strong>Outstanding</strong></td><td><strong>{{outstanding_amount}}</strong></td></tr>
</table>
<p style="font-size:13px;color:#666;">Forward to your collections agency / for Betreibung. Automatic notification.</p>`,
      body_text: `Ready to hand to collections

Invoice {{invoice_number}}{{#if event_name}} ({{event_name}}){{/if}} is still unpaid after {{reminder_level}} reminders. The invoice PDF is attached.

  Customer:        {{customer_name}}{{#if customer_email}}
  Email:           {{customer_email}}{{/if}}{{#if customer_address}}
  Address:         {{customer_address}}{{/if}}
  Due date:        {{due_date}}
  Original amount: {{original_amount}}{{#if late_fee_amount}}
  Late fees:       {{late_fee_amount}}{{/if}}
  Paid:            {{paid_amount}}
  Outstanding:     {{outstanding_amount}}

Forward to your collections agency / for Betreibung.`,
    },
    de: {
      subject: 'Inkasso-Übergabe: Rechnung {{invoice_number}} trotz Mahnungen offen',
      body_html: `<h2>Bereit zur Inkasso-Übergabe</h2>
<p>Rechnung <strong>{{invoice_number}}</strong>{{#if event_name}} ({{event_name}}){{/if}} ist nach {{reminder_level}} Mahnungen weiterhin offen. Das Rechnungs-PDF ist zur Weiterleitung angehängt.</p>
<table role="presentation" cellpadding="6" cellspacing="0" border="0" style="border-collapse: collapse; margin: 16px 0;">
  <tr><td style="color:#666;">Kunde</td><td><strong>{{customer_name}}</strong></td></tr>
  {{#if customer_email}}<tr><td style="color:#666;">E-Mail</td><td>{{customer_email}}</td></tr>{{/if}}
  {{#if customer_address}}<tr><td style="color:#666;">Adresse</td><td>{{customer_address}}</td></tr>{{/if}}
  <tr><td style="color:#666;">Fälligkeit</td><td>{{due_date}}</td></tr>
  <tr><td style="color:#666;">Rechnungsbetrag</td><td>{{original_amount}}</td></tr>
  {{#if late_fee_amount}}<tr><td style="color:#666;">Mahngebühren</td><td>{{late_fee_amount}}</td></tr>{{/if}}
  <tr><td style="color:#666;">Bezahlt</td><td>{{paid_amount}}</td></tr>
  <tr><td style="color:#666;"><strong>Offen</strong></td><td><strong>{{outstanding_amount}}</strong></td></tr>
</table>
<p style="font-size:13px;color:#666;">Zur Weiterleitung an das Inkasso / für die Betreibung. Automatische Benachrichtigung.</p>`,
      body_text: `Bereit zur Inkasso-Übergabe

Rechnung {{invoice_number}}{{#if event_name}} ({{event_name}}){{/if}} ist nach {{reminder_level}} Mahnungen weiterhin offen. Das Rechnungs-PDF ist angehängt.

  Kunde:           {{customer_name}}{{#if customer_email}}
  E-Mail:          {{customer_email}}{{/if}}{{#if customer_address}}
  Adresse:         {{customer_address}}{{/if}}
  Fälligkeit:      {{due_date}}
  Rechnungsbetrag: {{original_amount}}{{#if late_fee_amount}}
  Mahngebühren:    {{late_fee_amount}}{{/if}}
  Bezahlt:         {{paid_amount}}
  Offen:           {{outstanding_amount}}

Zur Weiterleitung an das Inkasso / für die Betreibung.`,
    },
  },
};

let _seeded = false;

/**
 * Insert any missing CRM email templates into email_templates +
 * email_template_translations. Idempotent: existing template_keys are
 * left alone so admin customisations are never clobbered.
 *
 * Returns the list of templateKeys newly inserted (for logging).
 */
async function ensureCrmEmailTemplatesSeeded(db, logger) {
  if (_seeded) return [];
  if (!(await db.schema.hasTable('email_templates'))) return [];

  const cols = await db('email_templates').columnInfo();
  const hasTranslationsTable = await db.schema.hasTable('email_template_translations');
  const newlyInserted = [];

  for (const [templateKey, def] of Object.entries(CRM_EMAIL_TEMPLATES)) {
    const existing = await db('email_templates').where({ template_key: templateKey }).first();
    if (existing) continue;

    const enContent = def.en;
    const masterRow = {
      template_key: templateKey,
      variables: JSON.stringify(def.variables),
    };
    if ('category' in cols)     masterRow.category = def.category;
    if ('subcategory' in cols)  masterRow.subcategory = null;
    if ('feature_flag' in cols) masterRow.feature_flag = def.feature_flag;
    if ('created_at' in cols)   masterRow.created_at = new Date();
    if ('updated_at' in cols)   masterRow.updated_at = new Date();

    // Fill legacy subject_<lang> / body_html_<lang> / body_text_<lang>
    // columns when present (the modern translations table is populated
    // below regardless).
    for (const colName of Object.keys(cols)) {
      if (colName === 'subject' || /^subject_[a-z]{2,3}$/i.test(colName)) {
        masterRow[colName] = enContent.subject;
      } else if (colName === 'body_html' || /^body_html_[a-z]{2,3}$/i.test(colName)) {
        masterRow[colName] = enContent.body_html;
      } else if (colName === 'body_text' || /^body_text_[a-z]{2,3}$/i.test(colName)) {
        masterRow[colName] = enContent.body_text;
      }
    }

    try {
      const inserted = await db('email_templates').insert(masterRow).returning('id');
      const templateId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];
      if (hasTranslationsTable && templateId) {
        for (const lang of ['en', 'de']) {
          const content = def[lang];
          if (!content) continue;
          await db('email_template_translations').insert({
            template_id: templateId,
            language: lang,
            subject: content.subject,
            body_html: content.body_html,
            body_text: content.body_text,
            created_at: new Date(),
            updated_at: new Date(),
          });
        }
      }
      newlyInserted.push(templateKey);
      if (logger) {
        logger.info(`Self-healed missing CRM email template at runtime: ${templateKey}`);
      }
    } catch (err) {
      // Keep _seeded=false so the next call retries. Don't throw —
      // caller surfaces its own error if the template still can't be
      // looked up.
      if (logger) {
        logger.error(`Failed to seed CRM email template ${templateKey}`, {
          message: err.message,
        });
      }
      return newlyInserted;
    }
  }

  _seeded = true;
  return newlyInserted;
}

module.exports = {
  CRM_EMAIL_TEMPLATES,
  ensureCrmEmailTemplatesSeeded,
};
