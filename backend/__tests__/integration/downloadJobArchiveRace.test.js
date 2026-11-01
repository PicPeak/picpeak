/**
 * A prepared download that was queued or building when its gallery was
 * archived kept running. The archive only failed the gallery's ready jobs,
 * so the build finished afterwards, uploaded its zip into the deleted
 * download cache and marked the job ready (issue 2214).
 *
 * The build is held at one step (its upload, or a photo read) while the
 * archive runs, then let go.
 */

// Lets a test hold a resized build between two photos.
let mockBeforeResize = null;
jest.mock('../../src/services/imageProcessor', () => {
  const actual = jest.requireActual('../../src/services/imageProcessor');
  return {
    ...actual,
    resizeToBox: async (...args) => {
      if (mockBeforeResize) await mockBeforeResize();
      return actual.resizeToBox(...args);
    },
  };
});

jest.mock('../../src/services/emailProcessor', () => ({
  queueEmail: jest.fn(async () => undefined),
  getSupportEmail: jest.fn(async () => 'support@example.com'),
}));

describe('download job built during an archive', () => {
  let db; let cleanup; let storage; let archiveEvent; let downloadJobService; let downloadZipService;

  const unwrap = (rows) => (typeof rows[0] === 'object' && rows[0] !== null ? rows[0].id : rows[0]);

  beforeAll(async () => {
    ({ db, cleanup } = await require('./helpers/crmDb').bootCrmDb());
    storage = require('../../src/services/storage').getStorage();
    ({ archiveEvent } = require('../../src/services/archiveService'));
    downloadJobService = require('../../src/services/downloadJobService');
    downloadZipService = require('../../src/services/downloadZipService');
  }, 180000);

  afterAll(async () => {
    if (downloadZipService) await downloadZipService.stop();
    if (cleanup) await cleanup();
  });

  beforeEach(() => {
    require('../../src/database/crmAccess').enterTrustedCrmFixtureContext();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    mockBeforeResize = null;
  });

  const jpeg = () => require('sharp')({
    create: { width: 64, height: 64, channels: 3, background: '#808080' },
  }).jpeg().toBuffer();

  async function makeEvent(slug, photoCount) {
    const id = unwrap(await db('events').insert({
      slug,
      event_type: 'wedding',
      event_name: `Race ${slug}`,
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      password_hash: 'x',
      share_link: `/gallery/${slug}/share`,
      share_token: `${slug}-share`,
      expires_at: new Date(Date.now() - 864e5).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      allow_downloads: 1,
      created_at: new Date().toISOString(),
    }).returning('id'));
    for (let i = 0; i < photoCount; i += 1) {
      const filename = `photo-${i}.jpg`;
      const key = `events/active/${slug}/individual/${filename}`;
      const bytes = await jpeg();
      await storage.put(key, bytes, { contentType: 'image/jpeg' });
      await db('photos').insert({
        event_id: id, filename, path: key, type: 'individual', size_bytes: bytes.length,
        source_origin: 'managed', mime_type: 'image/jpeg',
        uploaded_at: new Date(Date.now() - i * 1000).toISOString(),
      });
    }
    return id;
  }

  /** A gate builds wait at; `reached(n)` resolves once n of them are waiting. */
  function gate() {
    let open;
    const opened = new Promise((r) => { open = r; });
    const waiters = [];
    let count = 0;
    return {
      open,
      wait: () => {
        count += 1;
        waiters.splice(0).forEach((w) => w());
        return opened;
      },
      reached: (n = 1) => new Promise((r) => {
        const check = () => (count >= n ? r() : waiters.push(check));
        check();
      }),
    };
  }

  function holdJobUploads() {
    const upload = gate();
    const realPut = storage.put.bind(storage);
    jest.spyOn(storage, 'put').mockImplementation(async (key, ...rest) => {
      if (key.includes('/.download-cache/job-')) await upload.wait();
      return realPut(key, ...rest);
    });
    return upload;
  }

  async function startJob(id, resolution = 'original') {
    const event = await db('events').where({ id }).first();
    const job = await downloadJobService.createJob({ event, resolution, photoIds: null, accessLevel: 'guest' });
    return { job, build: downloadJobService.liveBuilds.get(job.id) };
  }

  async function archive(id) {
    await archiveEvent(await db('events').where({ id }).first());
    expect((await db('events').where({ id }).first()).is_archived).toBeTruthy();
  }

  async function expectCancelled(job, slug) {
    const row = await db('download_jobs').where({ id: job.id }).first();
    expect(row.status).toBe('failed');
    expect(row.error).toBe('The gallery was archived, please request the download again');
    expect(await storage.exists(downloadJobService.jobKey(slug, job.token))).toBe(false);
  }

  it('drops the zip of a job that was uploading during the archive', async () => {
    const slug = 'race-upload';
    const id = await makeEvent(slug, 3);
    const upload = holdJobUploads();

    const { job, build } = await startJob(id);
    await upload.reached();
    await archive(id);
    upload.open();
    await build;

    await expectCancelled(job, slug);
  });

  it('stops a job that was reading photos during the archive', async () => {
    const slug = 'race-partial';
    const id = await makeEvent(slug, 3);
    const read = gate();
    let resizes = 0;
    mockBeforeResize = async () => {
      resizes += 1;
      if (resizes === 1) await read.wait();
    };

    const { job, build } = await startJob(id, '32x32');
    await read.reached();
    await archive(id);
    read.open();
    await build;

    await expectCancelled(job, slug);
  });

  it('deletes the zip of a job that went ready after the archive listed the files', async () => {
    const slug = 'race-listed';
    const id = await makeEvent(slug, 3);
    const upload = holdJobUploads();

    const { job, build } = await startJob(id);
    await upload.reached();

    const realList = storage.list.bind(storage);
    jest.spyOn(storage, 'list').mockImplementation(async (prefix, ...rest) => {
      const entries = await realList(prefix, ...rest);
      if (prefix === `events/active/${slug}`) {
        upload.open();
        await build;
        expect((await db('download_jobs').where({ id: job.id }).first()).status).toBe('ready');
      }
      return entries;
    });
    await archive(id);

    await expectCancelled(job, slug);
  });

  it('never starts a job that was queued during the archive', async () => {
    const slug = 'race-queued';
    const id = await makeEvent(slug, 2);
    const otherIds = [await makeEvent('race-busy-1', 1), await makeEvent('race-busy-2', 1)];
    const upload = holdJobUploads();

    // Two builds of other galleries take both build slots.
    const busy = [await startJob(otherIds[0]), await startJob(otherIds[1])];
    await upload.reached(2);
    const { job, build } = await startJob(id);
    expect((await db('download_jobs').where({ id: job.id }).first()).status).toBe('pending');

    await archive(id);
    upload.open();
    await Promise.all([build, ...busy.map((b) => b.build)]);

    await expectCancelled(job, slug);
    for (const b of busy) {
      expect((await db('download_jobs').where({ id: b.job.id }).first()).status).toBe('ready');
    }
  });
});
