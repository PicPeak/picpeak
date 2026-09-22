/**
 * Hostile placeholder values shared by the per-context escaping tests
 * (#1445): each context must print them as typed, never interpret them.
 */
module.exports = {
  html: '<img src=x onerror=1>',
  bold: '**bold**',
  placeholder: '{{customer_name}}',
  conditional: '{{#if event_name}}shown{{/if}}',
  long: 'N'.repeat(10000),
  rtl: 'شركة الأفق — אופק בע״מ',
  emoji: 'Studio 📸 Anna & Ben 💍',
};
