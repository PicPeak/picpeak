'use strict';
// One shared definition, deliberately free of CRM amounts or supplier assumptions.
const V = require('./validation');
const { ValidationError } = require('../../utils/errors');
const fail = (message) => {
  throw new ValidationError(message);
};
const list = (value, max) => {
  if (!Array.isArray(value) || value.length > max)
    fail('Invalid catalogue list');
  return value;
};
const unique = (values) => {
  if (new Set(values).size !== values.length)
    fail('Duplicate catalogue identifiers');
  return values;
};
function cleanLibrary(value = []) {
  const ids = new Set();
  const identify = (id) => {
    V.uuid(id);
    if (ids.has(id)) fail('Duplicate library identifier');
    ids.add(id);
    return id;
  };
  return list(value, 50).map((group) => ({
    id: identify(group.id),
    name: V.text(group.name, 100, true),
    kind: ['choice', 'size', 'colour'].includes(group.kind)
      ? group.kind
      : fail('Unknown option kind'),
    options: list(group.options, 100).map((option) => {
      const out = {
        id: identify(option.id),
        name: V.text(option.name, 100, true),
        active: option.active === true,
        imageId: option.imageId ? V.uuid(option.imageId) : null,
      };
      if (group.kind === 'size') {
        if (
          !['mm', 'cm', 'in'].includes(option.unit) ||
          ![option.width, option.height].every(
            (n) =>
              typeof n === 'number' &&
              Number.isFinite(n) &&
              n > 0 &&
              n <= 10000,
          )
        )
          fail('Sizes need width, height and mm, cm or in');
        Object.assign(out, {
          width: option.width,
          height: option.height,
          unit: option.unit,
        });
      }
      return out;
    }),
  }));
}
function cleanTypes(value = [], library) {
  const groups = new Map(library.map((group) => [group.id, group]));
  const types = list(value, 30).map((type) => {
    const attributes = list(type.attributes, 20).map((a) => {
      const group = groups.get(a.groupId);
      if (!group) fail('An attribute refers to an unknown library');
      const optionIds = unique(list(a.optionIds, 100).map(V.uuid));
      if (
        !optionIds.length ||
        optionIds.some((id) => !group.options.some((o) => o.id === id))
      )
        fail('Choose available library options');
      return {
        id: V.uuid(a.id),
        name: V.text(a.name, 100, true),
        groupId: group.id,
        optionIds,
        required: a.required === true,
        multiple: a.multiple === true,
        addOn: a.addOn === true,
        dependsOn: list(a.dependsOn || [], 1).map((d) => ({
          attributeId: V.uuid(d.attributeId),
          optionIds: unique(list(d.optionIds, 100).map(V.uuid)),
        })),
      };
    });
    unique(attributes.map((a) => a.id));
    const byId = new Map(attributes.map((a) => [a.id, a]));
    for (const a of attributes)
      for (const d of a.dependsOn) {
        const parent = byId.get(d.attributeId);
        if (
          !parent ||
          !d.optionIds.length ||
          d.optionIds.some((id) => !parent.optionIds.includes(id))
        )
          fail('Invalid product dependency');
      }
    const seen = new Set(),
      pending = new Set();
    function visit(id) {
      if (pending.has(id)) fail('Product dependencies cannot contain cycles');
      if (seen.has(id)) return;
      pending.add(id);
      for (const d of byId.get(id).dependsOn) visit(d.attributeId);
      pending.delete(id);
      seen.add(id);
    }
    for (const a of attributes) visit(a.id);
    return {
      id: V.uuid(type.id),
      name: V.text(type.name, 100, true),
      active: type.active === true,
      attributes,
    };
  });
  unique(types.map((t) => t.id));
  return types;
}
function resolve(product, catalogue) {
  if (!product?.typeId) return product;
  const type = catalogue.types.find((t) => t.id === product.typeId);
  if (!type) fail('Unknown product type');
  const groups = new Map(catalogue.library.map((g) => [g.id, g]));
  const result = {
    ...product,
    active: product.active && type.active,
    attributes: type.attributes.map((a) => ({
      ...a,
      options: groups
        .get(a.groupId)
        .options.filter((o) => a.optionIds.includes(o.id) && o.active),
    })),
  };
  result.version = V.hash(result);
  return result;
}
function selection(product, input, { complete = true } = {}) {
  if (!product?.active) fail('This product is unavailable');
  if (input.productVersion !== product.version)
    fail('The product options changed; review them before saving');
  const values = input.values;
  if (
    !values ||
    typeof values !== 'object' ||
    Array.isArray(values) ||
    Object.keys(values).some(
      (id) => !product.attributes.some((a) => a.id === id),
    )
  )
    fail('Invalid product choices');
  const normalized = {};
  for (const a of product.attributes) {
    const chosen = values[a.id] ?? [];
    normalized[a.id] = unique(list(chosen, a.multiple ? 100 : 1).map(V.uuid));
    if (
      normalized[a.id].some(
        (id) => !a.options.some((o) => o.id === id && o.active),
      )
    )
      fail('An option is no longer available');
  }
  // Dependencies are evaluated recursively, so a stale hidden parent's values
  // cannot activate a descendant (and cycles were rejected on catalogue save).
  const enabled = (a) =>
    a.dependsOn.every((d) => {
      const parent = product.attributes.find((p) => p.id === d.attributeId);
      return (
        enabled(parent) &&
        d.optionIds.some((id) => normalized[parent.id].includes(id))
      );
    });
  const attributes = [];
  for (const a of product.attributes) {
    const chosen = normalized[a.id];
    if (!enabled(a)) {
      if (chosen.length) fail('This option depends on another choice');
      continue;
    }
    if (complete && a.required && !chosen.length) fail(`Choose ${a.name}`);
    if (chosen.length)
      attributes.push({
        id: a.id,
        name: a.name,
        addOn: a.addOn,
        options: a.options
          .filter((o) => chosen.includes(o.id))
          .map(({ id, name, imageId, width, height, unit }) => ({
            id,
            name,
            imageId,
            ...(width == null ? {} : { width, height, unit }),
          })),
      });
  }
  return {
    schemaVersion: 2,
    productVersion: product.version,
    product: { id: product.id, name: product.name },
    attributes,
  };
}
const valuesOf = (snapshot) =>
  Object.fromEntries(
    (snapshot?.attributes || []).map((a) => [a.id, a.options.map((o) => o.id)]),
  );
