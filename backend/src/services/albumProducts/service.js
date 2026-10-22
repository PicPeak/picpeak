'use strict';
const crypto = require('crypto');
const V = require('./validation');
const G = require('./library');
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
    for (const p of products)
      if (p.typeId && !types.some((t) => t.id === p.typeId))
        throw new AppError('Unknown product type', 400);
    V.revision(input.revision);
    const imageIds = [
      ...new Set([
        ...library
          .flatMap((g) => g.options)
          .map((o) => o.imageId)
          .filter(Boolean),
        ...products.flatMap((p) =>
          [...(p.models || []), ...(p.colours || [])]
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
      showPrices: normalizeBoolean(row.show_prices),
      revision: row.revision,
      status: row.status,
      selection: V.parse(row.selection),
      updatedAt: row.updated_at,
    };
  }
  async function offers(eventId) {
    return (
      await db('event_album_products')
        .where({ event_id: eventId })
        .orderBy('created_at')
    ).map(shape);
  }
  async function offer(eventId, id, tx = db) {
    const row = await tx('event_album_products')
      .where({ event_id: eventId, id: V.uuid(id) })
      .first();
    if (!row) throw new NotFoundError('Product offer');
    return row;
  }
  async function assign(eventId, productId) {
    const { products } = await catalogue(),
      product = products.find((p) => p.id === productId && p.active);
    if (!product) throw new AppError('Choose an active product', 400);
    const id = crypto.randomUUID();
    await db('event_album_products')
      .insert({
        id,
        event_id: eventId,
        product_id: product.id,
        enabled: true,
        revision: 1,
        status: 'draft',
        created_at: timestamp(),
        updated_at: timestamp(),
      })
      .onConflict(['event_id', 'product_id'])
      .ignore();
    return shape(
      await db('event_album_products')
        .where({ event_id: eventId, product_id: product.id })
        .first(),
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
  async function clientOffers(eventId) {
    const catalog = await catalogue(),
      products = catalog.products.map((p) => G.resolve(p, catalog)),
      rows = await offers(eventId);
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
      .filter((row) => row.enabled)
      .map((row) => {
        const product = products.find(
          (p) => p.id === row.productId && p.active,
        );
        return {
          ...row,
          needsReview:
            row.status === 'submitted' &&
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
      created_at: timestamp(),
    });
  }
  async function mutate(event, input, actor, { admin = false } = {}) {
    V.revision(input.revision);
    V.uuid(input.mutationId);
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
      const replay = await tx('album_product_choice_history')
        .where({ offer_id: current.id, mutation_id: input.mutationId })
        .first();
      if (replay) {
        if (
          replay.actor_type !== actor.type ||
          replay.actor_id !== String(actor.id ?? '')
        )
          throw new ConflictError('This request identifier was already used');
        return shape(current);
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
            if (
              input.customerId !== null &&
              (!Number.isSafeInteger(input.customerId) ||
                !(await tx('event_customer_assignments')
                  .where({
                    event_id: event.id,
                    customer_account_id: input.customerId,
                  })
                  .first()))
            )
              throw new AppError(
                'Choose a customer assigned to this gallery',
                400,
              );
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
        } else if (typeof input.enabled === 'boolean')
          update.enabled = formatBoolean(input.enabled);
        else if (input.action === 'unlock' && current.status === 'locked')
          update.status = 'submitted';
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
        if (!current.enabled || current.status === 'locked')
          throw new ForbiddenError('This choice is locked or unavailable');
        if (current.status === 'submitted' && input.submit !== true)
          throw new ConflictError(
            'A submitted choice must be resubmitted, not saved as a draft',
          );
        const selected = product?.attributes
          ? G.selection(product, input, { complete: input.submit === true })
          : V.selection(product, input);
        update.selection = JSON.stringify(selected);
        update.status = input.submit === true ? 'submitted' : 'draft';
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
        return shape(current);
      const next = { ...current, ...update };
      if (admin && update.status === 'locked')
        await require('./billing').lock(tx, next, event.id, actor.id);
      if (admin && update.status === 'submitted' && current.status === 'locked')
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
      return shape(next);
    });
  }
  async function clientImage(eventId, id) {
    V.uuid(id);
    const rows = await clientOffers(eventId);
    const allowed = rows.some((row) =>
      [
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
