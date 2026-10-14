/**
 * Link previews for a renamed gallery's old URL.
 *
 * galleryOgService.resolveSlug honoured slug redirects through a table named
 * `event_slug_redirects`, which no migration creates: the rename writes
 * `slug_redirects` (migration 049). The hasTable guard turned the lookup into
 * a silent no-op, so a crawler fetching /gallery/<old-slug> got the generic
 * site preview instead of the gallery's.
 */
const { bootCrmDb } = require('./helpers/crmDb');

jest.setTimeout(120000);

let db; let cleanup; let buildOgMetadata;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ buildOgMetadata } = require('../../src/services/galleryOgService'));
}, 120000);

afterAll(async () => { if (cleanup) await cleanup(); });

async function seedRenamedEvent() {
  const [e] = await db('events').insert({
    slug: 'wedding-new-name-2026-06-05',
    event_type: 'wedding',
    event_name: 'New Name',
    event_date: '2026-06-05',
    password_hash: 'x',
    expires_at: new Date(Date.now() + 365 * 86400000).toISOString(),
    is_active: true,
    is_archived: false,
    share_link: 'wedding-new-name-2026-06-05',
    share_token: 'c'.repeat(32),
  }).returning('id');
  const eventId = typeof e === 'object' ? e.id : e;
  await db('slug_redirects').insert({
    old_slug: 'wedding-old-name-2026-06-05',
    new_slug: 'wedding-new-name-2026-06-05',
    event_id: eventId,
  });
  return eventId;
}

it('previews the renamed gallery when its old slug is requested', async () => {
  await seedRenamedEvent();
  const meta = await buildOgMetadata('wedding-old-name-2026-06-05', '/gallery/wedding-old-name-2026-06-05');
  expect(meta.title).toMatch(/^New Name/);
  expect(meta.description).toContain('New Name');
});

it('still falls back to the site preview for an unknown slug', async () => {
  const meta = await buildOgMetadata('wedding-never-existed-2026-06-05', '/gallery/wedding-never-existed-2026-06-05');
  expect(meta.title).not.toMatch(/New Name/);
});
