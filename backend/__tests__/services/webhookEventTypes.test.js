/**
 * The admin UI keeps its own copy of the webhook event catalog: the subscribe
 * checkboxes and the "Send test event" select. A type missing there cannot be
 * subscribed to from the UI.
 */

const fs = require('fs');
const path = require('path');
const { EVENT_TYPES } = require('../../src/services/webhookService');

const frontend = path.resolve(__dirname, '../../../frontend/src');

describe('webhook event catalog', () => {
  it('includes external_scan.completed', () => {
    expect(EVENT_TYPES).toContain('external_scan.completed');
  });

  it.each([
    'features/settings/tabs/WebhooksTab.tsx',
    'pages/admin/WebhookDeliveriesPage.tsx',
  ])('%s lists every event type', (file) => {
    const source = fs.readFileSync(path.join(frontend, file), 'utf8');
    for (const type of EVENT_TYPES) expect(source).toContain(`'${type}'`);
  });
});
