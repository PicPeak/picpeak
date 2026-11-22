/**
 * Multilingual gallery texts (issue 2550).
 *
 *  - PUT /admin/events/:id/translations validates the language, the field
 *    per entity type, the length and that the entity belongs to the event;
 *    stores trimmed text, an empty text removes the row
 *  - ownership: an admin without access to the event is refused
 *  - the public gallery payload carries the texts only while the mode is on,
 *    for the event, its categories and their chapter markers
 *  - /info carries the title's texts, not the welcome message's
 *  - duplicating copies the rows onto the copy's categories; deleting a
 *    category, a folder or the event leaves none behind
 *  - .picpeak export writes the table and the import puts the rows back
 */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'content-translations-secret-at-least-32-chars';

const os = require('os');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('./helpers/crmDb');

jest.mock('../../src/services/portableRestoreWorker', () => ({
  ...jest.requireActual('../../src/services/portableRestoreWorker'),
  assertWorkerAuthority: jest.fn(async () => ({})),
}));

const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'content-translations-'));
process.env.STORAGE_PATH = storageDir;

jest.setTimeout(120000);

describe('multilingual gallery texts (issue 2550)', () => {
  let db; let cleanup; let app; let adminId; let adminToken; let counter = 0;

  const admin = (req, token = adminToken) => req.set('Authorization', `Bearer ${token}`);
  const idOf = (r) => Number(r[0]?.id ?? r[0]);

  async function makeEvent(overrides = {}) {
    counter += 1;
    const slug = `translations-${counter}`;
    const id = idOf(await db('events').insert({
      slug, event_type: 'wedding', event_name: `Hochzeit ${counter}`, event_date: '2026-08-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: `/gallery/${slug}/share`, share_token: `translations-share-${counter}`,
      welcome_message: 'Willkommen',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, require_password: 0,
      created_by: adminId, created_at: new Date().toISOString(),
      ...overrides,
    }).returning('id'));
    const token = jwt.sign({ eventId: id, eventSlug: slug, type: 'gallery' }, process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' });
    return { id, slug, token };
  }

  async function makeCategory(name, eventId) {
    return idOf(await db('photo_categories').insert({
      name, slug: `${name.toLowerCase()}-${eventId || 'global'}-${counter}`,
      event_id: eventId || null, is_global: eventId ? 0 : 1,
    }).returning('id'));
  }

  async function addPhoto(eventId, categoryId, filename) {
    await db('photos').insert({
      event_id: eventId, path: `translations/${eventId}/${filename}`, filename, original_filename: filename,
      type: 'individual', processing_status: 'complete', media_type: 'image', mime_type: 'image/jpeg',
      category_id: categoryId, uploaded_at: '2026-08-01T20:00:00.000Z',
    });
  }

  const put = (eventId, items, token) =>
    admin(request(app).put(`/api/admin/events/${eventId}/translations`), token).send({ items });
  const item = (entity_type, entity_id, field, language, text) => ({ entity_type, entity_id, field, language, text });
  const rowsOf = (where) => db('content_translations').where(where);

  const gallery = async ({ slug, token }) => {
    const res = await request(app).get(`/api/gallery/${slug}/photos`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return res.body;
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId } = await seedMinimal(db));
    await assignAdminRole(db, adminId, 'super_admin');
    adminToken = mintAdminToken(adminId);
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
    app.use('/api/admin/events', require('../../src/routes/adminEvents'));
    app.use('/api/admin/categories', require('../../src/routes/adminCategories'));
    app.use('/api/admin/archives', require('../../src/routes/adminArchives'));
    app.use('/api/v1', require('../../src/routes/v1/events'));
  }, 180000);

  afterAll(async () => {
    if (cleanup) await cleanup();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  it('stores trimmed texts, updates them in place and removes them when empty', async () => {
    const event = await makeEvent();
    const cat = await makeCategory('Trauung', event.id);
    const res = await put(event.id, [
      item('event', event.id, 'event_name', 'en', '  Wedding  '),
      item('event', event.id, 'welcome_message', 'en', 'Welcome!\r\nSecond line'),
      item('category', cat, 'name', 'en', 'Ceremony'),
      item('chapter', cat, 'heading', 'en', 'Wedding\nceremony'),
    ]);
    expect(res.status).toBe(200);
    expect(res.body.text_language_mode).toBe('off');
    expect(res.body.languages).toEqual(['en', 'de', 'es', 'fr', 'nl', 'pt', 'ru', 'sl']);
    const byKey = Object.fromEntries(res.body.translations.map((r) => [`${r.entity_type}:${r.field}`, r.text]));
    expect(byKey).toEqual({
      'event:event_name': 'Wedding',
      // The welcome message keeps its line breaks; a one-line field does not.
      'event:welcome_message': 'Welcome!\nSecond line',
      'category:name': 'Ceremony',
      'chapter:heading': 'Wedding ceremony',
    });

    await put(event.id, [item('event', event.id, 'event_name', 'en', 'The wedding')]).expect(200);
    expect((await rowsOf({ event_id: event.id, field: 'event_name' })).map((r) => r.text)).toEqual(['The wedding']);

    await put(event.id, [item('event', event.id, 'event_name', 'en', '   ')]).expect(200);
    expect(await rowsOf({ event_id: event.id, field: 'event_name' })).toHaveLength(0);

    const listed = (await admin(request(app).get(`/api/admin/events/${event.id}/translations`)).expect(200)).body;
    expect(listed.translations).toHaveLength(3);
  });

  it('refuses unknown languages, fields, entity types, over-long and non-text values, writing nothing', async () => {
    const event = await makeEvent();
    const cat = await makeCategory('Feier', event.id);
    const refused = [
      [item('event', event.id, 'event_name', 'it', 'Matrimonio')],
      [item('event', event.id, 'event_name', 'EN', 'Wedding')],
      [item('event', event.id, 'name', 'en', 'Wedding')],
      [item('category', cat, 'event_name', 'en', 'Party')],
      [item('chapter', cat, 'time', 'en', '12:00')],
      [item('photo', 1, 'name', 'en', 'x')],
      [item('event', event.id, 'event_name', 'en', 'x'.repeat(256))],
      [item('category', cat, 'name', 'en', 'x'.repeat(101))],
      [item('chapter', cat, 'heading', 'en', 'x'.repeat(101))],
      [item('chapter', cat, 'subheading', 'en', 'x'.repeat(201))],
      [item('chapter', cat, 'location', 'en', 'x'.repeat(121))],
      [item('event', event.id, 'welcome_message', 'en', 'x'.repeat(10001))],
      [item('event', event.id, 'event_name', 'en', ['Wedding'])],
      [item('category', 'abc', 'name', 'en', 'x')],
      // One bad item refuses the whole batch.
      [item('category', cat, 'name', 'en', 'Party'), item('category', cat, 'name', 'xx', 'Party')],
    ];
    for (const items of refused) {
      const res = await put(event.id, items);
      expect([res.status, items]).toEqual([400, items]);
    }
    expect((await put(event.id, [])).status).toBe(400);
    expect((await admin(request(app).put(`/api/admin/events/${event.id}/translations`)).send({})).status).toBe(400);
    expect(await rowsOf({ event_id: event.id })).toHaveLength(0);
  });

  it('only translates the event itself and the categories it may use', async () => {
    const a = await makeEvent();
    const b = await makeEvent();
    const shared = await makeCategory('Ceremony');
    const foreign = await makeCategory('Fremd', b.id);
    expect((await put(a.id, [item('event', b.id, 'event_name', 'en', 'x')])).status).toBe(404);
    expect((await put(a.id, [item('category', foreign, 'name', 'en', 'x')])).status).toBe(404);
    expect((await put(a.id, [item('chapter', 999999, 'heading', 'en', 'x')])).status).toBe(404);
    expect(await rowsOf({ event_id: a.id })).toHaveLength(0);

    // A shared global category carries its own text in every gallery.
    await put(a.id, [item('category', shared, 'name', 'de', 'Trauung')]).expect(200);
    await put(b.id, [item('category', shared, 'name', 'de', 'Zeremonie')]).expect(200);
    const rows = await rowsOf({ entity_type: 'category', entity_id: shared }).orderBy('event_id');
    expect(rows.map((r) => r.text)).toEqual(['Trauung', 'Zeremonie']);
  });

  it('refuses an admin who may not edit the event', async () => {
    const event = await makeEvent();
    const otherId = idOf(await db('admin_users').insert({
      username: `photographer-${counter}`, email: `p${counter}@example.com`, password_hash: 'x',
      is_active: true, created_at: new Date().toISOString(),
    }).returning('id'));
    await assignAdminRole(db, otherId, 'solo_photographer');
    const otherToken = mintAdminToken(otherId);
    const res = await put(event.id, [item('event', event.id, 'event_name', 'en', 'Hijack')], otherToken);
    expect([403, 404]).toContain(res.status);
    const read = await admin(request(app).get(`/api/admin/events/${event.id}/translations`), otherToken);
    expect([403, 404]).toContain(read.status);
    expect(await rowsOf({ event_id: event.id })).toHaveLength(0);
  });

  it('validates the mode and the languages on the event', async () => {
    const event = await makeEvent();
    const update = (body) => admin(request(app).put(`/api/admin/events/${event.id}`)).send(body);
    expect((await update({ text_language_mode: 'auto' })).status).toBe(400);
    expect((await update({ text_primary_language: 'it' })).status).toBe(400);
    await update({ text_language_mode: 'bilingual', text_primary_language: 'de', text_secondary_language: 'en' }).expect(200);
    const row = await db('events').where({ id: event.id }).first();
    expect([row.text_language_mode, row.text_primary_language, row.text_secondary_language]).toEqual(['bilingual', 'de', 'en']);
    await update({ text_secondary_language: null }).expect(200);
    expect((await db('events').where({ id: event.id }).first()).text_secondary_language).toBeNull();
  });

  describe('the public gallery', () => {
    let event; let cat; let plain;

    beforeAll(async () => {
      event = await makeEvent({ chapter_marker_style: 'divider' });
      cat = await makeCategory('Trauung', event.id);
      plain = await makeCategory('Details', event.id);
      await addPhoto(event.id, cat, 'c.jpg');
      await addPhoto(event.id, plain, 'd.jpg');
      await admin(request(app).put(`/api/admin/categories/event/${event.id}/${cat}/chapter`))
        .send({ chapter_heading: 'Trauung', chapter_location: 'Standesamt' }).expect(200);
      await put(event.id, [
        item('event', event.id, 'event_name', 'en', 'Wedding'),
        item('event', event.id, 'welcome_message', 'en', 'Welcome'),
        item('category', cat, 'name', 'en', 'Ceremony'),
        item('chapter', cat, 'heading', 'en', 'Wedding ceremony'),
        item('chapter', cat, 'subheading', 'en', '<img src=x onerror=alert(1)>'),
      ]).expect(200);
    });

    const setMode = (mode, primary = 'de', secondary = 'en') => db('events').where({ id: event.id })
      .update({ text_language_mode: mode, text_primary_language: primary, text_secondary_language: secondary });

    it('carries no texts while the mode is off (the default)', async () => {
      await setMode('off', null, null);
      const body = await gallery(event);
      expect(body.event).toMatchObject({
        event_name: expect.stringMatching(/^Hochzeit/), text_language_mode: 'off',
        text_primary_language: null, text_secondary_language: null,
      });
      expect(body.event.translations).toBeUndefined();
      expect(body.categories.find((c) => c.id === cat).translations).toBeUndefined();
      expect(body.categories.find((c) => c.id === cat).chapter.translations).toBeUndefined();
    });

    it.each(['visitor', 'bilingual'])('carries the texts in %s mode, as plain text', async (mode) => {
      await setMode(mode);
      const body = await gallery(event);
      expect(body.event).toMatchObject({
        text_language_mode: mode, text_primary_language: 'de', text_secondary_language: 'en',
        welcome_message: 'Willkommen',
        translations: { event_name: { en: 'Wedding' }, welcome_message: { en: 'Welcome' } },
      });
      const ceremony = body.categories.find((c) => c.id === cat);
      expect(ceremony.name).toBe('Trauung');
      expect(ceremony.translations).toEqual({ name: { en: 'Ceremony' } });
      expect(ceremony.chapter).toMatchObject({
        heading: 'Trauung', location: 'Standesamt',
        // Stored and served verbatim as text; the client renders a text node.
        translations: { heading: { en: 'Wedding ceremony' }, subheading: { en: '<img src=x onerror=alert(1)>' } },
      });
      expect(body.categories.find((c) => c.id === plain).translations).toEqual({});
    });

    it('a stored mode or language the gallery does not know reads as off / none', async () => {
      await setMode('auto', 'it', 'xx');
      const body = await gallery(event);
      expect(body.event).toMatchObject({ text_language_mode: 'off', text_primary_language: null, text_secondary_language: null });
      expect(body.event.translations).toBeUndefined();
    });

    it('/info carries the mode and the title texts, not the welcome message', async () => {
      await setMode('visitor');
      const info = (await request(app).get(`/api/gallery/${event.slug}/info`).expect(200)).body;
      expect(info).toMatchObject({ text_language_mode: 'visitor', text_primary_language: 'de', translations: { event_name: { en: 'Wedding' } } });
      expect(info.translations.welcome_message).toBeUndefined();
      await setMode('off', null, null);
      const off = (await request(app).get(`/api/gallery/${event.slug}/info`).expect(200)).body;
      expect(off.text_language_mode).toBe('off');
      expect(off.translations).toBeUndefined();
    });
  });

  it('API v1 reads the texts with the event, without a write path', async () => {
    const event = await makeEvent({ text_language_mode: 'bilingual', text_primary_language: 'de', text_secondary_language: 'en' });
    await put(event.id, [item('event', event.id, 'event_name', 'en', 'Wedding')]).expect(200);
    const { generateApiToken } = require('../../src/middleware/apiTokenAuth');
    const { plaintext, hashed } = generateApiToken();
    await db('api_tokens').insert({
      name: `translations-token-${counter}`, hashed_token: hashed, scopes: 'admin', created_by: adminId, created_at: new Date().toISOString(),
    });
    const res = await request(app).get(`/api/v1/events/${event.id}`).set('Authorization', `Bearer ${plaintext}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ text_language_mode: 'bilingual', text_primary_language: 'de', text_secondary_language: 'en' });
    expect(res.body.translations).toEqual([
      { entity_type: 'event', entity_id: event.id, field: 'event_name', language: 'en', text: 'Wedding' },
    ]);
    expect(res.body.password_hash).toBeUndefined();
  });

  it('duplicating copies the languages and the texts onto the copied categories', async () => {
    const event = await makeEvent({ text_language_mode: 'visitor', text_primary_language: 'de' });
    const own = await makeCategory('Trauung', event.id);
    const shared = await makeCategory('Feier');
    const foreignEvent = await makeEvent();
    const foreign = await makeCategory('Fremd', foreignEvent.id);
    await put(event.id, [
      item('event', event.id, 'event_name', 'en', 'Wedding'),
      item('event', event.id, 'welcome_message', 'en', 'Welcome'),
      item('category', own, 'name', 'en', 'Ceremony'),
      item('chapter', own, 'heading', 'en', 'Yes'),
      item('category', shared, 'name', 'en', 'Party'),
    ]).expect(200);
    // A stray row pointing at another event's category does not come along.
    await db('content_translations').insert({
      event_id: event.id, entity_type: 'category', entity_id: foreign, field: 'name', language: 'en', text: 'Stray',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });

    const copy = async (name) => {
      const res = await admin(request(app).post(`/api/admin/events/${event.id}/duplicate`)).send({ event_name: name });
      expect(res.status).toBe(200);
      return Number(res.body.id);
    };
    const source = await db('events').where({ id: event.id }).first();
    const sameName = await copy(source.event_name);
    const renamed = await copy('Another wedding');

    const copied = await db('events').where({ id: sameName }).first();
    expect([copied.text_language_mode, copied.text_primary_language]).toEqual(['visitor', 'de']);
    const ownCopy = await db('photo_categories').where({ event_id: sameName, name: 'Trauung' }).first();
    const texts = async (eventId) => Object.fromEntries((await rowsOf({ event_id: eventId }))
      .map((r) => [`${r.entity_type}:${Number(r.entity_id)}:${r.field}`, r.text]));
    expect(await texts(sameName)).toEqual({
      [`event:${sameName}:event_name`]: 'Wedding',
      [`event:${sameName}:welcome_message`]: 'Welcome',
      [`category:${Number(ownCopy.id)}:name`]: 'Ceremony',
      [`chapter:${Number(ownCopy.id)}:heading`]: 'Yes',
      [`category:${shared}:name`]: 'Party',
    });
    // A renamed copy keeps no translation of the old title.
    expect(Object.keys(await texts(renamed)).some((key) => key.endsWith(':event_name'))).toBe(false);
    expect(Object.keys(await texts(renamed))).toHaveLength(4);
    // The source keeps its own rows.
    expect(await rowsOf({ event_id: event.id })).toHaveLength(6);
  });

  it('removing a chapter marker removes its translations, and only those', async () => {
    const event = await makeEvent();
    const cat = await makeCategory('Trauung', event.id);
    const chapter = (body) => admin(request(app).put(`/api/admin/categories/event/${event.id}/${cat}/chapter`)).send(body);
    await chapter({ chapter_heading: 'Trauung', chapter_time: '12:00' }).expect(200);
    await put(event.id, [
      item('chapter', cat, 'heading', 'en', 'Wedding ceremony'),
      item('category', cat, 'name', 'en', 'Ceremony'),
    ]).expect(200);
    // Changing the marker keeps them.
    await chapter({ chapter_time: '12:30' }).expect(200);
    expect(await rowsOf({ event_id: event.id, entity_type: 'chapter' })).toHaveLength(1);
    // Clearing every field removes the marker and its translations.
    await chapter({ chapter_heading: null, chapter_subheading: null, chapter_time: null, chapter_location: null }).expect(200);
    expect(await db('event_category_chapters').where({ event_id: event.id, category_id: cat }).first()).toBeUndefined();
    expect(await rowsOf({ event_id: event.id, entity_type: 'chapter' })).toHaveLength(0);
    expect(await rowsOf({ event_id: event.id, entity_type: 'category' })).toHaveLength(1);
  });

  describe('deleting leaves no translation rows behind (SQLite FK cascades are inert)', () => {
    const textRow = (eventId, entityType, entityId) => db('content_translations').insert({
      event_id: eventId, entity_type: entityType, entity_id: entityId, field: entityType === 'chapter' ? 'heading' : 'name',
      language: 'en', text: 'x', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });

    it('a category, in every gallery that translated it', async () => {
      const a = await makeEvent();
      const b = await makeEvent();
      const shared = await makeCategory('SharedGone');
      await textRow(a.id, 'category', shared);
      await textRow(b.id, 'chapter', shared);
      await admin(request(app).delete(`/api/admin/categories/${shared}`)).expect(200);
      expect(await rowsOf({ entity_id: shared }).whereIn('entity_type', ['category', 'chapter'])).toHaveLength(0);
    });

    it('a folder', async () => {
      const event = await makeEvent();
      const folder = await makeCategory('FolderGone', event.id);
      await db('photo_categories').where({ id: folder }).update({ is_folder: true });
      await textRow(event.id, 'category', folder);
      await require('../../src/services/folderTreeService').deleteFolder(event.id, folder);
      expect(await rowsOf({ entity_type: 'category', entity_id: folder })).toHaveLength(0);
    });

    it('an event and an archive', async () => {
      const event = await makeEvent();
      await textRow(event.id, 'event', event.id);
      await admin(request(app).delete(`/api/admin/events/${event.id}`)).expect(200);
      expect(await rowsOf({ event_id: event.id })).toHaveLength(0);

      const archived = await makeEvent({ is_archived: 1, is_active: 0, archived_at: new Date().toISOString() });
      await textRow(archived.id, 'event', archived.id);
      await admin(request(app).delete(`/api/admin/archives/${archived.id}`)).expect(200);
      expect(await rowsOf({ event_id: archived.id })).toHaveLength(0);
    });
  });

  it('.picpeak export carries the table and the import puts the rows back', async () => {
    const event = await makeEvent();
    await put(event.id, [item('event', event.id, 'event_name', 'fr', 'Mariage')]).expect(200);
    const before = Array.from(await db('content_translations').orderBy('id'));
    expect(before.length).toBeGreaterThan(0);

    const StreamZip = require('node-stream-zip');
    const { createPicpeak } = require('../../src/services/picpeakExportService');
    const { filePath, manifest } = await createPicpeak({ includePhotos: false });
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'content-translations-import-'));
    try {
      expect(manifest.tables.content_translations.rowCount)
        .toBe(before.length);
      const zip = new StreamZip.async({ file: filePath });
      fs.writeFileSync(path.join(dataDir, 'content_translations.ndjson'), await zip.entryData('data/content_translations.ndjson'));
      await zip.close();

      await db('content_translations').del();
      const { replaceAllTables } = require('../../src/services/picpeakImportService');
      await db.transaction((trx) => replaceAllTables(['content_translations'], dataDir, null, null,
        { executor: trx, allTables: ['content_translations'] }));
      const after = Array.from(await db('content_translations').orderBy('id'));
      const shape = (rows) => rows.map((r) => [Number(r.id), Number(r.event_id), r.entity_type, Number(r.entity_id), r.field, r.language, r.text]);
      expect(shape(after)).toEqual(shape(before));
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    }
  });
});