const summary = (snapshot) =>
  snapshot?.attributes
    ? snapshot.attributes
        .map((a) => `${a.name}: ${a.options.map((o) => o.name).join(', ')}`)
        .join(' · ')
    : [snapshot?.model?.name, snapshot?.colour?.name]
        .filter(Boolean)
        .join(' · ');
function presetId(label) {
  const hex = V.hash(label);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function presets() {
  return [
    {
      id: presetId('formats'),
      name: 'Sizes',
      kind: 'size',
      options: [
        [10, 15],
        [13, 18],
        [20, 30],
        [30, 40],
        [40, 60],
        [60, 90],
        [80, 120],
        [20, 20],
        [28, 28],
        [22, 30],
      ].map(([width, height]) => ({
        id: presetId(`size-${width}-${height}`),
        name: `${width} × ${height} cm`,
        width,
        height,
        unit: 'cm',
        active: true,
        imageId: null,
      })),
    },
    {
      id: presetId('colours'),
      name: 'Colours',
      kind: 'colour',
      options: [
        'Black',
        'White',
        'Natural',
        'Grey',
        'Blue',
        'Green',
        'Red',
      ].map((name) => ({
        id: presetId(`colour-${name}`),
        name,
        active: true,
        imageId: null,
      })),
    },
  ];
}
module.exports = {
  cleanLibrary,
  cleanTypes,
  resolve,
  selection,
  valuesOf,
  summary,
  presets,
};
