/**
 * The website's draft (issue 2618): the editor's state, saving against a
 * revision, what a document may reference, publishing, the preview, and
 * showing the website at the site root.
 */
const { db } = require('../../database/db');
const { getAppSettings, upsertAppSetting } = require('../../utils/appSettings');
const { formatBoolean } = require('../../utils/dbCompat');
const { AppError } = require('../../utils/errors');
const { getFrontendBaseUrl } = require('../../utils/frontendUrl');
const { canAccessEvent } = require('../../middleware/ownership');
const { userHasAllPermissions } = require('../../middleware/permissions');
const publicSite = require('../publicSiteService');
const { normalizeDocument, collectReferences, LIMIT_CODES } = require('./document');
const media = require('./media');
const { livePhotos } = require('../../utils/photoVisibility');
const { renderPage } = require('./renderer');
const { flag } = require('./validators');
const { clearWebsiteCache } = require('./cache');
const { parseDocument, readRow } = require('./rows');
const { legacySite, initialDocument, legacyLandingLive, importRefusal } = require('./legacyLanding');
const { buildContext } = require('./context');

async function cmsSlugs() {
  return db('cms_pages').pluck('slug');
}

function rowSummary(row) {
  if (!row) return null;
  return {
    revision: Number(row.revision),
    publishedAt: row.published_at || null,
  };
}

/**
 * Show the website at the site root, or not (general_public_site_enabled,
 * which also switches the single-page landing page). On needs something to
 * show: a published website, or a landing page the install uses; the
 * untouched template is not it.
 */
async function setSiteVisible(enabled) {
  if (enabled && !(await readRow('published')) && !(await legacySite()).used) {
    throw new AppError('Publish the website first: there is nothing to show yet', 409, 'WEBSITE_NOTHING_TO_SHOW');
  }
  await upsertAppSetting('general_public_site_enabled', JSON.stringify(formatBoolean(enabled)), 'general');
  publicSite.clearPublicSiteCache();
}

