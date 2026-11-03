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
// What an attribute is in a guided album. Roles say how to present a catalogue
// attribute; every material, colour, format and size stays catalogue data.
const GUIDED_ROLES = ['material', 'colour', 'format', 'size'];
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
      if (group.kind === 'colour' && option.hex) {
        if (!/^#[0-9a-f]{6}$/i.test(option.hex))
          fail('A colour value is a hex code such as #a1b2c3');
        out.hex = option.hex.toLowerCase();
      }
      return out;
    }),
  }));
}
/** Which of one attribute's options each option of its parent allows. */
function cleanAvailability(a, optionIds, attributes) {
  const rule = a.availableWhen;
  if (!rule || typeof rule !== 'object' || Array.isArray(rule))
    fail('Invalid option dependency');
  const parent = attributes.find((p) => p.id === rule.attributeId);
  if (!parent || parent.id === a.id) fail('Invalid option dependency');
  if (!rule.options || typeof rule.options !== 'object' || Array.isArray(rule.options))
    fail('Invalid option dependency');
  const options = {};
  for (const [id, parents] of Object.entries(rule.options)) {
    // Unticking an option in the type takes its rule along.
    if (!optionIds.includes(id)) continue;
    const allowed = unique(list(parents, 100).map(V.uuid)).filter((p) =>
      parent.optionIds.includes(p),
    );
    if (!allowed.length) fail('Invalid option dependency');
    options[id] = allowed;
  }
  return { attributeId: parent.id, options };
}
// An option without an entry is offered with every parent option.
const optionAllowed = (a, optionId, parentValues) => {
  const allowed = a.availableWhen?.options[optionId];
  return !allowed || allowed.some((id) => parentValues.includes(id));
};
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
        ...(a.role ? { role: GUIDED_ROLES.includes(a.role) ? a.role : fail('Unknown attribute role') } : {}),
        // Sizes measure the open album, two pages side by side.
        ...(a.spread === true && a.role === 'size' ? { spread: true } : {}),
      };
    });
    unique(attributes.map((a) => a.id));
    unique(attributes.map((a) => a.role).filter(Boolean));
    for (const [index, a] of type.attributes.entries())
      if (a.availableWhen)
        attributes[index].availableWhen = cleanAvailability(
          a,
          attributes[index].optionIds,
          attributes,
        );
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
      if (byId.get(id).availableWhen) visit(byId.get(id).availableWhen.attributeId);
      pending.delete(id);
      seen.add(id);
    }
    for (const a of attributes) visit(a.id);
    // A client must never reach a parent choice that leaves nothing to pick.
    const active = (a) =>
      groups.get(a.groupId).options.filter((o) => o.active && a.optionIds.includes(o.id));
    for (const a of attributes) {
      if (!a.availableWhen || !a.required) continue;
      const parent = byId.get(a.availableWhen.attributeId);
      for (const option of active(parent))
        if (!active(a).some((o) => optionAllowed(a, o.id, [option.id])))
          fail(`${option.name} has no available option in ${a.name}`);
    }
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
    if (
      a.availableWhen &&
      chosen.some(
        (id) => !optionAllowed(a, id, normalized[a.availableWhen.attributeId] ?? []),
      )
    )
      fail('This combination of options is not available');
    if (complete && a.required && !chosen.length) fail(`Choose ${a.name}`);
    if (chosen.length)
      attributes.push({
        id: a.id,
        name: a.name,
        addOn: a.addOn,
        ...(a.role ? { role: a.role } : {}),
        options: a.options
          .filter((o) => chosen.includes(o.id))
          .map(({ id, name, imageId, width, height, unit, hex }) => ({
            id,
            name,
            imageId,
            ...(width == null ? {} : { width, height, unit }),
            ...(hex ? { hex } : {}),
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
/** A guided album needs each role once and the two catalogue dependencies. */
function assertGuided(product, types) {
  const attributes = types.find((t) => t.id === product.typeId)?.attributes || [];
  const role = (name) => attributes.find((a) => a.role === name);
  for (const name of GUIDED_ROLES) {
    const a = role(name);
    if (!a || !a.required || a.multiple)
      fail(`A guided album needs one required ${name} attribute`);
  }
  if (
    role('colour').availableWhen?.attributeId !== role('material').id ||
    role('size').availableWhen?.attributeId !== role('format').id
  )
    fail('A guided album needs colours by material and sizes by format');
  // The flow asks in this order, and a choice can't wait for one that follows it.
  GUIDED_ROLES.forEach((name, index) => {
    const a = role(name);
    const parents = [...(a.availableWhen ? [a.availableWhen] : []), ...(a.dependsOn || [])];
    if (parents.some((p) => !GUIDED_ROLES.slice(0, index).some((earlier) => role(earlier).id === p.attributeId)))
      fail(`A guided album's ${name} can only depend on an earlier step`);
  });
}
const PHOTO_LABELS = { cover: 'Cover', poster: 'Poster' };
const summary = (snapshot) =>
  (snapshot?.attributes
    ? snapshot.attributes.map(
      (a) => `${a.name}: ${a.options.map((o) => o.name).join(', ')}`,
    )
    : [snapshot?.model?.name, snapshot?.colour?.name].filter(Boolean)
  )
    .concat(
      (snapshot?.photoRoles || [])
        .filter((r) => r.photos.length)
        .map(
          (r) =>
            `${PHOTO_LABELS[r.key]}: ${r.photos.map((p) => p.filename).join(', ')}`,
        ),
    )
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
  assertGuided,
  resolve,
  selection,
  valuesOf,
  summary,
  presets,
};
