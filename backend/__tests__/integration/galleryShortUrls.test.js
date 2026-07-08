/**
 * Integration tests for the branded short-URL service (#699).
 *
 * Exercises createShortUrl + findByShortSlug + listForEvent + softDelete
 * + recordHit against a real SQLite DB, including the contracts that
 * matter for production correctness:
 *
 *   - Custom slug + collision detection (409 with `suggested`)
 *   - Auto-generated slug from event slug + year
 *   - Soft-delete preserves the row (admin can audit)
 *   - target_path snapshots at create time (toggling the global
 *     "Use short gallery URLs" setting later doesn't change existing
 *     short URLs — backward-compat invariant from #699)
 *   - hit_count increments idempotently
 *   - findByShortSlug returns soft-deleted rows (caller decides 410 vs 404)
 *
 * Boots one DB for the whole file (cheap on SQLite); each test seeds
 * its own event row to keep scope clean.
 */
const { bootCrmDb } = require('./helpers/crmDb');

jest.setTimeout(60000);

let db; let cleanup; let service; let adminId;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());

  // Minimal admin for created_by audit.
  const adminInsert = await db('admin_users').insert({
    username: 'shorturl-test',
    email: 'shorturl@example.com',
    password_hash: 'x',
    must_change_password: false,
    created_at: new Date(),
  }).returning('id');
  adminId = adminInsert[0]?.id ?? adminInsert[0];

  service = require('../../src/services/galleryShortUrlService');
}, 120000);

afterAll(async () => { if (cleanup) await cleanup(); });

