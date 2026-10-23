/**
 * Simulate a Snipcart order.completed webhook against a LOCAL PicPeak
 * instance.
 *
 * Snipcart's servers cannot reach localhost, so this script replays the exact
 * call they would make — raw JSON body, `x-snipcart-signature` HMAC header —
 * against your running backend. It exercises the full photo-sales chain:
 * signature check, idempotency, photo_purchase_orders / photo_purchases rows
 * and the purchase-access email.
 *
 * Usage (from the repo root, backend running):
 *   node scripts/simulate-snipcart-webhook.js <gallery-slug> <photoId> [photoId...] \
 *     [--email buyer@example.com] [--total 9.5] [--token test-order-1]
 *
 * Env (optional, root .env is read automatically):
 *   SNIPCART_WEBHOOK_SECRET  the same secret as in .env
 *   BACKEND_URL              default http://localhost:3001/api
 *
 * The access link for the created order shows up under
 * Admin -> Event -> Orders (and in the buyer email when SMTP is configured).
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Read the root .env (SNIPCART_WEBHOOK_SECRET) without overwriting existing env.
try {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (match && process.env[match[1]] === undefined) {
        process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
      }
    }
  }
} catch (_) { /* optional */ }

const [slug, ...rest] = process.argv.slice(2);
const photoIds = [];
let email = 'buyer@example.com';
let total = 0;
let orderToken = `test-order-${Date.now()}`;

for (const arg of rest) {
  if (arg.startsWith('--email=')) email = arg.slice('--email='.length);
  else if (arg.startsWith('--total=')) total = Number(arg.slice('--total='.length)) || 0;
  else if (arg.startsWith('--token=')) orderToken = arg.slice('--token='.length);
  else if (!arg.startsWith('--')) photoIds.push(Number(arg));
}

if (!slug || photoIds.length === 0 || photoIds.some((id) => !Number.isFinite(id) || id <= 0)) {
  console.error('Usage: node scripts/simulate-snipcart-webhook.js <gallery-slug> <photoId> [photoId...] [--email=...] [--total=...] [--token=...]');
  process.exit(1);
}

const secret = (process.env.SNIPCART_WEBHOOK_SECRET || '').trim();
if (!secret) {
  console.error('SNIPCART_WEBHOOK_SECRET is not set — put it in your root .env first.');
  process.exit(1);
}

const payload = {
  eventName: 'order.completed',
  mode: 'Test',
  createdOn: new Date().toISOString(),
  content: {
    order: {
      token: orderToken,
      email,
      total,
      currency: 'eur',
      items: photoIds.map((id) => ({
        id: `photo-${id}`,
        name: `Photo ${id}`,
        price: 0,
        quantity: 1,
        customFields: [{ name: 'photoId', value: String(id) }],
      })),
    },
  },
};

const rawBody = JSON.stringify(payload);
const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

const backendUrl = (process.env.BACKEND_URL || 'http://localhost:3001/api').replace(/\/$/, '');
const url = `${backendUrl}/gallery/${encodeURIComponent(slug)}/snipcart-webhook`;

(async () => {
  console.log(`POST ${url}`);
  console.log(`  order token: ${orderToken}`);
  console.log(`  photos:      ${photoIds.join(', ')}`);
  console.log(`  buyer email: ${email}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-snipcart-signature': signature,
    },
    body: rawBody,
  });

  const body = await response.text();
  console.log(`\nHTTP ${response.status}`);
  console.log(body);

  if (response.status === 200) {
    console.log('\nDone. The order is now listed under Admin → Event → Orders,');
    console.log('where you can copy the purchased-downloads access link.');
    console.log('(A buyer email is only delivered when SMTP is configured.)');
  } else {
    console.log('\nCheck the backend logs for details.');
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error('Request failed:', error.message);
  process.exit(1);
});