/** The draft, created on first use (with the legacy import). */
async function ensureDraft(adminId = null) {
  const existing = await readRow('draft');
  if (existing) return existing;
  const { document: raw, imported } = await initialDocument();
  const { document } = normalizeDocument(raw);
  try {
    await db('website_documents').insert({
      state: 'draft',
      document: JSON.stringify(document),
      revision: 1,
      updated_by: adminId,
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    // A concurrent first open inserted it first (state is unique).
    const raced = await readRow('draft');
    if (raced) return raced;
    throw err;
  }
  if (imported) {
    require('../../utils/logger').info('Website builder: imported the single-page public site into the draft');
  }
  return readRow('draft');
}

/** The branding's colours, as swatches for a custom block background. */
async function brandColors() {
  const c = (await publicSite.fetchBrandingContext()).colors || {};
  const colours = [c.primary, c.accent, c.accentDark, c.background, c.surface, c.text]
    .filter((value) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value))
    .map((value) => value.toLowerCase());
  return [...new Set(colours)];
}

/**
 * The editor's state for a given draft row. A save or publish passes the
 * row it wrote, so its answer is exactly that, never a draft another editor
 * saved a moment later.
 */
async function editorState(draft, published) {
  const settings = await getAppSettings(['general_public_site_enabled']);
  return {
    // As the editor saves it: normalised, its defaults filled in.
    document: normalizeDocument(parseDocument(draft) || {}).document,
    draft: rowSummary(draft),
    published: rowSummary(published),
    hasUnpublishedChanges: !published || published.document !== draft.document,
    // Publishing changes nothing visible while the public site is off.
    publicSiteEnabled: flag(settings.general_public_site_enabled),
    legacyImportRefused: await importRefusal({ published }),
    // Migration 381 imported the landing page, which `/` still serves.
    legacyLandingLive: await legacyLandingLive(published),
    // The public origin the sitemap and the canonical links use, for the
    // editor's "Open site"; '' when none is configured.
    publicUrl: await getFrontendBaseUrl().catch(() => ''),
    brandColors: await brandColors(),
  };
}

/**
 * The editor's state. Opening it writes the first draft (with the legacy
 * import) only for an admin who may change the website: a view-only admin
 * sees the starting document, and nothing is stored until an editor opens
 * or saves it.
 */
async function getEditorState(adminId) {
  let draft = await readRow('draft');
  if (!draft && await userHasAllPermissions(adminId, ['cms.edit'])) draft = await ensureDraft(adminId);
  if (!draft) {
    const { document } = normalizeDocument((await initialDocument()).document);
    draft = { document: JSON.stringify(document), revision: 1, updated_at: null };
  }
  return editorState(draft, await readRow('published'));
}

/** A refusal that says what it refused: `details`, which the editor shows per item. */
function refusal(message, status, code, details) {
  const err = new AppError(message, status, code);
  err.details = details;
  return err;
}

function validationError(errors) {
  if (errors.some((e) => e.code === 'TOO_MANY_CONTACT_FORMS')) {
    return refusal('A page can have one contact form; remove the second one, or move it to another page', 400, 'WEBSITE_ONE_CONTACT_FORM', errors);
  }
  // Over a limit: refused as too large, never shortened behind the admin's back.
  return errors.some((e) => LIMIT_CODES.has(e.code))
    ? refusal('The website is over a size limit (pages, blocks, items or text length); nothing was saved', 400, 'WEBSITE_LIMIT_EXCEEDED', errors)
    : refusal('The website has problems to fix before it can be saved', 422, 'WEBSITE_INVALID', errors);
}

/** Photos, galleries and packages the stored draft or published site already use. */
async function storedReferences() {
  const photoIds = new Set();
  const eventIds = new Set();
  const packageIds = new Set();
  for (const row of await db('website_documents').select('document')) {
    const raw = parseDocument(row);
    if (!raw) continue;
    const refs = collectReferences(normalizeDocument(raw).document);
    refs.photoIds.forEach((id) => photoIds.add(id));
    refs.eventIds.forEach((id) => eventIds.add(id));
    refs.packageIds.forEach((id) => packageIds.add(id));
  }
  return { photoIds, eventIds, packageIds };
}

/**
 * The photos and galleries an admin may reference: those of galleries they
 * may act on (owner, assigned, or a role that manages every gallery — the
 * rule of the admin gallery and photo routes), plus whatever the stored
 * site already uses, so a colleague can edit a page that shows a pick they
 * could not have made themselves.
 */
async function referencesAdminMay(admin, { photoIds = [], eventIds = [] }, stored) {
  const kept = stored || await storedReferences();
  // A photo in the trash is not offered for a new pick.
  const photoRows = photoIds.length ? await livePhotos(db).whereIn('id', photoIds).select('id', 'event_id') : [];
  const candidates = [...new Set([...eventIds, ...photoRows.map((p) => p.event_id)])];
  const events = candidates.length ? await db('events').whereIn('id', candidates) : [];
  const accessible = new Set(events.filter((e) => canAccessEvent(admin, e)).map((e) => e.id));
  const photoEvent = new Map(photoRows.map((p) => [p.id, p.event_id]));
  return {
    photoIds: new Set(photoIds.filter((id) => kept.photoIds.has(id) || accessible.has(photoEvent.get(id)))),
    eventIds: new Set(eventIds.filter((id) => kept.eventIds.has(id) || accessible.has(id))),
  };
}

function revisionConflict() {
  return new AppError('The website was changed elsewhere. Reload to get the latest version.', 409, 'WEBSITE_REVISION_CONFLICT');
}

/**
 * What a document may reference, for this admin, against what the stored
 * site (`stored`, storedReferences) already uses. Throws the first refusal.
 */
async function assertReferencesAllowed(admin, refs, stored) {
  const allowed = await referencesAdminMay(admin, refs, stored);
  const refused = [
    ...refs.photoIds.filter((id) => !allowed.photoIds.has(id)).map((id) => ({ code: 'PHOTO_NOT_ACCESSIBLE', photoId: id })),
    ...refs.eventIds.filter((id) => !allowed.eventIds.has(id)).map((id) => ({ code: 'GALLERY_NOT_ACCESSIBLE', eventId: id })),
  ];
  if (refused.length) throw refusal('The page uses photos or galleries you cannot access', 422, 'WEBSITE_REFERENCE_NOT_ACCESSIBLE', refused);
  // A new pick comes from a gallery that is on the website now, for its
  // owner too: they put the gallery on first, then pick. Picks already
  // stored stay when their gallery goes off (the page leaves them out).
  const newPhotoIds = refs.photoIds.filter((id) => !stored.photoIds.has(id));
  const newEventIds = refs.eventIds.filter((id) => !stored.eventIds.has(id));
  const pickedFrom = newPhotoIds.length ? await livePhotos(db).whereIn('id', newPhotoIds).pluck('event_id') : [];
  const sourceIds = [...new Set([...pickedFrom, ...newEventIds])];
  const sources = sourceIds.length ? await db('events').whereIn('id', sourceIds) : [];
  const off = sources.filter((event) => !media.isEventWebsiteEligible(event));
  if (off.length) {
    throw refusal(`Put the gallery on the website first: ${off.map((event) => event.event_name).join(', ')}`, 409, 'WEBSITE_GALLERY_NOT_ON_WEBSITE',
      off.map((event) => ({ code: 'GALLERY_NOT_ON_WEBSITE', eventId: event.id, name: event.event_name, reason: media.eventIneligibleReason(event) })));
  }
  // Packages come from the quote catalogue (quotes.view). Without it an
  // admin keeps the ones the site has, and adds none: the public page would
  // show the catalogue to them by a guessed id.
  const newPackages = refs.packageIds.filter((id) => !stored.packageIds.has(id));
  if (newPackages.length && !(await userHasAllPermissions(admin.id, ['quotes.view']))) {
    throw refusal('Adding packages needs the permission to view quotes', 403, 'WEBSITE_PACKAGES_FORBIDDEN',
      newPackages.map((id) => ({ code: 'PACKAGE_NOT_ALLOWED', packageId: id })));
  }
}

async function saveDraft(rawDocument, expectedRevision, admin) {
  const adminId = admin.id;
  const { document, errors } = normalizeDocument(rawDocument, { reservedSlugs: await cmsSlugs() });
  if (errors.length) throw validationError(errors);
  await assertReferencesAllowed(admin, collectReferences(document), await storedReferences());
  const current = await ensureDraft(adminId);
  if (expectedRevision != null && Number(expectedRevision) !== Number(current.revision)) {
    throw revisionConflict();
  }
  const written = {
    state: 'draft',
    document: JSON.stringify(document),
    revision: Number(current.revision) + 1,
    updated_by: adminId,
    updated_at: new Date().toISOString(),
  };
  const updated = await db('website_documents')
    .where({ state: 'draft', revision: current.revision })
    .update({ document: written.document, revision: written.revision, updated_by: adminId, updated_at: written.updated_at });
  if (!updated) {
    throw revisionConflict();
  }
  return editorState(written, await readRow('published'));
}

/**
 * Publish the draft revision the editor last saved: copy it into the
 * published row. One transaction: visitors see the old site or the new one,
 * never a mix. `expectedRevision` is required: without it a publish could go
 * out with whatever another editor saved since. The draft is validated
 * again, since a CMS page may have taken a slug since it was saved.
 */
async function publish(expectedRevision, adminId) {
  if (expectedRevision == null || !Number.isInteger(Number(expectedRevision))) {
    throw new AppError('Say which saved revision to publish', 400, 'WEBSITE_REVISION_REQUIRED');
  }
  const reserved = await cmsSlugs();
  const result = await db.transaction(async (trx) => {
    // On PostgreSQL the draft row is locked, so concurrent publishes (and a
    // save) wait for this one; SQLite serialises writers anyway.
    const draftQuery = trx('website_documents').where({ state: 'draft' });
    if (trx.client.config.client === 'pg') draftQuery.forUpdate();
    const draft = await draftQuery.first();
    if (!draft) throw new AppError('There is nothing to publish yet', 404, 'WEBSITE_NO_DRAFT');
    if (Number(expectedRevision) !== Number(draft.revision)) throw revisionConflict();
    const { errors } = normalizeDocument(parseDocument(draft), { reservedSlugs: reserved });
    if (errors.length) throw validationError(errors);
    const now = new Date().toISOString();
    const values = {
      document: draft.document,
      revision: draft.revision,
      updated_by: adminId,
      updated_at: now,
      published_at: now,
    };
    const existing = await readRow('published', trx);
    if (!existing) {
      await trx('website_documents').insert({ state: 'published', ...values });
    } else {
      // Never put an older revision over a newer published one.
      const written = await trx('website_documents')
        .where({ state: 'published' })
        .where('revision', '<=', draft.revision)
        .update(values);
      if (!written) throw revisionConflict();
    }
    return { draft, published: { state: 'published', ...values } };
  });
  clearWebsiteCache();
  return editorState(result.draft, result.published);
}

async function renderPreview(rawDocument, pageId, admin, { videoAsPoster = false } = {}) {
  const { document } = normalizeDocument(rawDocument);
  const page = document.pages.find((p) => p.id === pageId) || document.pages[0];
  if (!page) throw new AppError('The website has no pages', 422, 'WEBSITE_INVALID');
  const allowed = await referencesAdminMay(admin, collectReferences({ pages: [page] }));
  // The catalogue's details are the quotes' (quotes.view, as the catalogue
  // itself): without it the preview leaves the packages out.
  const packages = await userHasAllPermissions(admin.id, ['quotes.view']);
  return renderPage({ ...(await buildContext(document, page, { preview: true, allowed, packages })), videoAsPoster });
}

module.exports = { getEditorState, saveDraft, publish, renderPreview, referencesAdminMay, setSiteVisible };
