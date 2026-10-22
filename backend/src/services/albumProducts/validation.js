'use strict';
const crypto = require('crypto');
const { ValidationError } = require('../../utils/errors');
const fail = (message) => {
  throw new ValidationError(message);
};
const uuid = (value) => {
  if (
    typeof value !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      value,
    )
  )
    fail('Invalid identifier');
  return value;
};
function text(value, max, required = false) {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    Array.from(value).some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  )
    fail('Invalid text');
  const result = value.trim();
  if (required && !result) fail('A name is required');
  return result;
}
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('Invalid revision');
  return value;
}
const parse = (value) =>
  typeof value === 'string' ? JSON.parse(value) : value;
const hash = (value) =>
  crypto
    .createHash('sha256')
    .update(
      typeof value === 'string' || Buffer.isBuffer(value)
        ? value
        : JSON.stringify(value),
    )
    .digest('hex');
/** Only the documented shape reaches persisted catalogue data. */
function products(value) {
  if (!Array.isArray(value) || value.length > 20)
    fail('A catalogue supports at most 20 products');
  const ids = new Set();
  const identify = (id) => {
    uuid(id);
    if (ids.has(id)) fail('Identifiers must be unique');
    ids.add(id);
    return id;
  };
  return value.map((p) => {
    if (!p || typeof p !== 'object' || Array.isArray(p))
      fail('Invalid product');
    if (p.typeId)
      return {
        id: identify(p.id),
        name: text(p.name, 100, true),
        description: text(p.description || '', 1000),
        active: p.active === true,
        typeId: uuid(p.typeId),
      };
    const out = {
      id: identify(p.id),
      name: text(p.name, 100, true),
      description: text(p.description || '', 1000),
      active: p.active === true,
      models: [],
      colours: [],
    };
    if (
      !Array.isArray(p.models) ||
      p.models.length > 20 ||
      !Array.isArray(p.colours) ||
      p.colours.length > 30
    )
      fail('A product supports at most 20 models and 30 colours');
    for (const attribute of ['models', 'colours'])
      out[attribute] = p[attribute].map((option) => {
        if (!option || typeof option !== 'object' || Array.isArray(option))
          fail('Invalid option');
        if (option.modelIds !== undefined && !Array.isArray(option.modelIds))
          fail('Invalid model compatibility list');
        return {
          id: identify(option.id),
          name: text(option.name, 100, true),
          active: option.active === true,
          imageId: option.imageId ? uuid(option.imageId) : null,
          ...(attribute === 'colours'
            ? {
              modelIds: [
                ...new Set(
                  (Array.isArray(option.modelIds) ? option.modelIds : []).map(
                    uuid,
                  ),
                ),
              ],
            }
            : {}),
        };
      });
    const models = new Set(out.models.map((m) => m.id));
    for (const colour of out.colours)
      if (colour.modelIds.some((id) => !models.has(id)))
        fail('A colour refers to an unknown model');
    if (out.active) {
      const activeModels = out.models.filter((o) => o.active),
        activeColours = out.colours.filter((o) => o.active);
      if (!activeModels.length || !activeColours.length)
        fail('An active product needs an active model and colour');
      if ([...activeModels, ...activeColours].some((o) => !o.imageId))
        fail('Every active option needs an image');
      if (
        activeModels.some(
          (model) =>
            !activeColours.some(
              (colour) =>
                !colour.modelIds.length || colour.modelIds.includes(model.id),
            ),
        )
      )
        fail('Every active model needs an available colour');
    }
    return out;
  });
}
function selection(product, input) {
  if (product?.attributes)
    return require('./library').selection(product, input);
  if (!product?.active) fail('This product is unavailable');
  if (input.productVersion !== hash(product))
    fail('The product options changed; review them before saving');
  const model = product.models.find((o) => o.id === input.modelId && o.active),
    colour = product.colours.find((o) => o.id === input.colourId && o.active);
  if (
    !model ||
    !colour ||
    (colour.modelIds.length && !colour.modelIds.includes(model.id))
  )
    fail('Choose an available model and colour');
  return {
    schemaVersion: 1,
    productVersion: hash(product),
    product: { id: product.id, name: product.name },
    model: { id: model.id, name: model.name, imageId: model.imageId },
    colour: { id: colour.id, name: colour.name, imageId: colour.imageId },
  };
}
module.exports = { uuid, text, revision, parse, hash, products, selection };
