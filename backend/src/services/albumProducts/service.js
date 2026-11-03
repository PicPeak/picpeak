'use strict';
const crypto = require('crypto');
const V = require('./validation');
const G = require('./library');
const P = require('./photos');
const {
  formatBoolean,
  parseBoolean: normalizeBoolean,
} = require('../../utils/dbCompat');
const {
  AppError,
  ConflictError,
  NotFoundError,
  ForbiddenError,
} = require('../../utils/errors');
/** Database/storage injection keeps the domain portable and contract-testable. */
function createService({ db, storage, sharp }) {
  const timestamp = () => new Date().toISOString();
  async function catalogue() {
    const row = await db('album_product_catalogue').where({ id: 1 }).first();
    return {
      revision: row?.revision || 0,
      products: V.parse(row?.products || '[]'),
      library: V.parse(row?.library || '[]'),
      types: V.parse(row?.types || '[]'),
    };
  }
  async function saveCatalogue(input) {
    if (!input || typeof input !== 'object')
      throw new AppError('Invalid catalogue', 400);
    const products = V.products(input.products);
    const previous = await catalogue();
    const library = G.cleanLibrary(input.library ?? previous.library);
    const types = G.cleanTypes(input.types ?? previous.types, library);
    for (const p of products) {
      if (p.typeId && !types.some((t) => t.id === p.typeId))
        throw new AppError('Unknown product type', 400);
      if (p.guided && p.active) G.assertGuided(p, types);
    }
    V.revision(input.revision);
    const imageIds = [
      ...new Set([
        ...library
          .flatMap((g) => g.options)
          .map((o) => o.imageId)
          .filter(Boolean),
        ...products.flatMap((p) =>
          [...(p.models || []), ...(p.colours || []), { imageId: p.heroImageId }]
            .map((o) => o.imageId)
            .filter(Boolean),
        ),
      ]),
    ];
    const images = imageIds.length
      ? await db('album_product_images').whereIn('id', imageIds)
      : [];
    if (images.length !== imageIds.length)
      throw new AppError('An option image is unavailable', 400);
    for (const image of images)
      if (!(await storage.stat(image.storage_key)))
        throw new ConflictError('An option image is missing; upload it again');
    await db.transaction(async (tx) => {
      // Older portable backups predate this singleton. Recreate the empty seed.
      await tx('album_product_catalogue')
        .insert({ id: 1, revision: 0, products: '[]', updated_at: timestamp() })
        .onConflict('id')
        .ignore();
      const row = await tx('album_product_catalogue')
        .where({ id: 1 })
        .forUpdate()
        .first();
      if (row.revision !== input.revision)
        throw new ConflictError(
          'The catalogue changed in another window; reload before saving',
        );
      await tx('album_product_catalogue')
        .where({ id: 1 })
        .update({
          revision: row.revision + 1,
          products: JSON.stringify(products),
          library: JSON.stringify(library),
          types: JSON.stringify(types),
          updated_at: timestamp(),
        });
    });
    return catalogue();
  }
  async function uploadImage(bytes, adminId) {
    if (
      !Buffer.isBuffer(bytes) ||
      bytes.length > 6 * 1024 * 1024 ||
      !bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new AppError('Upload a PNG image up to 6 MB', 400);
    const metadata = await sharp(bytes).metadata();
    if (
      metadata.format !== 'png' ||
      !metadata.width ||
      !metadata.height ||
      metadata.width * metadata.height > 16e6 ||
      (metadata.pages || 1) > 1
    )
      throw new AppError('Use a single PNG image up to 16 megapixels', 400);
    const image = await sharp(bytes)
      .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
    const dimensions = await sharp(image).metadata(),
      id = crypto.randomUUID(),
      key = `album-products/${id}.png`;
    await storage.put(key, image, {
      contentType: 'image/png',
      cacheControl: 'private, no-store',
    });
    try {
      await db('album_product_images').insert({
        id,
        storage_key: key,
        sha256: V.hash(image),
        width: dimensions.width,
        height: dimensions.height,
        created_by: adminId,
        created_at: timestamp(),
      });
    } catch (error) {
      await storage.delete(key).catch(() => {});
      throw error;
    }
    return { id, width: dimensions.width, height: dimensions.height };
  }
  async function image(id) {
    const row = await db('album_product_images')
      .where({ id: V.uuid(id) })
      .first();
    if (!row) throw new NotFoundError('Image');
    return row;
  }
  function shape(row) {
    return {
      id: row.id,
      productId: row.product_id,
      enabled: row.enabled === true || row.enabled === 1,
      cataloguePresetId: row.catalogue_preset_id || null,
      customerId: row.billing_customer_id || null,
      releasedCustomerId: row.released_customer_id ?? null,
      showPrices: normalizeBoolean(row.show_prices),
      revision: row.revision,
      status: row.status,
      selection: V.parse(row.selection),
      updatedAt: row.updated_at,
    };
  }
  function clientShape(row) {
    const result = { ...row, selection: P.forClient(row.selection) };
    delete result.customerId;
    delete result.releasedCustomerId;
    delete result.cataloguePresetId;
    return result;
  }
  async function offers(eventId) {
    return P.withAvailability(
      db,
      eventId,
      (
        await db('event_album_products')
          .where({ event_id: eventId })
          .orderBy('created_at')
      ).map(shape),
    );
  }
  const assignedCustomers = async (conn, eventId) =>
    Number(
      (
        await conn('event_customer_assignments')
          .where({ event_id: eventId })
          .count('* as count')
          .first()
      ).count,
    );
  /**
   * Who an offer belongs to. A customer's offer is theirs alone; the rest
   * belongs to the gallery's client, the PIN or its only customer. Where
   * several customers share a gallery none of them is that client: one offer
   * holds one selection, so showing it to all would hand each the other's.
   */
  function reaches(releasedCustomerId, viewer, customers) {
    if (viewer.preview) return true;
    if (releasedCustomerId != null)
      return Number(viewer.customerId) === Number(releasedCustomerId);
    return viewer.customerId == null || customers <= 1;
  }
  async function offer(eventId, id, tx = db) {
    const row = await tx('event_album_products')
      .where({ event_id: eventId, id: V.uuid(id) })
      .first();
    if (!row) throw new NotFoundError('Product offer');
    return row;
  }
  async function assertAssigned(conn, eventId, customerId) {
    if (
      !Number.isSafeInteger(customerId) ||
      !(await conn('event_customer_assignments')
        .where({ event_id: eventId, customer_account_id: customerId })
        .first())
    )
      throw new AppError('Choose a customer assigned to this gallery', 400);
  }
  const forAudience = (query, customerId) =>
    customerId == null
      ? query.whereNull('released_customer_id')
      : query.where({ released_customer_id: customerId });
  async function assign(eventId, productId, customerId = null) {
    const { products } = await catalogue(),
      product = products.find((p) => p.id === productId && p.active);
    if (!product) throw new AppError('Choose an active product', 400);
    if (customerId != null) await assertAssigned(db, eventId, customerId);
    const id = crypto.randomUUID();
    await db('event_album_products')
      .insert({
        id,
        event_id: eventId,
        product_id: product.id,
        released_customer_id: customerId,
        // A guided album waits for the studio's explicit release.
        enabled: !product.guided,
        revision: 1,
        status: 'draft',
        created_at: timestamp(),
        updated_at: timestamp(),
      })
      .onConflict()
      .ignore();
    return shape(
      await forAudience(
        db('event_album_products').where({
          event_id: eventId,
          product_id: product.id,
        }),
        customerId,
      ).first(),
    );
  }
  function selectionCurrent(product, snapshot) {
    if (!snapshot || !product) return false;
    try {
      const next = V.selection(
        product,
        product.attributes
          ? { productVersion: product.version, values: G.valuesOf(snapshot) }
          : {
            productVersion: V.hash(product),
            modelId: snapshot.model.id,
            colourId: snapshot.colour.id,
          },
      );
      return (
        V.hash(
          next.attributes || { model: next.model, colour: next.colour },
        ) ===
        V.hash(
          snapshot.attributes || {
            model: snapshot.model,
            colour: snapshot.colour,
          },
        )
      );
    } catch (_) {
      return false;
    }
  }
  async function clientOffers(eventId, viewer = {}) {
    const catalog = await catalogue(),
      products = catalog.products.map((p) => G.resolve(p, catalog)),
      customers = await assignedCustomers(db, eventId),
      rows = (await offers(eventId)).filter(
        (row) => row.enabled && reaches(row.releasedCustomerId, viewer, customers),
      );
    const priced = await Promise.all(
      rows.map(async (row) => ({
        ...row,
        pricing: await require('./billing').information(db, {
          ...row,
          product_id: row.productId,
          catalogue_preset_id: row.cataloguePresetId,
          show_prices: row.showPrices,
        }),
      })),
    );
    return priced
      .map((row) => {
        const product = products.find(
          (p) => p.id === row.productId && p.active,
        );
        return {
          ...clientShape(row),
          needsReview:
            row.status === 'submitted' &&
            !row.selection?.clientFinal &&
            !selectionCurrent(product, row.selection),
          product: product
            ? product.attributes
              ? product
              : {
                ...product,
                version: V.hash(product),
                models: product.models.filter((o) => o.active),
                colours: product.colours.filter((o) => o.active),
              }
            : null,
        };
      });
  }
  async function history(eventId, id) {
    await offer(eventId, id);
    return (
      await db('album_product_choice_history')
        .where({ offer_id: id })
        .orderBy('revision', 'desc')
        .limit(100)
    ).map((row) => ({ ...row, selection: V.parse(row.selection) }));
  }
  async function record(tx, row, actor, input) {
    await tx('album_product_choice_history').insert({
      id: crypto.randomUUID(),
      offer_id: row.id,
      revision: row.revision,
      mutation_id: V.uuid(input.mutationId),
      status: row.status,
      selection: row.selection,
      actor_type: actor.type,
      actor_id: actor.id == null ? null : String(actor.id),
      actor_name: actor.name || null,
      customer_account_id: actor.customerId ?? null,
      created_at: timestamp(),
    });
  }
  /** One binding album per client: another tab must not confirm a second. */
  async function assertNoOtherConfirmation(tx, current) {
    const others = tx('event_album_products')
      .where({ event_id: current.event_id })
      .whereNot({ id: current.id })
      .whereIn('status', ['submitted', 'locked']);
    // The gallery's only customer is the client of its unscoped offers too. An
    // offer of someone since removed from the gallery is nobody's here.
    const assigned = await tx('event_customer_assignments')
      .where({ event_id: current.event_id })
      .pluck('customer_account_id');
    if (assigned.length > 1) forAudience(others, current.released_customer_id ?? null);
    else others.where((q) => q.whereNull('released_customer_id').orWhereIn('released_customer_id', assigned));
    if ((await others).some((row) => V.parse(row.selection)?.clientFinal))
      throw new ConflictError('Another album is already confirmed for this gallery');
  }
  async function mutate(event, input, actor, { admin = false, viewer = {} } = {}) {
    V.revision(input.revision);
    V.uuid(input.mutationId);
    const outcome = (row) => (admin ? shape(row) : clientShape(shape(row)));
    return db.transaction(async (tx) => {
      // Catalogue precedes offer in the shared lock order for writes.
      const catalog = await tx('album_product_catalogue')
        .where({ id: 1 })
        .forUpdate()
        .first();
      const current = await tx('event_album_products')
        .where({ event_id: event.id, id: V.uuid(input.id) })
        .forUpdate()
        .first();
      if (!current) throw new NotFoundError('Product offer');
      // Before the replay answer, which carries the selection: a retry is no
      // way around another customer's offer or a withdrawn release.
      if (!admin) {
        const customers = await assignedCustomers(tx, event.id);
        if (!reaches(current.released_customer_id, viewer, customers))
          throw new NotFoundError('Product offer');
        if (!normalizeBoolean(current.enabled))
          throw new ForbiddenError('This choice is locked or unavailable');
      }
      const replay = await tx('album_product_choice_history')
        .where({ offer_id: current.id, mutation_id: input.mutationId })
        .first();
      if (replay) {
        if (
          replay.actor_type !== actor.type ||
          replay.actor_id !== String(actor.id ?? '')
        )
          throw new ConflictError('This request identifier was already used');
        return outcome(current);
      }
      if (current.revision !== input.revision)
        throw new ConflictError(
          'This choice changed in another window; reload before saving',
        );
      const product = G.resolve(
        V.parse(catalog.products).find((p) => p.id === current.product_id),
        { library: V.parse(catalog.library), types: V.parse(catalog.types) },
      );
      const update = {
        revision: current.revision + 1,
        updated_at: timestamp(),
      };
      const reopening = admin && input.action === 'reopen';
      if (admin) {
        if (
          input.cataloguePresetId !== undefined ||
          input.showPrices !== undefined ||
          input.customerId !== undefined
        ) {
          if (current.status === 'locked')
            throw new ConflictError(
              'Unlock the choice before changing its pricing settings',
            );
          if (!(await require('./billing').enabled(tx)))
            throw new ForbiddenError('CRM billing is disabled');
          if (input.customerId !== undefined) {
            if (input.customerId !== null)
              await assertAssigned(tx, event.id, input.customerId);
            update.billing_customer_id = input.customerId;
          }
          if (input.cataloguePresetId !== undefined) {
            if (
              input.cataloguePresetId !== null &&
              (!Number.isSafeInteger(input.cataloguePresetId) ||
                input.cataloguePresetId < 1)
            )
              throw new AppError('Invalid catalogue item', 400);
            const preset =
              input.cataloguePresetId &&
              (await tx('quote_line_item_presets')
                .where({
                  id: input.cataloguePresetId,
                  product_id: current.product_id,
                })
                .first());
            if (
              input.cataloguePresetId &&
              (!preset || !normalizeBoolean(preset.is_active))
            )
              throw new AppError(
                'Choose an active catalogue item for this product',
                400,
              );
            update.catalogue_preset_id = input.cataloguePresetId;
          }
          if (input.showPrices !== undefined) {
            if (typeof input.showPrices !== 'boolean')
              throw new AppError('Invalid price display setting', 400);
            update.show_prices = formatBoolean(input.showPrices);
          }
        } else if (
          input.releasedCustomerId !== undefined ||
          typeof input.enabled === 'boolean'
        ) {
          if (
            input.releasedCustomerId !== undefined &&
            input.releasedCustomerId !== (current.released_customer_id ?? null)
          ) {
            // The selection belongs to whoever made it. Changing the audience
            // would show it to someone else.
            if (current.selection)
              throw new ConflictError(
                'This offer already holds a choice; add a new offer for the other customer',
              );
            if (input.releasedCustomerId !== null)
              await assertAssigned(tx, event.id, input.releasedCustomerId);
            if (
              await forAudience(
                tx('event_album_products')
                  .where({ event_id: event.id, product_id: current.product_id })
                  .whereNot({ id: current.id }),
                input.releasedCustomerId,
              ).first()
            )
              throw new ConflictError(
                'This customer already has an offer for this product',
              );
            update.released_customer_id = input.releasedCustomerId;
          }
          if (typeof input.enabled === 'boolean')
            update.enabled = formatBoolean(input.enabled);
        } else if (input.action === 'unlock' && current.status === 'locked')
          update.status = 'submitted';
        else if (
          reopening &&
          ['submitted', 'locked'].includes(current.status) &&
          V.parse(current.selection)?.clientFinal
        )
          update.status = 'draft';
        else if (
          input.action === 'lock' &&
          current.status === 'submitted' &&
          current.selection
        ) {
          const snapshot = V.parse(current.selection);
          const checked = V.selection(
            product,
            product.attributes
              ? {
                productVersion: product.version,
                values: G.valuesOf(snapshot),
              }
              : {
                productVersion: V.hash(product),
                modelId: snapshot.model.id,
                colourId: snapshot.colour.id,
              },
          );
          const chosen = (s) =>
            s.attributes || { model: s.model, colour: s.colour };
          if (V.hash(chosen(checked)) !== V.hash(chosen(snapshot)))
            throw new ConflictError(
              'The selected options changed; ask the client to review them',
            );
          update.status = 'locked';
        } else throw new AppError('This choice cannot move to that state', 409);
      } else {
        if (current.status === 'locked')
          throw new ForbiddenError('This choice is locked or unavailable');
        if (current.status === 'submitted' && V.parse(current.selection)?.clientFinal)
          throw new ForbiddenError('This selection is confirmed; contact the studio to change it');
        if (current.status === 'submitted' && input.submit !== true)
          throw new ConflictError(
            'A submitted choice must be resubmitted, not saved as a draft',
          );
        const complete = input.submit === true;
        // Only a guided draft may be saved before the client signs it.
        if (!actor.name && (complete || !product?.guided))
          throw new AppError('A name is required', 400);
        const selected = product?.attributes
          ? G.selection(product, input, { complete })
          : V.selection(product, input);
        if (product?.guided) {
          selected.photoRoles = await P.select(tx, event.id, product.guided, input.photoRoles, { complete });
          if (complete && product.guided.clientFinal) {
            await assertNoOtherConfirmation(tx, current);
            selected.clientFinal = true;
            selected.confirmedAt = timestamp();
          }
        } else if (input.photoRoles !== undefined)
          throw new AppError('This product takes no photos', 400);
        update.selection = JSON.stringify(selected);
        update.status = complete ? 'submitted' : 'draft';
      }
      if (
        Object.entries(update).every(
          ([key, value]) =>
            ['revision', 'updated_at'].includes(key) ||
            (['enabled', 'show_prices'].includes(key)
              ? normalizeBoolean(current[key]) === normalizeBoolean(value)
              : current[key] === value),
        )
      )
        return outcome(current);
      const next = { ...current, ...update };
      if (admin && update.status === 'locked')
        await require('./billing').lock(tx, next, event.id, actor.id);
      if (
        admin &&
        current.status === 'locked' &&
        ['submitted', 'draft'].includes(update.status)
      )
        await require('./billing').unlock(tx, current);
      await tx('event_album_products').where({ id: current.id }).update(update);
      await record(tx, next, actor, input);
      if (!admin && update.status === 'submitted') {
        // Native bell/audit entry in the same transaction: a replay cannot notify twice.
        await require('../../database/db').logActivity(
          'album_product_submitted',
          {
            eventName: event.event_name,
            productName: product.name,
            choice: G.summary(V.parse(update.selection)),
          },
          event.id,
          actor,
          tx,
        );
      }
      if (admin) {
        const audit = [
          current.status === 'locked' && update.status === 'submitted'
            ? 'album_product_unlocked'
            : reopening
              ? 'album_product_reopened'
              : null,
          update.enabled === undefined ||
          normalizeBoolean(update.enabled) === normalizeBoolean(current.enabled)
            ? null
            : normalizeBoolean(update.enabled)
              ? 'album_product_released'
              : 'album_product_withdrawn',
        ].filter(Boolean);
        for (const type of audit)
          await require('../../database/db').logActivity(
            type,
            {
              eventName: event.event_name,
              productName: V.parse(current.selection)?.product?.name || product?.name,
              offerId: current.id,
              previousStatus: current.status,
              choice: G.summary(V.parse(current.selection)),
              customerId: next.released_customer_id ?? null,
            },
            event.id,
            actor,
            tx,
          );
      }
      return outcome(next);
    });
  }
  async function clientImage(eventId, id, viewer = {}) {
    V.uuid(id);
    const rows = await clientOffers(eventId, viewer);
    const allowed = rows.some((row) =>
      [
        { imageId: row.product?.heroImageId },
        ...(row.product?.attributes?.flatMap((a) => a.options) || []),
        ...(row.selection?.attributes?.flatMap((a) => a.options) || []),
        ...(row.product?.models || []),
        ...(row.product?.colours || []),
        row.selection?.model,
        row.selection?.colour,
      ].some((o) => o?.imageId === id),
    );
    if (!allowed) throw new NotFoundError('Image');
    return image(id);
  }
  return {
    catalogue,
    saveCatalogue,
    uploadImage,
    image,
    offers,
    offer,
    assign,
    clientOffers,
    history,
    mutate,
    clientImage,
  };
}
function application() {
  return createService({
    db: require('../../database/db').db,
    storage: require('../storage').getStorage(),
    sharp: require('../isolatedSharp'),
  });
}
module.exports = { createService, application };