// Each test seeds a fresh event so collisions / counter state don't leak.
async function seedEvent(overrides = {}) {
  const slug = overrides.slug || `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const farFuture = new Date(Date.now() + 365 * 86400000).toISOString();
  const [id] = await db('events').insert({
    slug,
    event_type: 'wedding',
    event_name: overrides.event_name || 'Test Wedding',
    event_date: overrides.event_date || '2026-06-05',
    password_hash: 'x',
    expires_at: farFuture,
    is_active: true,
    is_archived: false,
    share_link: slug,
    share_token: overrides.share_token || `tok${Math.random().toString(36).slice(2, 12)}`,
    welcome_message: null,
  });
  const event = await db('events').where({ id }).first();
  return event;
}

describe('createShortUrl — custom slug', () => {
  it('creates with a custom slug', async () => {
    const event = await seedEvent({ slug: 'sofia-grad-1' });
    const row = await service.createShortUrl({
      eventId: event.id,
      customSlug: 'sofia-graduation-1',
      createdBy: adminId,
    });
    expect(row.short_slug).toBe('sofia-graduation-1');
    expect(row.target_path).toBe(`/gallery/${event.slug}`);
    expect(row.event_id).toBe(event.id);
    expect(row.hit_count).toBe(0);
  });

  it('lowercases the input — operators pasting mixed-case still get a clean slug', async () => {
    const event = await seedEvent({ slug: 'sofia-grad-2' });
    const row = await service.createShortUrl({
      eventId: event.id,
      customSlug: 'Sofia-GraduAtion-2',  // mixed case
      createdBy: adminId,
    });
    expect(row.short_slug).toBe('sofia-graduation-2');
  });

  it('rejects an invalid slug with INVALID_SLUG code', async () => {
    const event = await seedEvent({ slug: 'invalid-test' });
    await expect(service.createShortUrl({
      eventId: event.id,
      customSlug: 'invalid slug with spaces',
      createdBy: adminId,
    })).rejects.toMatchObject({ code: 'INVALID_SLUG' });
  });

  it('rejects a reserved slug with INVALID_SLUG code', async () => {
    const event = await seedEvent({ slug: 'reserved-test' });
    await expect(service.createShortUrl({
      eventId: event.id,
      customSlug: 'admin',
      createdBy: adminId,
    })).rejects.toMatchObject({ code: 'INVALID_SLUG' });
  });

  it('rejects a duplicate slug with SLUG_TAKEN + suggested fallback', async () => {
    const event1 = await seedEvent({ slug: 'dup-test-1' });
    const event2 = await seedEvent({ slug: 'dup-test-2' });
    await service.createShortUrl({ eventId: event1.id, customSlug: 'collide-me' });
    await expect(service.createShortUrl({
      eventId: event2.id, customSlug: 'collide-me',
    })).rejects.toMatchObject({
      code: 'SLUG_TAKEN',
      suggested: expect.any(String),
    });
  });

  it('throws EVENT_NOT_FOUND when the event id does not exist', async () => {
    await expect(service.createShortUrl({
      eventId: 9999999, customSlug: 'no-event',
    })).rejects.toMatchObject({ code: 'EVENT_NOT_FOUND' });
  });
});

describe('createShortUrl — auto-generated slug', () => {
  it('uses event slug + year when no custom slug provided', async () => {
    const event = await seedEvent({
      slug: 'autogen-wedding', event_date: '2026-06-05',
    });
    const row = await service.createShortUrl({
      eventId: event.id,
      createdBy: adminId,
    });
    // First-choice candidate is just the slug; takes that.
    expect(row.short_slug).toBe('autogen-wedding');
  });

  it('falls back to slug-year when the bare slug is already taken', async () => {
    // Both events SHARE the same canonical slug so the first-choice
    // bare-slug candidate is burned, forcing autoGen to try the
    // year-suffixed variant.
    const event1 = await seedEvent({
      slug: 'collide-base', event_date: '2026-07-01',
    });
    await service.createShortUrl({
      eventId: event1.id, customSlug: 'collide-base',
    });
    const event2 = await seedEvent({
      slug: 'collide-base-2', event_date: '2026-07-01',
    });
    // Force the bare candidate of event2 to also collide by burning it.
    await service.createShortUrl({
      eventId: event1.id, customSlug: 'collide-base-2',
    });
    const row = await service.createShortUrl({
      eventId: event2.id,  // No custom — auto-gen from event2.slug
    });
    // Bare candidate `collide-base-2` is taken → year-suffixed picks.
    expect(row.short_slug).toBe('collide-base-2-2026');
  });
});

describe('createShortUrl — target_path snapshotting (#699 backward-compat)', () => {
  it('uses /gallery/<slug> when the global short-URLs setting is OFF (default)', async () => {
    const event = await seedEvent({ slug: 'snapshot-off' });
    const row = await service.createShortUrl({
      eventId: event.id, customSlug: 'snap-off',
    });
    expect(row.target_path).toBe(`/gallery/${event.slug}`);
  });

  it('uses /gallery/<share_token> when the global setting is ON at create time', async () => {
    // Persist the setting.
    const { upsertAppSetting } = require('../../src/utils/appSettings');
    await upsertAppSetting('general_use_short_gallery_urls', JSON.stringify(true), 'system');
    try {
      const event = await seedEvent({ slug: 'snapshot-on', share_token: 'tokenAbc123' });
      const row = await service.createShortUrl({
        eventId: event.id, customSlug: 'snap-on',
      });
      expect(row.target_path).toBe(`/gallery/${event.share_token}`);

      // CRITICAL backward-compat invariant: now flip the setting OFF.
      // Existing short URLs must still resolve to the same target_path
      // they were created with — operator's existing share links don't
      // silently change behaviour.
      await upsertAppSetting('general_use_short_gallery_urls', JSON.stringify(false), 'system');
      const refetched = await service.findByShortSlug('snap-on');
      expect(refetched.target_path).toBe(`/gallery/${event.share_token}`);
    } finally {
      await upsertAppSetting('general_use_short_gallery_urls', JSON.stringify(false), 'system');
    }
  });
});

describe('findByShortSlug + listForEvent', () => {
  it('returns null for an unknown slug', async () => {
    expect(await service.findByShortSlug('does-not-exist-xyz')).toBeNull();
  });

  it('returns null for a malformed slug (no DB hit)', async () => {
    expect(await service.findByShortSlug('UPPER_CASE')).toBeNull();
    expect(await service.findByShortSlug('with spaces')).toBeNull();
    expect(await service.findByShortSlug('')).toBeNull();
  });

  it('returns soft-deleted rows (caller decides 410 vs 404)', async () => {
    const event = await seedEvent({ slug: 'softdel-find' });
    const created = await service.createShortUrl({
      eventId: event.id, customSlug: 'find-deleted',
    });
    await service.softDelete(created.id, adminId);
    const fetched = await service.findByShortSlug('find-deleted');
    expect(fetched).not.toBeNull();
    expect(fetched.deleted_at).toBeTruthy();
  });

  it('listForEvent excludes soft-deleted rows', async () => {
    const event = await seedEvent({ slug: 'list-test' });
    const live = await service.createShortUrl({
      eventId: event.id, customSlug: 'list-live',
    });
    const deleted = await service.createShortUrl({
      eventId: event.id, customSlug: 'list-deleted',
    });
    await service.softDelete(deleted.id, adminId);
    const list = await service.listForEvent(event.id);
    const ids = list.map((r) => r.id);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(deleted.id);
  });
});

describe('softDelete', () => {
  it('returns true on first call, false on second (idempotent admin clicks)', async () => {
    const event = await seedEvent({ slug: 'softdel-idem' });
    const created = await service.createShortUrl({
      eventId: event.id, customSlug: 'idem-delete',
    });
    expect(await service.softDelete(created.id, adminId)).toBe(true);
    expect(await service.softDelete(created.id, adminId)).toBe(false);
  });

  it('returns false for an unknown id (caller maps to 404)', async () => {
    expect(await service.softDelete(9999999, adminId)).toBe(false);
  });
});

describe('createShortUrl after soft-delete — slug rotation', () => {
  it('re-creating a soft-deleted slug succeeds (purges the deleted row)', async () => {
    const event = await seedEvent({ slug: 'rotate' });
    const first = await service.createShortUrl({
      eventId: event.id, customSlug: 'rotate-me',
    });
    await service.softDelete(first.id, adminId);
    // The slug is now reclaimable for a fresh row.
    const second = await service.createShortUrl({
      eventId: event.id, customSlug: 'rotate-me',
    });
    expect(second.id).not.toBe(first.id);
    expect(second.short_slug).toBe('rotate-me');
  });
});

describe('recordHit', () => {
  it('increments hit_count + stamps last_hit_at', async () => {
    const event = await seedEvent({ slug: 'hit-counter' });
    const row = await service.createShortUrl({
      eventId: event.id, customSlug: 'count-me',
    });
    await service.recordHit(row.id);
    await service.recordHit(row.id);
    const fetched = await service.findByShortSlug('count-me');
    expect(fetched.hit_count).toBe(2);
    expect(fetched.last_hit_at).toBeTruthy();
  });

  it('is fire-and-forget — invalid id does not throw', async () => {
    await expect(service.recordHit(9999999)).resolves.not.toThrow();
  });
});
