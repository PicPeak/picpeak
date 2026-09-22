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
      'valid_until', 'event_name', 'total_amount', 'has_add_ons'],
    en: {
      subject: 'Your quote {{quote_number}} is ready',
      body_html: `<h2>Quote {{quote_number}}</h2>
<p>Dear {{customer_name}},</p>
<p>Please find the attached quote {{quote_number}}{{#if event_name}} for "{{event_name}}"{{/if}}. Total amount: <strong>{{total_amount}}</strong>.</p>
{{#if has_add_ons}}<p>This quote has optional add-ons. Choose them online before you accept.</p>{{/if}}
<p>You can accept or decline this quote directly via the buttons below:</p>
<p style="text-align: center; margin: 30px 0;">
  <a href="{{accept_url}}" class="button">Accept quote</a>
  &nbsp;
  <a href="{{decline_url}}" style="display:inline-block;padding:10px 20px;color:#666;text-decoration:underline;">Decline</a>
</p>
<p>Or open the full quote in your browser:<br>
<span style="word-break: break-all; font-size: 13px;">{{response_url}}</span></p>
{{#if valid_until}}<p style="font-size: 13px; color: #666;">This quote is valid until {{valid_until}}.</p>{{/if}}`,
      body_text: 'Quote {{quote_number}}\n\nDear {{customer_name}},\n\nPlease find the attached quote {{quote_number}}. Total: {{total_amount}}.\n\n{{#if has_add_ons}}This quote has optional add-ons. Choose them online before you accept.\n\n{{/if}}Respond: {{response_url}}\nAccept: {{accept_url}}\nDecline: {{decline_url}}\n\n{{#if valid_until}}Valid until {{valid_until}}.{{/if}}',
    },
    de: {
      subject: 'Ihr Angebot {{quote_number}} ist bereit',
      body_html: `<h2>Angebot {{quote_number}}</h2>
<p>Sehr geehrte/r {{customer_name}},</p>
<p>im Anhang finden Sie das Angebot {{quote_number}}{{#if event_name}} für "{{event_name}}"{{/if}}. Gesamtbetrag: <strong>{{total_amount}}</strong>.</p>
{{#if has_add_ons}}<p>Dieses Angebot enthält optionale Zusatzleistungen. Wählen Sie sie online aus, bevor Sie annehmen.</p>{{/if}}
<p>Sie können das Angebot direkt über die Schaltflächen unten annehmen oder ablehnen:</p>
<p style="text-align: center; margin: 30px 0;">
  <a href="{{accept_url}}" class="button">Angebot annehmen</a>
  &nbsp;
  <a href="{{decline_url}}" style="display:inline-block;padding:10px 20px;color:#666;text-decoration:underline;">Ablehnen</a>
</p>
<p>Oder öffnen Sie das vollständige Angebot im Browser:<br>
<span style="word-break: break-all; font-size: 13px;">{{response_url}}</span></p>
{{#if valid_until}}<p style="font-size: 13px; color: #666;">Dieses Angebot ist gültig bis {{valid_until}}.</p>{{/if}}`,
      body_text: 'Angebot {{quote_number}}\n\nSehr geehrte/r {{customer_name}},\n\nim Anhang finden Sie das Angebot {{quote_number}}. Gesamtbetrag: {{total_amount}}.\n\n{{#if has_add_ons}}Dieses Angebot enthält optionale Zusatzleistungen. Wählen Sie sie online aus, bevor Sie annehmen.\n\n{{/if}}Ansehen: {{response_url}}\nAnnehmen: {{accept_url}}\nAblehnen: {{decline_url}}\n\n{{#if valid_until}}Gültig bis {{valid_until}}.{{/if}}',
    },
  },
  quote_accepted_admin: {
    category: 'quotes', feature_flag: 'quotes',
    variables: ['quote_number', 'customer_email', 'event_name', 'total_amount', 'admin_dashboard_url',
      'booked_add_ons', 'customer_message'],
    en: {
      subject: 'Quote {{quote_number}} accepted by {{customer_email}}',
      body_html: `<h2>Quote accepted</h2><p>{{customer_email}} just accepted quote <strong>{{quote_number}}</strong>{{#if event_name}} for "{{event_name}}"{{/if}}. Total: {{total_amount}}.</p>
{{#if booked_add_ons}}<p>Booked add-ons: {{booked_add_ons}}</p>{{/if}}
{{#if customer_message}}<p><strong>Message from the customer:</strong><br>{{customer_message}}</p>{{/if}}
<p style="text-align: center; margin: 30px 0;"><a href="{{admin_dashboard_url}}" class="button">Open in admin</a></p>`,
      body_text: 'Quote {{quote_number}} accepted by {{customer_email}}.{{#if booked_add_ons}} Booked add-ons: {{booked_add_ons}}.{{/if}}{{#if customer_message}} Message: {{customer_message}}{{/if}} Open: {{admin_dashboard_url}}',
    },
    de: {
      subject: 'Angebot {{quote_number}} von {{customer_email}} angenommen',
      body_html: `<h2>Angebot angenommen</h2><p>{{customer_email}} hat soeben das Angebot <strong>{{quote_number}}</strong>{{#if event_name}} für "{{event_name}}"{{/if}} angenommen. Gesamtbetrag: {{total_amount}}.</p>
{{#if booked_add_ons}}<p>Gebuchte Zusatzleistungen: {{booked_add_ons}}</p>{{/if}}
{{#if customer_message}}<p><strong>Nachricht des Kunden:</strong><br>{{customer_message}}</p>{{/if}}
<p style="text-align: center; margin: 30px 0;"><a href="{{admin_dashboard_url}}" class="button">Im Admin-Bereich öffnen</a></p>`,
      body_text: 'Angebot {{quote_number}} von {{customer_email}} angenommen.{{#if booked_add_ons}} Gebuchte Zusatzleistungen: {{booked_add_ons}}.{{/if}}{{#if customer_message}} Nachricht: {{customer_message}}{{/if}} Öffnen: {{admin_dashboard_url}}',
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
  // #1451: sent to the customer whenever the business changes the add-ons of
  // an accepted quote; the updated quote PDF is attached.
  quote_addons_updated: {
    category: 'quotes', feature_flag: 'quotes',
    variables: ['quote_number', 'customer_name', 'event_name', 'total_amount', 'booked_list', 'removed_list', 'has_pdf'],
    en: {
      subject: 'Your quote {{quote_number}} has been updated',
      body_html: `<h2>Quote {{quote_number}} updated</h2>
<p>Dear {{customer_name}},</p>
<p>we have updated the add-ons of your accepted quote {{quote_number}}{{#if event_name}} for "{{event_name}}"{{/if}}.</p>
{{#if booked_list}}<p>Now booked: {{booked_list}}</p>{{/if}}
{{#if removed_list}}<p>No longer booked: {{removed_list}}</p>{{/if}}
<p>New total: <strong>{{total_amount}}</strong>.{{#if has_pdf}} The updated quote is attached.{{/if}}</p>`,
      body_text: 'Quote {{quote_number}} updated\n\nDear {{customer_name}},\n\nwe have updated the add-ons of your accepted quote {{quote_number}}.\n{{#if booked_list}}Now booked: {{booked_list}}\n{{/if}}{{#if removed_list}}No longer booked: {{removed_list}}\n{{/if}}\nNew total: {{total_amount}}.{{#if has_pdf}} The updated quote is attached.{{/if}}',
    },
    de: {
      subject: 'Ihr Angebot {{quote_number}} wurde angepasst',
      body_html: `<h2>Angebot {{quote_number}} angepasst</h2>
<p>Sehr geehrte/r {{customer_name}},</p>
<p>wir haben die Zusatzleistungen Ihres angenommenen Angebots {{quote_number}}{{#if event_name}} für "{{event_name}}"{{/if}} angepasst.</p>
{{#if booked_list}}<p>Neu gebucht: {{booked_list}}</p>{{/if}}
{{#if removed_list}}<p>Nicht mehr gebucht: {{removed_list}}</p>{{/if}}
<p>Neuer Gesamtbetrag: <strong>{{total_amount}}</strong>.{{#if has_pdf}} Das angepasste Angebot finden Sie im Anhang.{{/if}}</p>`,
      body_text: 'Angebot {{quote_number}} angepasst\n\nSehr geehrte/r {{customer_name}},\n\nwir haben die Zusatzleistungen Ihres angenommenen Angebots {{quote_number}} angepasst.\n{{#if booked_list}}Neu gebucht: {{booked_list}}\n{{/if}}{{#if removed_list}}Nicht mehr gebucht: {{removed_list}}\n{{/if}}\nNeuer Gesamtbetrag: {{total_amount}}.{{#if has_pdf}} Das angepasste Angebot finden Sie im Anhang.{{/if}}',
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
  invoice_payment_check_action_recorded: {
    // GHSA-wg94-f86h-vq68 hardening: the payment-check link at
    // /payment-check/:token is unauthenticated by design (see
    // publicPaymentCheck.js) — token possession is the only gate.
    // This notifies the admin every time that link is used to write
    // to the invoice ledger, so the no-login convenience stays but an
    // admin always sees the action happen.
    category: 'billing', feature_flag: 'bills',
    variables: ['invoice_number', 'customer_name', 'event_name', 'action', 'has_amount', 'amount', 'ip', 'recorded_at'],
    en: {
      subject: 'Payment-check action recorded: invoice {{invoice_number}}',
      body_html: `<h2>Payment-check link used</h2>
<p>Someone used the unauthenticated payment-check link for invoice <strong>{{invoice_number}}</strong>{{#if customer_name}} ({{customer_name}}){{/if}}{{#if event_name}}, {{event_name}}{{/if}} and recorded: <strong>{{action}}</strong>{{#if has_amount}} ({{amount}}){{/if}}.</p>
<table role="presentation" cellpadding="6" cellspacing="0" border="0" style="border-collapse: collapse; margin: 16px 0;">
  <tr><td style="color: #666;">Action</td><td><strong>{{action}}</strong></td></tr>
  {{#if has_amount}}<tr><td style="color: #666;">Amount</td><td>{{amount}}</td></tr>{{/if}}
  <tr><td style="color: #666;">IP address</td><td>{{ip}}</td></tr>
  <tr><td style="color: #666;">Recorded at</td><td>{{recorded_at}}</td></tr>
</table>
<p style="font-size: 13px; color: #666;">This link requires no login — only the token in the URL. If you don't recognise this action, review the invoice in the admin panel.</p>`,
      body_text: `Payment-check link used

Invoice {{invoice_number}}{{#if customer_name}} ({{customer_name}}){{/if}}{{#if event_name}}, {{event_name}}{{/if}} — recorded: {{action}}{{#if has_amount}} ({{amount}}){{/if}}.

  IP address:   {{ip}}
  Recorded at:  {{recorded_at}}

This link requires no login — only the token in the URL. If you don't recognise this action, review the invoice in the admin panel.`,
    },
    de: {
      subject: 'Zahlungsprüfung ausgelöst: Rechnung {{invoice_number}}',
      body_html: `<h2>Zahlungsprüfungs-Link verwendet</h2>
<p>Der nicht-authentifizierte Zahlungsprüfungs-Link für Rechnung <strong>{{invoice_number}}</strong>{{#if customer_name}} ({{customer_name}}){{/if}}{{#if event_name}}, {{event_name}}{{/if}} wurde verwendet und hat erfasst: <strong>{{action}}</strong>{{#if has_amount}} ({{amount}}){{/if}}.</p>
<table role="presentation" cellpadding="6" cellspacing="0" border="0" style="border-collapse: collapse; margin: 16px 0;">
  <tr><td style="color: #666;">Aktion</td><td><strong>{{action}}</strong></td></tr>
  {{#if has_amount}}<tr><td style="color: #666;">Betrag</td><td>{{amount}}</td></tr>{{/if}}
  <tr><td style="color: #666;">IP-Adresse</td><td>{{ip}}</td></tr>
  <tr><td style="color: #666;">Erfasst am</td><td>{{recorded_at}}</td></tr>
</table>
<p style="font-size: 13px; color: #666;">Dieser Link erfordert kein Login — nur den Token in der URL. Falls Ihnen diese Aktion unbekannt vorkommt, prüfen Sie die Rechnung im Admin-Bereich.</p>`,
      body_text: `Zahlungsprüfungs-Link verwendet

Rechnung {{invoice_number}}{{#if customer_name}} ({{customer_name}}){{/if}}{{#if event_name}}, {{event_name}}{{/if}} — erfasst: {{action}}{{#if has_amount}} ({{amount}}){{/if}}.

  IP-Adresse: {{ip}}
  Erfasst am: {{recorded_at}}

Dieser Link erfordert kein Login — nur den Token in der URL. Falls Ihnen diese Aktion unbekannt vorkommt, prüfen Sie die Rechnung im Admin-Bereich.`,
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
  // Customer documents (#1444, plan slice 3). The links lead to the portal
  // login and from there to the document; no token is ever put in them.
  customer_document_shared: {
    category: 'customers', feature_flag: 'documents',
    variables: ['customer_name', 'business_name', 'document_title', 'event_name', 'document_link', 'dashboard_link'],
    en: {
      subject: 'A new document is waiting for you: {{document_title}}',
      body_html: `<h2>New document</h2>
<p>Dear {{customer_name}},</p>
<p>A document has been shared with you in your customer portal: <strong>{{document_title}}</strong>{{#if event_name}} for "{{event_name}}"{{/if}}.</p>
<p style="text-align: center; margin: 30px 0;"><a href="{{document_link}}" class="button">Open document</a></p>
<p style="font-size: 13px; color: #666;">You will be asked to sign in first. All your documents are in your portal: {{dashboard_link}}</p>
{{#if business_name}}<p>{{business_name}}</p>{{/if}}`,
      body_text: 'Dear {{customer_name}},\n\nA document has been shared with you in your customer portal: {{document_title}}{{#if event_name}} for "{{event_name}}"{{/if}}.\n\nOpen it: {{document_link}}\n(You will be asked to sign in first.)\n\nAll your documents: {{dashboard_link}}{{#if business_name}}\n\n{{business_name}}{{/if}}',
    },
    de: {
      subject: 'Ein neues Dokument wartet auf Sie: {{document_title}}',
      body_html: `<h2>Neues Dokument</h2>
<p>Guten Tag {{customer_name}},</p>
<p>in Ihrem Kundenportal wurde ein Dokument für Sie freigegeben: <strong>{{document_title}}</strong>{{#if event_name}} für "{{event_name}}"{{/if}}.</p>
<p style="text-align: center; margin: 30px 0;"><a href="{{document_link}}" class="button">Dokument öffnen</a></p>
<p style="font-size: 13px; color: #666;">Sie werden zuerst gebeten, sich anzumelden. Alle Ihre Dokumente finden Sie im Portal: {{dashboard_link}}</p>
{{#if business_name}}<p>{{business_name}}</p>{{/if}}`,
      body_text: 'Guten Tag {{customer_name}},\n\nin Ihrem Kundenportal wurde ein Dokument für Sie freigegeben: {{document_title}}{{#if event_name}} für "{{event_name}}"{{/if}}.\n\nÖffnen: {{document_link}}\n(Sie werden zuerst gebeten, sich anzumelden.)\n\nAlle Ihre Dokumente: {{dashboard_link}}{{#if business_name}}\n\n{{business_name}}{{/if}}',
    },
  },
  customer_document_uploaded_admin: {
    category: 'customers', feature_flag: 'documents',
    variables: ['customer_name', 'document_title', 'admin_link'],
    en: {
      subject: '{{customer_name}} uploaded a document: {{document_title}}',
      body_html: `<h2>New customer upload</h2>
<p>{{customer_name}} uploaded <strong>{{document_title}}</strong> in the customer portal. It stays unavailable to them until it has been reviewed.</p>
<p style="text-align: center; margin: 30px 0;"><a href="{{admin_link}}" class="button">Review in admin</a></p>`,
      body_text: '{{customer_name}} uploaded {{document_title}} in the customer portal. It stays unavailable to them until it has been reviewed.\n\nReview: {{admin_link}}',
    },
    de: {
      subject: '{{customer_name}} hat ein Dokument hochgeladen: {{document_title}}',
      body_html: `<h2>Neuer Kunden-Upload</h2>
<p>{{customer_name}} hat im Kundenportal <strong>{{document_title}}</strong> hochgeladen. Das Dokument bleibt für den Kunden gesperrt, bis es geprüft wurde.</p>
<p style="text-align: center; margin: 30px 0;"><a href="{{admin_link}}" class="button">Im Admin-Bereich prüfen</a></p>`,
      body_text: '{{customer_name}} hat im Kundenportal {{document_title}} hochgeladen. Das Dokument bleibt für den Kunden gesperrt, bis es geprüft wurde.\n\nPrüfen: {{admin_link}}',
    },
  },
  customer_document_reviewed: {
    category: 'customers', feature_flag: 'documents',
    variables: ['customer_name', 'business_name', 'document_title', 'review_note', 'document_link'],
    en: {
      subject: 'Your document was not accepted: {{document_title}}',
      body_html: `<h2>Document not accepted</h2>
<p>Dear {{customer_name}},</p>
<p>The document you uploaded, <strong>{{document_title}}</strong>, was not accepted.</p>
{{#if review_note}}<p><strong>Reason:</strong> {{review_note}}</p>{{/if}}
<p>You can upload a corrected version in your customer portal.</p>
<p style="text-align: center; margin: 30px 0;"><a href="{{document_link}}" class="button">Open document</a></p>
{{#if business_name}}<p>{{business_name}}</p>{{/if}}`,
      body_text: 'Dear {{customer_name}},\n\nThe document you uploaded, {{document_title}}, was not accepted.{{#if review_note}}\nReason: {{review_note}}{{/if}}\n\nYou can upload a corrected version in your customer portal: {{document_link}}{{#if business_name}}\n\n{{business_name}}{{/if}}',
    },
    de: {
      subject: 'Ihr Dokument wurde nicht angenommen: {{document_title}}',
      body_html: `<h2>Dokument nicht angenommen</h2>
<p>Guten Tag {{customer_name}},</p>
<p>das von Ihnen hochgeladene Dokument <strong>{{document_title}}</strong> wurde nicht angenommen.</p>
{{#if review_note}}<p><strong>Begründung:</strong> {{review_note}}</p>{{/if}}
<p>Sie können in Ihrem Kundenportal eine korrigierte Fassung hochladen.</p>
<p style="text-align: center; margin: 30px 0;"><a href="{{document_link}}" class="button">Dokument öffnen</a></p>
{{#if business_name}}<p>{{business_name}}</p>{{/if}}`,
      body_text: 'Guten Tag {{customer_name}},\n\ndas von Ihnen hochgeladene Dokument {{document_title}} wurde nicht angenommen.{{#if review_note}}\nBegründung: {{review_note}}{{/if}}\n\nSie können in Ihrem Kundenportal eine korrigierte Fassung hochladen: {{document_link}}{{#if business_name}}\n\n{{business_name}}{{/if}}',
    },
  },
  customer_document_access_alert_admin: {
    category: 'customers', feature_flag: 'documents',
    variables: ['customer_name', 'attempt_count', 'admin_link'],
    en: {
      subject: 'Repeated access to other customers\' documents: {{customer_name}}',
      body_html: `<h2>Unusual document access</h2>
<p>Within the last hour, {{customer_name}} asked the portal for {{attempt_count}} documents that belong to other customers. Every one of them was refused.</p>
<p>This can be a stale link, but it is also what trying out document numbers looks like. You can deactivate the account from the customer record if it continues.</p>
<p style="text-align: center; margin: 30px 0;"><a href="{{admin_link}}" class="button">Open the customer record</a></p>`,
      body_text: 'Within the last hour, {{customer_name}} asked the portal for {{attempt_count}} documents that belong to other customers. Every one of them was refused.\n\nThis can be a stale link, but it is also what trying out document numbers looks like. You can deactivate the account from the customer record if it continues.\n\n{{admin_link}}',
    },
    de: {
      subject: 'Wiederholte Zugriffe auf fremde Dokumente: {{customer_name}}',
      body_html: `<h2>Ungewöhnliche Dokumentzugriffe</h2>
<p>{{customer_name}} hat in der letzten Stunde im Portal {{attempt_count}} Dokumente angefordert, die anderen Kunden gehören. Alle Zugriffe wurden abgewiesen.</p>
<p>Das kann ein veralteter Link sein, sieht aber auch so aus, als würden Dokumentnummern ausprobiert. Falls es weitergeht, können Sie das Konto im Kundendatensatz deaktivieren.</p>
<p style="text-align: center; margin: 30px 0;"><a href="{{admin_link}}" class="button">Kundendatensatz öffnen</a></p>`,
      body_text: '{{customer_name}} hat in der letzten Stunde im Portal {{attempt_count}} Dokumente angefordert, die anderen Kunden gehören. Alle Zugriffe wurden abgewiesen.\n\nDas kann ein veralteter Link sein, sieht aber auch so aus, als würden Dokumentnummern ausprobiert. Falls es weitergeht, können Sie das Konto im Kundendatensatz deaktivieren.\n\n{{admin_link}}',
    },
  },
  customer_document_requested: {
    category: 'customers', feature_flag: 'documents',
    variables: ['customer_name', 'business_name', 'request_title', 'request_note', 'due_date', 'upload_link'],
    en: {
      subject: 'Please send us a document: {{request_title}}',
      body_html: `<h2>A document is needed</h2>
<p>Dear {{customer_name}},</p>
<p>Please upload the following document in your customer portal: <strong>{{request_title}}</strong>.</p>
{{#if request_note}}<p>{{request_note}}</p>{{/if}}
{{#if due_date}}<p>Please send it by {{due_date}}.</p>{{/if}}
<p style="text-align: center; margin: 30px 0;"><a href="{{upload_link}}" class="button">Upload the document</a></p>
<p style="font-size: 13px; color: #666;">You will be asked to sign in first.</p>
{{#if business_name}}<p>{{business_name}}</p>{{/if}}`,
      body_text: 'Dear {{customer_name}},\n\nPlease upload the following document in your customer portal: {{request_title}}.{{#if request_note}}\n\n{{request_note}}{{/if}}{{#if due_date}}\n\nPlease send it by {{due_date}}.{{/if}}\n\nUpload: {{upload_link}}\n(You will be asked to sign in first.){{#if business_name}}\n\n{{business_name}}{{/if}}',
    },
    de: {
      subject: 'Bitte senden Sie uns ein Dokument: {{request_title}}',
      body_html: `<h2>Ein Dokument wird benötigt</h2>
<p>Guten Tag {{customer_name}},</p>
<p>bitte laden Sie das folgende Dokument in Ihrem Kundenportal hoch: <strong>{{request_title}}</strong>.</p>
{{#if request_note}}<p>{{request_note}}</p>{{/if}}
{{#if due_date}}<p>Bitte senden Sie es bis {{due_date}}.</p>{{/if}}
<p style="text-align: center; margin: 30px 0;"><a href="{{upload_link}}" class="button">Dokument hochladen</a></p>
<p style="font-size: 13px; color: #666;">Sie werden zuerst gebeten, sich anzumelden.</p>
{{#if business_name}}<p>{{business_name}}</p>{{/if}}`,
      body_text: 'Guten Tag {{customer_name}},\n\nbitte laden Sie das folgende Dokument in Ihrem Kundenportal hoch: {{request_title}}.{{#if request_note}}\n\n{{request_note}}{{/if}}{{#if due_date}}\n\nBitte senden Sie es bis {{due_date}}.{{/if}}\n\nHochladen: {{upload_link}}\n(Sie werden zuerst gebeten, sich anzumelden.){{#if business_name}}\n\n{{business_name}}{{/if}}',
    },
  },
  customer_document_request_reminder: {
    category: 'customers', feature_flag: 'documents',
    variables: ['customer_name', 'business_name', 'request_title', 'request_note', 'due_date', 'upload_link'],
    en: {
      subject: 'Reminder: {{request_title}}',
      body_html: `<h2>Still needed</h2>
<p>Dear {{customer_name}},</p>
<p>We are still waiting for <strong>{{request_title}}</strong>. Please upload it in your customer portal.</p>
{{#if request_note}}<p>{{request_note}}</p>{{/if}}
{{#if due_date}}<p>Please send it by {{due_date}}.</p>{{/if}}
<p style="text-align: center; margin: 30px 0;"><a href="{{upload_link}}" class="button">Upload the document</a></p>
<p style="font-size: 13px; color: #666;">If you have already sent it, you can ignore this reminder.</p>
{{#if business_name}}<p>{{business_name}}</p>{{/if}}`,
      body_text: 'Dear {{customer_name}},\n\nWe are still waiting for {{request_title}}. Please upload it in your customer portal.{{#if request_note}}\n\n{{request_note}}{{/if}}{{#if due_date}}\n\nPlease send it by {{due_date}}.{{/if}}\n\nUpload: {{upload_link}}\n\nIf you have already sent it, you can ignore this reminder.{{#if business_name}}\n\n{{business_name}}{{/if}}',
    },
    de: {
      subject: 'Erinnerung: {{request_title}}',
      body_html: `<h2>Noch ausstehend</h2>
<p>Guten Tag {{customer_name}},</p>
<p>wir warten noch auf <strong>{{request_title}}</strong>. Bitte laden Sie das Dokument in Ihrem Kundenportal hoch.</p>
{{#if request_note}}<p>{{request_note}}</p>{{/if}}
{{#if due_date}}<p>Bitte senden Sie es bis {{due_date}}.</p>{{/if}}
<p style="text-align: center; margin: 30px 0;"><a href="{{upload_link}}" class="button">Dokument hochladen</a></p>
<p style="font-size: 13px; color: #666;">Falls Sie es bereits gesendet haben, können Sie diese Erinnerung ignorieren.</p>
{{#if business_name}}<p>{{business_name}}</p>{{/if}}`,
      body_text: 'Guten Tag {{customer_name}},\n\nwir warten noch auf {{request_title}}. Bitte laden Sie das Dokument in Ihrem Kundenportal hoch.{{#if request_note}}\n\n{{request_note}}{{/if}}{{#if due_date}}\n\nBitte senden Sie es bis {{due_date}}.{{/if}}\n\nHochladen: {{upload_link}}\n\nFalls Sie es bereits gesendet haben, können Sie diese Erinnerung ignorieren.{{#if business_name}}\n\n{{business_name}}{{/if}}',
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
// Defaults whose text changed (#1451). A stored template still identical to
// its previous default is brought up to date; one an admin has edited is left
// as it is (the new variables are available to add).
const PREVIOUS_DEFAULTS = {
  // The attachment sentence was unconditional; an install that stored the
  // first version gets the conditional one as long as nobody edited it.
  'quote_addons_updated': {
    'en': {
      'subject': 'Your quote {{quote_number}} has been updated',
      'body_html': `<h2>Quote {{quote_number}} updated</h2>
<p>Dear {{customer_name}},</p>
<p>we have updated the add-ons of your accepted quote {{quote_number}}{{#if event_name}} for "{{event_name}}"{{/if}}.</p>
{{#if booked_list}}<p>Now booked: {{booked_list}}</p>{{/if}}
{{#if removed_list}}<p>No longer booked: {{removed_list}}</p>{{/if}}
<p>New total: <strong>{{total_amount}}</strong>. The updated quote is attached.</p>`,
      'body_text': 'Quote {{quote_number}} updated\n\nDear {{customer_name}},\n\nwe have updated the add-ons of your accepted quote {{quote_number}}.\n{{#if booked_list}}Now booked: {{booked_list}}\n{{/if}}{{#if removed_list}}No longer booked: {{removed_list}}\n{{/if}}\nNew total: {{total_amount}}. The updated quote is attached.'
    },
    'de': {
      'subject': 'Ihr Angebot {{quote_number}} wurde angepasst',
      'body_html': `<h2>Angebot {{quote_number}} angepasst</h2>
<p>Sehr geehrte/r {{customer_name}},</p>
<p>wir haben die Zusatzleistungen Ihres angenommenen Angebots {{quote_number}}{{#if event_name}} für "{{event_name}}"{{/if}} angepasst.</p>
{{#if booked_list}}<p>Neu gebucht: {{booked_list}}</p>{{/if}}
{{#if removed_list}}<p>Nicht mehr gebucht: {{removed_list}}</p>{{/if}}
<p>Neuer Gesamtbetrag: <strong>{{total_amount}}</strong>. Das angepasste Angebot finden Sie im Anhang.</p>`,
      'body_text': 'Angebot {{quote_number}} angepasst\n\nSehr geehrte/r {{customer_name}},\n\nwir haben die Zusatzleistungen Ihres angenommenen Angebots {{quote_number}} angepasst.\n{{#if booked_list}}Neu gebucht: {{booked_list}}\n{{/if}}{{#if removed_list}}Nicht mehr gebucht: {{removed_list}}\n{{/if}}\nNeuer Gesamtbetrag: {{total_amount}}. Das angepasste Angebot finden Sie im Anhang.'
    }
  },
  'quote_sent': {
    'en': {
      'subject': 'Your quote {{quote_number}} is ready',
      'body_html': '<h2>Quote {{quote_number}}</h2>\n<p>Dear {{customer_name}},</p>\n<p>Please find the attached quote {{quote_number}}{{#if event_name}} for "{{event_name}}"{{/if}}. Total amount: <strong>{{total_amount}}</strong>.</p>\n<p>You can accept or decline this quote directly via the buttons below:</p>\n<p style="text-align: center; margin: 30px 0;">\n  <a href="{{accept_url}}" class="button">Accept quote</a>\n  &nbsp;\n  <a href="{{decline_url}}" style="display:inline-block;padding:10px 20px;color:#666;text-decoration:underline;">Decline</a>\n</p>\n<p>Or open the full quote in your browser:<br>\n<span style="word-break: break-all; font-size: 13px;">{{response_url}}</span></p>\n{{#if valid_until}}<p style="font-size: 13px; color: #666;">This quote is valid until {{valid_until}}.</p>{{/if}}',
      'body_text': 'Quote {{quote_number}}\n\nDear {{customer_name}},\n\nPlease find the attached quote {{quote_number}}. Total: {{total_amount}}.\n\nRespond: {{response_url}}\nAccept: {{accept_url}}\nDecline: {{decline_url}}\n\n{{#if valid_until}}Valid until {{valid_until}}.{{/if}}'
    },
    'de': {
      'subject': 'Ihr Angebot {{quote_number}} ist bereit',
      'body_html': '<h2>Angebot {{quote_number}}</h2>\n<p>Sehr geehrte/r {{customer_name}},</p>\n<p>im Anhang finden Sie das Angebot {{quote_number}}{{#if event_name}} für "{{event_name}}"{{/if}}. Gesamtbetrag: <strong>{{total_amount}}</strong>.</p>\n<p>Sie können das Angebot direkt über die Schaltflächen unten annehmen oder ablehnen:</p>\n<p style="text-align: center; margin: 30px 0;">\n  <a href="{{accept_url}}" class="button">Angebot annehmen</a>\n  &nbsp;\n  <a href="{{decline_url}}" style="display:inline-block;padding:10px 20px;color:#666;text-decoration:underline;">Ablehnen</a>\n</p>\n<p>Oder öffnen Sie das vollständige Angebot im Browser:<br>\n<span style="word-break: break-all; font-size: 13px;">{{response_url}}</span></p>\n{{#if valid_until}}<p style="font-size: 13px; color: #666;">Dieses Angebot ist gültig bis {{valid_until}}.</p>{{/if}}',
      'body_text': 'Angebot {{quote_number}}\n\nSehr geehrte/r {{customer_name}},\n\nim Anhang finden Sie das Angebot {{quote_number}}. Gesamtbetrag: {{total_amount}}.\n\nAnsehen: {{response_url}}\nAnnehmen: {{accept_url}}\nAblehnen: {{decline_url}}\n\n{{#if valid_until}}Gültig bis {{valid_until}}.{{/if}}'
    }
  },
  'quote_accepted_admin': {
    'en': {
      'subject': 'Quote {{quote_number}} accepted by {{customer_email}}',
      'body_html': '<h2>Quote accepted</h2><p>{{customer_email}} just accepted quote <strong>{{quote_number}}</strong>{{#if event_name}} for "{{event_name}}"{{/if}}. Total: {{total_amount}}.</p>\n<p style="text-align: center; margin: 30px 0;"><a href="{{admin_dashboard_url}}" class="button">Open in admin</a></p>',
      'body_text': 'Quote {{quote_number}} accepted by {{customer_email}}. Open: {{admin_dashboard_url}}'
    },
    'de': {
      'subject': 'Angebot {{quote_number}} von {{customer_email}} angenommen',
      'body_html': '<h2>Angebot angenommen</h2><p>{{customer_email}} hat soeben das Angebot <strong>{{quote_number}}</strong>{{#if event_name}} für "{{event_name}}"{{/if}} angenommen. Gesamtbetrag: {{total_amount}}.</p>\n<p style="text-align: center; margin: 30px 0;"><a href="{{admin_dashboard_url}}" class="button">Im Admin-Bereich öffnen</a></p>',
      'body_text': 'Angebot {{quote_number}} von {{customer_email}} angenommen. Öffnen: {{admin_dashboard_url}}'
    }
  }
};

async function upgradeUneditedTemplates(db, cols, hasTranslationsTable, logger) {
  for (const [templateKey, previous] of Object.entries(PREVIOUS_DEFAULTS)) {
    const def = CRM_EMAIL_TEMPLATES[templateKey];
    const row = await db('email_templates').where({ template_key: templateKey }).first();
    if (!row) continue;
    let upgraded = false;
    if (hasTranslationsTable) {
      for (const lang of ['en', 'de']) {
        const old = previous[lang];
        const next = def[lang];
        if (!old || !next) continue;
        const updated = await db('email_template_translations')
          .where({ template_id: row.id, language: lang, subject: old.subject, body_html: old.body_html, body_text: old.body_text })
          .update({ subject: next.subject, body_html: next.body_html, body_text: next.body_text, updated_at: new Date() });
        if (updated) upgraded = true;
      }
    }
    const legacy = {};
    for (const field of ['subject', 'body_html', 'body_text']) {
      for (const colName of Object.keys(cols)) {
        if ((colName === field || colName === `${field}_en`) && row[colName] === previous.en[field]) legacy[colName] = def.en[field];
        if (colName === `${field}_de` && previous.de && row[colName] === previous.de[field]) legacy[colName] = def.de[field];
      }
    }
    if (Object.keys(legacy).length) {
      await db('email_templates').where({ id: row.id }).update(legacy);
      upgraded = true;
    }
    if (upgraded) {
      await db('email_templates').where({ id: row.id }).update({ variables: JSON.stringify(def.variables) });
      if (logger) logger.info(`Updated the unedited default email template: ${templateKey}`);
    }
  }
}

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

  try {
    await upgradeUneditedTemplates(db, cols, hasTranslationsTable, logger);
  } catch (err) {
    if (logger) logger.warn('Could not update the default email templates', { message: err.message });
  }

  _seeded = true;
  return newlyInserted;
}

module.exports = {
  CRM_EMAIL_TEMPLATES,
  PREVIOUS_DEFAULTS,
  ensureCrmEmailTemplatesSeeded,
};
