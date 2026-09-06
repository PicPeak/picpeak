"use strict";

// Vendored byte-identical in PicPeak. Existing wire versions stay immutable;
// every expansion requires explicit consent to its own version.
const CATALOG = require("./features.v4.json");
const CATALOGS = { "usage.v2": require("./features.v2.json"), "usage.v3": require("./features.v3.json"), "usage.v4": CATALOG };
const CONSENT_VERSIONS = { "usage.v1": "usage-consent.v1", "usage.v2": "usage-consent.v2", "usage.v3": "usage-consent.v3", "usage.v4": "usage-consent.v4" };
const CURRENT_SCHEMA_VERSION = "usage.v4";
const CURRENT_CONSENT_VERSION = CONSENT_VERSIONS[CURRENT_SCHEMA_VERSION];
const schemaForConsent = (consent) => Object.keys(CONSENT_VERSIONS).find((version) => CONSENT_VERSIONS[version] === consent);
const schemaRank = (version) => Object.keys(CONSENT_VERSIONS).indexOf(version);
const INVENTORY_KEYS = ["galleries", "photos"];
// At the collector's 100,000-reporter limit, sums remain safe JS integers.
const MAX_INVENTORY_COUNT = 1000000000;
const LEGACY_FEATURE_KEYS = [
  "crm", "crm_quotes", "crm_invoices", "crm_contracts", "crm_projects",
  "crm_calendar", "crm_hours", "customer_portal", "accounting", "workflows",
  "newsletters", "face_recognition", "custom_css", "oauth", "smtp",
  "whatsapp", "backup", "s3_storage", "share_mounts",
];
const FEATURE_KEYS = Object.keys(CATALOG.features);
// Historical questions remain independently visible after a newer schema
// stops asking them. Never rename or invert a retained report's values.
const ALL_FEATURES = Object.assign({}, ...Object.values(CATALOGS).map(c => c.features));
const ALL_FEATURE_KEYS = Object.keys(ALL_FEATURES);
const LAYOUTS = ["grid", "masonry", "carousel", "timeline", "mosaic", "gallery-premium", "gallery-story", "other"];
const object = (properties, required = Object.keys(properties)) => ({
  type: "object", additionalProperties: false, properties, required,
});
const uuid = { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" };
const hash = { type: "string", pattern: "^[0-9a-f]{64}$" };
const timestamp = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" };
const text = (maxLength, minLength = 1) => ({ type: "string", minLength, maxLength });
const boolean = { type: "boolean" };
const featureKeysFor = (version = CURRENT_SCHEMA_VERSION) =>
  version === "usage.v1" ? LEGACY_FEATURE_KEYS : Object.keys(CATALOGS[version]?.features || {});
const observesUse = (key, version = CURRENT_SCHEMA_VERSION) =>
  version === "usage.v1" || CATALOGS[version]?.features[key]?.measurement === "configuration_and_use";
const emptyFeatures = (version = CURRENT_SCHEMA_VERSION) => Object.fromEntries(
  featureKeysFor(version).map(key => [key, {
    configured: false, ...(observesUse(key, version) ? { used: false } : {})
  }])
);
const report = (version) => object({
  picpeak_version: { type: "string", maxLength: 48, pattern: "^\\d+\\.\\d+\\.\\d+(?:-(?:alpha|beta|rc)\\.\\d+)?$" },
  report_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
  generated_at: timestamp,
  features: object(Object.fromEntries(featureKeysFor(version).map(key => [
    key, object({ configured: boolean, ...(observesUse(key, version) ? { used: boolean } : {}) })
  ]))),
  gallery_layouts: { type: "array", uniqueItems: true, maxItems: LAYOUTS.length, items: { enum: LAYOUTS } },
  ...(["usage.v3", "usage.v4"].includes(version) ? { inventory: object(Object.fromEntries(INVENTORY_KEYS.map(key => [key,
    { type: "integer", minimum: 0, maximum: MAX_INVENTORY_COUNT }
  ]))) } : {}),
});
const feedback = object({
  feedback_id: uuid, kind: { enum: ["feedback", "feature_request", "testimonial"] },
  title: text(120), body: text(4000), name: text(80, 0),
  allow_public: boolean, allow_marketing: boolean,
});
const makePayloads = (version) => ({
  register: object({ consent_version: { const: CONSENT_VERSIONS[version] } }),
  report: report(version),
  delete: object({}), feedback,
  vote: object({ feedback_id: uuid, voted: boolean }),
  session: object({}),
  ...(version !== "usage.v1" ? { consent: object({ consent_version: { const: CONSENT_VERSIONS[version] } }) } : {}),
});
const payloadsByVersion = Object.fromEntries(Object.keys(CONSENT_VERSIONS).map(version => [version, makePayloads(version)]));
const envelopeSchemas = Object.fromEntries(Object.entries(payloadsByVersion).map(([version, actions]) => [version, {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: `https://usage.picpeak.app/schema/${version}.json`,
  title: `PicPeak ${version} signed envelope`,
  description: "Only report.payload is automatic feature telemetry. Other actions are explicit participant operations. See /transparency for field semantics and retention.",
  ...object({
    packet: { oneOf: Object.entries(actions).map(([action, payload]) => object({
      schema_version: { const: version },
      installation_id: hash, packet_id: uuid,
      sequence: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      action: { const: action }, payload,
    })) },
    public_key: { type: "string", minLength: 59, maxLength: 59, pattern: "^[A-Za-z0-9_-]+$" },
    issued_at: timestamp, nonce: uuid,
    signature: { type: "string", minLength: 86, maxLength: 86, pattern: "^[A-Za-z0-9_-]+$" },
  }),
}]));
const envelopeSchema = envelopeSchemas[CURRENT_SCHEMA_VERSION];
const payloads = payloadsByVersion[CURRENT_SCHEMA_VERSION];
// Writers retain their immutable, complete contracts. The receiver accepts
// missing measurements from older/partial reporters, without expanding any
// version's allowlist or changing the signed object. Null also means unknown.
const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });
const ingressEnvelopeSchemas = Object.fromEntries(Object.entries(envelopeSchemas).map(([version, source]) => {
  const schema = structuredClone(source);
  schema.$id = `https://usage.picpeak.app/schema/ingress/${version}.json`;
  schema.title = `PicPeak ${version} compatible report reception`;
  const payload = schema.properties.packet.oneOf.find(p => p.properties.action.const === "report").properties.payload;
  payload.required = ["report_date", "generated_at"];
  const features = payload.properties.features;
  features.required = [];
  for (const signal of Object.values(features.properties)) {
    signal.required = [];
    for (const key of Object.keys(signal.properties)) signal.properties[key] = nullable(signal.properties[key]);
  }
  for (const key of Object.keys(features.properties)) features.properties[key] = nullable(features.properties[key]);
  if (payload.properties.inventory) {
    const inventory = payload.properties.inventory;
    inventory.required = [];
    for (const key of Object.keys(inventory.properties)) inventory.properties[key] = nullable(inventory.properties[key]);
  }
  for (const key of ["picpeak_version", "features", "gallery_layouts", "inventory"])
    if (payload.properties[key]) payload.properties[key] = nullable(payload.properties[key]);
  return [version, schema];
}));
module.exports = {
  FEATURE_KEYS, ALL_FEATURES, ALL_FEATURE_KEYS, LEGACY_FEATURE_KEYS, LAYOUTS, CATALOG, CATALOGS, CONSENT_VERSIONS,
  schemaForConsent, schemaRank, INVENTORY_KEYS, MAX_INVENTORY_COUNT, CURRENT_SCHEMA_VERSION,
  CURRENT_CONSENT_VERSION, featureKeysFor, observesUse, emptyFeatures,
  envelopeSchema, envelopeSchemas, ingressEnvelopeSchemas, payloads, payloadsByVersion,
};
