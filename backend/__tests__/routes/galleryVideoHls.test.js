/**
 * The adaptive streaming routes (issue 1733, D4), through the real gallery
 * router against SQLite and local storage: the same access chain as the
 * video route, the rewritten playlists, the names a request may reach, one
 * download slot per playback, and what a delete leaves behind.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-hls-routes-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'hls-routes-test-secret-at-least-thirty-two';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-hls-routes-storage-'));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

const SLUG = 'hls-gallery';
const OTHER = 'hls-other-gallery';
const ATTEMPT = '0b6f6d0e-5f0b-4c55-9f0e-2a4d3c1b7e9a';
const SEGMENT = Buffer.from('fmp4-segment-bytes');
const INIT = Buffer.from('fmp4-init-bytes');
const MASTER = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS',
  '#EXT-X-STREAM-INF:BANDWIDTH=1460800,RESOLUTION=854x480', '480p/index.m3u8', ''].join('\n');
const MEDIA = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:6', '#EXT-X-PLAYLIST-TYPE:VOD',
  '#EXT-X-MAP:URI="init.mp4"', '#EXTINF:6.000000,', 'seg_00000.m4s', '#EXT-X-ENDLIST', ''].join('\n');

const unwrap = rows => rows[0]?.id ?? rows[0];
const binary = (res, cb) => {
  const chunks = [];
  res.on('data', c => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('adaptive streaming routes (issue 1733)', () => {
  let db; let cleanup; let app; let eventId; let otherEventId; let storage; let hls;
  let streamed; let hidden; let underReview; let noLadder; let elsewhere; let image;

  const insertEvent = async slug => unwrap(await db('events').insert({
    slug, event_type: 'wedding', event_name: slug, event_date: '2026-10-12',
    host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
    share_link: `/gallery/${slug}/s`, share_token: `${slug}-share`,
    expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
    is_active: 1, is_archived: 0, is_draft: 0, require_password: 0, allow_downloads: 1,
    created_at: new Date().toISOString(),
  }).returning('id'));

  const writeLadder = async (photoId, attempt = ATTEMPT) => {
    const prefix = `hls/${photoId}/${attempt}`;
    await storage.put(`${prefix}/master.m3u8`, Buffer.from(MASTER));
    await storage.put(`${prefix}/480p/index.m3u8`, Buffer.from(MEDIA));
    await storage.put(`${prefix}/480p/init.mp4`, INIT);
    await storage.put(`${prefix}/480p/seg_00000.m4s`, SEGMENT);
    return prefix;
  };

  const insertVideo = async (filename, { event = eventId, slug = SLUG, ladder = true, ...over } = {}) => {
    await storage.put(`events/active/${slug}/individual/${filename}`, Buffer.from(`original of ${filename}`));
    const id = unwrap(await db('photos').insert({
      event_id: event, filename, path: `${slug}/individual/${filename}`, type: 'individual',
      media_type: 'video', mime_type: 'video/mp4', size_bytes: 100, uploaded_at: new Date().toISOString(), ...over,
    }).returning('id'));
    if (ladder) await db('photos').where({ id }).update({ hls_status: 'complete', hls_path: await writeLadder(id) });
    return id;
  };

  const token = (claims = {}, slug = SLUG, id = eventId) => jwt.sign({ type: 'gallery', eventId: id, eventSlug: slug, ...claims },
    process.env.JWT_SECRET, { issuer: 'picpeak-auth', expiresIn: '1h' });
  const get = (route, { slug = SLUG, headers = {} } = {}) => request(app).get(`/api/gallery/${slug}/hls/${route}`)
    .set(headers).buffer().parse(binary);
  const asClient = { Authorization: 'Bearer placeholder' };
  const setFlag = async (on) => {
    await db('app_settings').where({ setting_key: hls.SETTING_KEY }).delete();
    await db('app_settings').insert({ setting_key: hls.SETTING_KEY, setting_value: JSON.stringify(on), setting_type: 'general' });
    hls.clearCache();
  };
  const grants = () => db('event_download_grants').where({ event_id: eventId });
  const settled = async () => {
    for (let i = 0; i < 200; i++) {
      if (!(await grants().where('pending_holders', '>', 0).first())) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('The download grant did not settle');
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    storage = require('../../src/services/storage').getStorage();
    hls = require('../../src/services/videoHlsService');
    eventId = await insertEvent(SLUG);
    otherEventId = await insertEvent(OTHER);

    streamed = await insertVideo('streamed.mp4');
    hidden = await insertVideo('hidden.mp4', { visibility: 'hidden' });
    underReview = await insertVideo('review.mp4', { visibility: 'hidden', moderation_status: 'pending' });
    noLadder = await insertVideo('plain.mp4', { ladder: false });
    elsewhere = await insertVideo('elsewhere.mp4', { event: otherEventId, slug: OTHER });
    image = unwrap(await db('photos').insert({
      event_id: eventId, filename: 'still.jpg', path: `${SLUG}/individual/still.jpg`, type: 'individual',
      mime_type: 'image/jpeg', uploaded_at: new Date().toISOString(),
    }).returning('id'));
    asClient.Authorization = `Bearer ${token({ accessLevel: 'client' })}`;

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
  }, 120000);

  beforeEach(async () => {
    await setFlag(true);
    await db('events').where({ id: eventId }).update({ download_limit: null });
    await db('event_download_grants').delete();
  });

  afterAll(async () => { if (cleanup) await cleanup(); });

  describe('with the setting off', () => {
    test('no route is reachable, whoever asks', async () => {
      await setFlag(false);
      for (const route of [`${streamed}/master.m3u8`, `${streamed}/480p/index.m3u8`, `${streamed}/480p/seg_00000.m4s`]) {
        expect((await get(route)).status).toBe(404);
        expect((await get(route, { headers: asClient })).status).toBe(404);
      }
      // Before any gallery check: a gallery that does not exist answers the same.
      expect((await get(`${streamed}/master.m3u8`, { slug: 'no-such-gallery' })).status).toBe(404);
    });

    test('the photo list offers no stream', async () => {
      await setFlag(false);
      const res = await request(app).get(`/api/gallery/${SLUG}/photos`);
      expect(res.status).toBe(200);
      expect(res.body.photos.find(photo => photo.id === streamed).hls_url).toBeNull();
    });

    test('a setting never written is off', async () => {
      await db('app_settings').where({ setting_key: hls.SETTING_KEY }).delete();
      hls.clearCache();
      expect((await get(`${streamed}/master.m3u8`)).status).toBe(404);
    });
  });

  describe('playlists and segments', () => {
    test('the photo list names the stream of a video that has one, and of no other', async () => {
      const res = await request(app).get(`/api/gallery/${SLUG}/photos`);
      const byId = id => res.body.photos.find(photo => photo.id === id);
      expect(byId(streamed).hls_url).toBe(`/api/gallery/${SLUG}/hls/${streamed}/master.m3u8?v=${ATTEMPT.slice(-12)}`);
      expect(byId(streamed).url).toBe(`/api/gallery/${SLUG}/photo/${streamed}`);
      expect(byId(noLadder).hls_url).toBeNull();
      expect(byId(image).hls_url).toBeNull();
    });

    test('serves the master playlist with relative rung URLs', async () => {
      const res = await get(`${streamed}/master.m3u8`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^application\/vnd\.apple\.mpegurl/);
      expect(res.body.toString()).toBe(MASTER);
    });

    test('passes the cache-buster and the admin-preview flag on, and nothing else', async () => {
      const master = await get(`${streamed}/master.m3u8?v=2a4d3c1b7e9a&token=secret&x=%0a%23EXT`);
      expect(master.body.toString()).toContain('\n480p/index.m3u8?v=2a4d3c1b7e9a\n');
      expect(master.body.toString()).not.toMatch(/token|secret|x=/);
      const media = await get(`${streamed}/480p/index.m3u8?v=2a4d3c1b7e9a`);
      expect(media.status).toBe(200);
      expect(media.body.toString()).toContain('#EXT-X-MAP:URI="init.mp4?v=2a4d3c1b7e9a"');
      expect(media.body.toString()).toContain('\nseg_00000.m4s?v=2a4d3c1b7e9a\n');
      // A value that is not this ladder's is refused, never echoed into a playlist.
      expect((await get(`${streamed}/480p/index.m3u8?v=a%0Ab`)).status).toBe(404);
    });

    test('a request naming a ladder that was rebuilt since is refused, not answered from the new one', async () => {
      // A player still holding the old playlists would otherwise get the new
      // ladder's segments for the old init file, cached under the old URL.
      const id = await insertVideo('rebuilt.mp4');
      const rebuilt = '33333333-3333-4333-8333-333333333333';
      await db('photos').where({ id }).update({ hls_path: await writeLadder(id, rebuilt) });
      for (const route of ['master.m3u8', '480p/index.m3u8', '480p/init.mp4', '480p/seg_00000.m4s']) {
        expect((await get(`${id}/${route}?v=${ATTEMPT.slice(-12)}`)).status).toBe(404);
        expect((await get(`${id}/${route}?v=${rebuilt.slice(-12)}`)).status).toBe(200);
        expect((await get(`${id}/${route}?v=${rebuilt.slice(-12)}&v=${rebuilt.slice(-12)}`)).status).toBe(404);
      }
      // The stale master did not send the row back to the queue.
      expect(await db('photos').where({ id }).first('hls_status', 'hls_path'))
        .toEqual({ hls_status: 'complete', hls_path: `hls/${id}/${rebuilt}` });
      await hls.deleteLadder({ id, hls_status: 'complete' });
      await db('photos').where({ id }).delete();
    });

    test('serves the init file and a segment with their length and type', async () => {
      const init = await get(`${streamed}/480p/init.mp4`);
      expect(init.status).toBe(200);
      expect(init.headers['content-type']).toBe('video/mp4');
      expect(init.body).toEqual(INIT);
      const segment = await get(`${streamed}/480p/seg_00000.m4s`);
      expect(segment.status).toBe(200);
      expect(segment.headers['content-type']).toBe('video/iso.segment');
      expect(segment.headers['content-length']).toBe(String(SEGMENT.length));
      expect(segment.headers['cache-control']).toBe('private, max-age=1800');
      expect(segment.body).toEqual(SEGMENT);
    });

    test.each([
      '480p/seg_00001.m4s', // well-formed, not in storage
      '480p/seg_0.m4s', '480p/seg_00000.ts', '480p/master.m3u8', '480p/..%2Fmaster.m3u8',
      '480p/%2e%2e', '..%2F..%2Fevents/seg_00000.m4s', '720/init.mp4', 'events/init.mp4',
      '480p/seg_00000.m4s%00', '480p/init.mp4.bak',
    ])('answers 404 for %s', async (rest) => {
      expect((await get(`${streamed}/${rest}`)).status).toBe(404);
    });

    test('a name that leaves the ladder never reads the original, even though it is in storage', async () => {
      const res = await get(`${streamed}/..%2F..%2F..%2Fevents%2Factive%2F${SLUG}%2Findividual/streamed.mp4`);
      expect(res.status).toBe(404);
      expect(res.body.toString()).not.toContain('original of');
    });

    test('a video without a ladder, an image and an unknown id have no stream', async () => {
      for (const id of [noLadder, image, 999999, 'abc', `${streamed}x`]) {
        expect((await get(`${id}/master.m3u8`)).status).toBe(404);
        expect((await get(`${id}/480p/seg_00000.m4s`)).status).toBe(404);
      }
    });

    test('a row pointing at another photo\'s ladder is not followed', async () => {
      await db('photos').where({ id: noLadder }).update({ hls_status: 'complete', hls_path: `hls/${streamed}/${ATTEMPT}` });
      expect((await get(`${noLadder}/master.m3u8`)).status).toBe(404);
      expect((await get(`${noLadder}/480p/seg_00000.m4s`)).status).toBe(404);
      await db('photos').where({ id: noLadder }).update({ hls_status: null, hls_path: null });
    });

    test('a ladder storage no longer has answers 404 and puts the row back for the queue', async () => {
      const id = await insertVideo('restored.mp4', { ladder: false });
      await db('photos').where({ id }).update({ hls_status: 'complete', hls_path: `hls/${id}/${ATTEMPT}` });
      expect((await get(`${id}/master.m3u8`)).status).toBe(404);
      expect(await db('photos').where({ id }).first('hls_status', 'hls_path')).toEqual({ hls_status: null, hls_path: null });
      await db('photos').where({ id }).delete();
    });
  });

  describe('access', () => {
    const routes = id => [`${id}/master.m3u8`, `${id}/480p/index.m3u8`, `${id}/480p/init.mp4`, `${id}/480p/seg_00000.m4s`];

    test('a hidden video is refused to a guest on every route and plays for the client', async () => {
      for (const route of routes(hidden)) {
        expect((await get(route)).status).toBe(403);
        expect((await get(route, { headers: asClient })).status).toBe(200);
      }
    });

    test('a video under review is refused to the client as well', async () => {
      for (const route of routes(underReview)) {
        expect((await get(route)).status).toBe(403);
        expect((await get(route, { headers: asClient })).status).toBe(403);
      }
    });

    test('a video of another gallery is not found under this one, whatever the token', async () => {
      for (const route of routes(elsewhere)) {
        expect((await get(route)).status).toBe(404);
        expect((await get(route, { headers: asClient })).status).toBe(404);
      }
      // And under its own gallery it is there.
      expect((await get(`${elsewhere}/master.m3u8`, { slug: OTHER })).status).toBe(200);
    });

    test('a token for another gallery opens nothing here', async () => {
      await db('events').where({ id: eventId }).update({ require_password: 1 });
      try {
        const foreign = { Authorization: `Bearer ${token({}, OTHER, otherEventId)}` };
        for (const route of routes(streamed)) {
          expect((await get(route)).status).toBeGreaterThanOrEqual(401);
          expect((await get(route, { headers: foreign })).status).toBeGreaterThanOrEqual(401);
          expect((await get(route, { headers: { Authorization: `Bearer ${token()}` } })).status).toBe(200);
        }
        // The cookie the browser's own HLS player sends works as it does for <video src>.
        const viaCookie = await get(`${streamed}/480p/seg_00000.m4s`, { headers: { Cookie: `gallery_token_${SLUG}=${token()}` } });
        expect(viaCookie.status).toBe(200);
      } finally {
        await db('events').where({ id: eventId }).update({ require_password: 0 });
      }
    });

    test('a slideshow token is display-only here as on the video route', async () => {
      const slideshow = { Authorization: `Bearer ${token({ accessLevel: 'slideshow' })}` };
      for (const route of routes(streamed)) expect((await get(route, { headers: slideshow })).status).toBe(403);
    });
  });

  describe('download limit', () => {
    beforeEach(async () => { await db('events').where({ id: eventId }).update({ download_limit: 2 }); });

    test('one playback takes one slot, however many playlists and segments it fetches', async () => {
      expect((await get(`${streamed}/master.m3u8`, { headers: asClient })).status).toBe(200);
      for (let round = 0; round < 3; round++) {
        expect((await get(`${streamed}/480p/index.m3u8`, { headers: asClient })).status).toBe(200);
        expect((await get(`${streamed}/480p/init.mp4`, { headers: asClient })).status).toBe(200);
        expect((await get(`${streamed}/480p/seg_00000.m4s`, { headers: asClient })).status).toBe(200);
      }
      await settled();
      expect((await grants()).map(row => Number(row.photo_id))).toEqual([streamed]);
      // Playing it again, or the original after it, costs nothing more.
      expect((await get(`${streamed}/master.m3u8`, { headers: asClient })).status).toBe(200);
      expect((await request(app).get(`/api/gallery/${SLUG}/photo/${streamed}`).set(asClient).buffer().parse(binary)).status).toBe(200);
      await settled();
      expect(await grants()).toHaveLength(1);
    });

    test('segments and rung playlists are not a way around the master playlist', async () => {
      for (const route of [`${streamed}/480p/index.m3u8`, `${streamed}/480p/init.mp4`, `${streamed}/480p/seg_00000.m4s`]) {
        expect((await get(route, { headers: asClient })).status).toBe(403);
        expect((await get(route)).status).toBe(403);
      }
      expect(await grants()).toHaveLength(0);
    });

    test('a slot another download only holds opens no segment, and the master playlist takes its own at once', async () => {
      // A ZIP that is still being built holds its photos' slots and gives
      // them back when it is abandoned: a stream played on such a hold would
      // have cost nothing.
      const { grantDownloads, settleReservation } = require('../../src/services/downloadQuota');
      const event = await db('events').where({ id: eventId }).first();
      const zip = await grantDownloads(event, [streamed], { reserve: true });
      expect(zip.ok).toBe(true);
      for (const route of [`${streamed}/480p/index.m3u8`, `${streamed}/480p/seg_00000.m4s`]) {
        expect((await get(route, { headers: asClient })).status).toBe(403);
      }
      // Playing it is a grant of its own, there before the first rung is asked for.
      expect((await get(`${streamed}/master.m3u8`, { headers: asClient })).status).toBe(200);
      expect((await grants()).map(row => [Number(row.photo_id), Number(row.pending_holders)])).toEqual([[streamed, 0]]);
      expect((await get(`${streamed}/480p/seg_00000.m4s`, { headers: asClient })).status).toBe(200);
      // The abandoned ZIP gives nothing back that the playback took.
      await settleReservation(eventId, zip, []);
      expect(await grants()).toHaveLength(1);
    });

    test('a guest takes no slot: refused until the client has played the video, served after', async () => {
      expect((await get(`${streamed}/master.m3u8`)).status).toBe(403);
      expect(await grants()).toHaveLength(0);
      expect((await get(`${streamed}/master.m3u8`, { headers: asClient })).status).toBe(200);
      await settled();
      expect((await get(`${streamed}/master.m3u8`)).status).toBe(200);
      expect((await get(`${streamed}/480p/seg_00000.m4s`)).status).toBe(200);
      expect(await grants()).toHaveLength(1);
    });

    test('a used-up limit refuses the stream as it refuses the original', async () => {
      await db('events').where({ id: eventId }).update({ download_limit: 1 });
      expect((await get(`${hidden}/master.m3u8`, { headers: asClient })).status).toBe(200);
      await settled();
      const refused = await get(`${streamed}/master.m3u8`, { headers: asClient });
      expect(refused.status).toBe(403);
      const original = await request(app).get(`/api/gallery/${SLUG}/photo/${streamed}`).set(asClient);
      expect(original.status).toBe(refused.status);
      expect(await grants()).toHaveLength(1);
    });

    test('a video whose web copy plays free streams free too', async () => {
      await storage.put(`videos/web_${streamed}_streamed.mp4`, Buffer.from('copy'));
      await db('photos').where({ id: streamed }).update({ web_path: `videos/web_${streamed}_streamed.mp4`, web_status: 'complete' });
      try {
        expect((await get(`${streamed}/master.m3u8`)).status).toBe(200);
        expect((await get(`${streamed}/480p/seg_00000.m4s`)).status).toBe(200);
        expect(await grants()).toHaveLength(0);
      } finally {
        await db('photos').where({ id: streamed }).update({ web_path: null, web_status: null });
      }
    });

    test('a web copy the row names but storage no longer has waives nothing', async () => {
      // The video route stats the copy before it plays it free; the stream
      // stands in for that route and has to reach the same verdict.
      await db('events').where({ id: eventId }).update({ download_limit: 1 });
      const copy = `videos/web_${streamed}_gone.mp4`;
      await storage.put(copy, Buffer.from('copy'));
      await db('photos').where({ id: streamed }).update({ web_path: copy, web_status: 'complete' });
      try {
        expect((await get(`${streamed}/master.m3u8`)).status).toBe(200);
        expect((await get(`${streamed}/480p/seg_00000.m4s`)).status).toBe(200);
        await storage.delete(copy);
        expect((await get(`${streamed}/master.m3u8`)).status).toBe(403);
        expect((await get(`${streamed}/480p/index.m3u8`)).status).toBe(403);
        expect((await get(`${streamed}/480p/seg_00000.m4s`)).status).toBe(403);
        // A pointer outside the web-copy namespace is not followed either.
        await db('photos').where({ id: streamed }).update({ web_path: `events/active/${SLUG}/individual/streamed.mp4` });
        expect((await get(`${streamed}/master.m3u8`)).status).toBe(403);
        expect(await grants()).toHaveLength(0);
      } finally {
        await db('photos').where({ id: streamed }).update({ web_path: null, web_status: null });
      }
    });

    test('the photo list offers the stream only where playing it is free for this viewer', async () => {
      const list = async headers => (await request(app).get(`/api/gallery/${SLUG}/photos`).set(headers)).body.photos
        .find(photo => photo.id === streamed).hls_url;
      expect(await list(asClient)).toBeNull();
      expect((await get(`${streamed}/master.m3u8`, { headers: asClient })).status).toBe(200);
      await settled();
      expect(await list(asClient)).toContain(`/hls/${streamed}/master.m3u8`);
      expect(await list({})).toContain(`/hls/${streamed}/master.m3u8`);
    });
  });

  describe('deleting', () => {
    const keysUnder = async prefix => (await storage.list(prefix)).map(entry => entry.key).sort();

    test('deleteLadder removes every attempt of this photo and nothing of its neighbours', async () => {
      const a = await insertVideo('delete-a.mp4');
      // 1 and 10-something share a string prefix: hls/1 must not take hls/1x with it.
      const b = await insertVideo('delete-b.mp4');
      await writeLadder(a, '11111111-1111-4111-8111-111111111111');
      await storage.put(`hls/${a}0000/${ATTEMPT}/master.m3u8`, Buffer.from(MASTER));
      expect(await keysUnder(`hls/${a}`)).toHaveLength(8);

      await hls.deleteLadder(await db('photos').where({ id: a }).first());
      expect(await keysUnder(`hls/${a}`)).toEqual([]);
      // No empty directory tree stays behind on local disk either.
      expect(fs.existsSync(path.join(process.env.STORAGE_PATH, 'hls', String(a)))).toBe(false);
      expect(fs.existsSync(path.join(process.env.STORAGE_PATH, 'hls', String(b), ATTEMPT, '480p'))).toBe(true);
      expect(await keysUnder(`hls/${b}`)).toHaveLength(4);
      expect(await keysUnder(`hls/${a}0000`)).toHaveLength(1);
      await storage.delete(`hls/${a}0000/${ATTEMPT}/master.m3u8`);
    });

    test('deleting the gallery deletes the ladders of its videos', async () => {
      const slug = 'hls-doomed';
      const doomedEvent = await insertEvent(slug);
      const doomed = await insertVideo('doomed.mp4', { event: doomedEvent, slug });
      const survivor = await insertVideo('survivor.mp4');
      expect(await keysUnder(`hls/${doomed}`)).toHaveLength(4);

      const { deleteEventCascade } = require('../../src/routes/adminEvents/helpers');
      await deleteEventCascade(doomedEvent, { id: null });
      expect(await db('photos').where({ id: doomed }).first()).toBeUndefined();
      expect(await keysUnder(`hls/${doomed}`)).toEqual([]);
      expect(await keysUnder(`hls/${survivor}`)).toHaveLength(4);
    });

    test('removing a duplicate row removes its ladder and keeps the survivor\'s', async () => {
      const survivor = await insertVideo('twin.mp4');
      const duplicate = await insertVideo('twin-again.mp4');
      const never = await insertVideo('twin-plain.mp4', { ladder: false });
      const { deleteDuplicatePhotos } = require('../../src/services/externalPhotoDedupe');
      expect(await deleteDuplicatePhotos(db, new Map([[duplicate, survivor], [never, survivor]]))).toBe(2);
      expect(await db('photos').whereIn('id', [duplicate, never])).toEqual([]);
      expect(await keysUnder(`hls/${duplicate}`)).toEqual([]);
      expect(await keysUnder(`hls/${survivor}`)).toHaveLength(4);
      expect((await get(`${survivor}/master.m3u8`)).status).toBe(200);
    });

    test('a batch of duplicates beyond one statement\'s parameters is still removed', async () => {
      // SQLite takes 32,766 variables per statement; a restore can fold more rows than that.
      const survivor = await insertVideo('twin-many.mp4');
      const duplicate = await insertVideo('twin-many-again.mp4');
      const doomed = new Map([[duplicate, survivor]]);
      for (let id = 5000000; doomed.size < 33000; id++) doomed.set(id, survivor);
      const { deleteDuplicatePhotos } = require('../../src/services/externalPhotoDedupe');
      await deleteDuplicatePhotos(db, doomed);
      expect(await db('photos').where({ id: duplicate }).first()).toBeUndefined();
      expect(await keysUnder(`hls/${duplicate}`)).toEqual([]);
      expect(await keysUnder(`hls/${survivor}`)).toHaveLength(4);
    }, 120000);

    test('a bulk delete sweeps a ladder published while it was removing the batch\'s files', async () => {
      // The rows are read first and deleted after every file of the batch
      // is gone, minutes later for a large one: long enough for the queue to
      // give a video its first ladder.
      const { assignAdminRole, mintAdminToken } = require('../integration/helpers/crmDb');
      const adminId = unwrap(await db('admin_users').insert({
        username: 'hls-admin', email: 'hls-admin@example.com', password_hash: 'x',
        must_change_password: false, created_at: new Date().toISOString(),
      }).returning('id'));
      await assignAdminRole(db, adminId);
      const admin = express();
      admin.use(express.json());
      admin.use(cookieParser());
      admin.use('/api/admin/photos', require('../../src/routes/adminPhotos'));

      const id = await insertVideo('late-ladder.mp4', { ladder: false });
      const original = storage.delete;
      const remove = jest.spyOn(storage, 'delete').mockImplementation(async function (key) {
        const result = await original.call(this, key);
        const row = await db('photos').where({ id }).first('hls_path');
        if (row && !row.hls_path) await db('photos').where({ id }).update({ hls_status: 'complete', hls_path: await writeLadder(id) });
        return result;
      });
      try {
        const res = await request(admin).post(`/api/admin/photos/${eventId}/photos/bulk-delete`)
          .set('Authorization', `Bearer ${mintAdminToken(adminId)}`).send({ photoIds: [id] });
        expect(res.status).toBe(200);
      } finally {
        remove.mockRestore();
      }
      expect(await db('photos').where({ id }).first()).toBeUndefined();
      expect(await keysUnder(`hls/${id}`)).toEqual([]);
    });

    test('the ladder is swept once the row no longer authorises a worker to publish one', () => {
      // A transcode that overlaps the delete publishes against the row. Swept
      // first, its ladder would land after the sweep and outlive the row.
      const read = file => fs.readFileSync(path.join(__dirname, '../../src', file), 'utf8');
      const admin = read('routes/adminPhotos.js');
      const single = admin.indexOf('await db(\'photos\').where({ id: photoId }).delete();');
      const bulk = admin.indexOf('.whereIn(\'id\', photoIds)\n      .where(\'event_id\', eventId)\n      .delete();');
      const sweeps = [...admin.matchAll(/videoHlsService'\)\.deleteLadder\(photo\)/g)].map(match => match.index);
      expect(single).toBeGreaterThan(0);
      expect(bulk).toBeGreaterThan(single);
      expect(sweeps[0]).toBeGreaterThan(single);
      expect(sweeps[0]).toBeLessThan(bulk);
      expect(sweeps[1]).toBeGreaterThan(bulk);
      const archive = read('services/archiveService.js');
      expect(archive.indexOf('hls_attempt_id: null')).toBeGreaterThan(0);
      expect(archive.indexOf('deleteLadder(photo)')).toBeGreaterThan(archive.indexOf('hls_attempt_id: null'));
      // A replacement resets the row (and with it the claim) before it sweeps:
      // replaced by an image, no later transcode would collect a late ladder.
      const replace = read('services/photoReplacementService.js');
      expect(replace.lastIndexOf('.update(updates)')).toBeGreaterThan(0);
      expect(replace.indexOf('deleteLadder(existingPhoto)')).toBeGreaterThan(replace.lastIndexOf('.update(updates)'));
    });

    test('every path that removes a video or its file names the ladder', () => {
      const read = file => fs.readFileSync(path.join(__dirname, '../../src', file), 'utf8');
      expect(read('routes/adminPhotos.js').match(/videoHlsService'\)\.deleteLadder\(photo\)/g)).toHaveLength(2);
      for (const file of ['routes/adminEvents/helpers.js', 'services/archiveService.js', 'services/photoReplacementService.js', 'services/fileWatcher.js', 'services/externalPhotoDedupe.js']) {
        expect(read(file)).toMatch(/deleteLadder\(/);
      }
    });
  });
});
