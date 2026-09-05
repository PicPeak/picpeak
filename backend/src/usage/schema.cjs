"use strict";

// Vendored byte-identical in PicPeak. v1 stays immutable; a larger allowlist
// has a new wire version and requires explicit, signed v2 consent.
const CATALOG = require("./features.v2.json");
const CURRENT_SCHEMA_VERSION = "usage.v2";
const CURRENT_CONSENT_VERSION = "usage-consent.v2";
const LEGACY_FEATURE_KEYS = [
  "crm", "crm_quotes", "crm_invoices", "crm_contracts", "crm_projects",
  "crm_calendar", "crm_hours", "customer_portal", "accounting", "workflows",
  "newsletters", "face_recognition", "custom_css", "oauth", "smtp",
  "whatsapp", "backup", "s3_storage", "share_mounts",
];
const FEATURE_KEYS = Object.keys(CATALOG.features);
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
  version === "usage.v1" ? LEGACY_FEATURE_KEYS : version === "usage.v2" ? FEATURE_KEYS : [];
const observesUse = (key, version = CURRENT_SCHEMA_VERSION) =>
  version === "usage.v1" || CATALOG.features[key]?.measurement === "configuration_and_use";
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
});
const feedback = object({
  feedback_id: uuid, kind: { enum: ["feedback", "feature_request", "testimonial"] },
  title: text(120), body: text(4000), name: text(80, 0),
  allow_public: boolean, allow_marketing: boolean,
});
const makePayloads = (version) => ({
  register: object({ consent_version: { const: version === "usage.v1" ? "usage-consent.v1" : CURRENT_CONSENT_VERSION } }),
  report: report(version),
  delete: object({}), feedback,
  vote: object({ feedback_id: uuid, voted: boolean }),
  session: object({}),
  ...(version === "usage.v2" ? { consent: object({ consent_version: { const: CURRENT_CONSENT_VERSION } }) } : {}),
});
const payloadsByVersion = Object.fromEntries(["usage.v1", "usage.v2"].map(version => [version, makePayloads(version)]));
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
module.exports = {
  FEATURE_KEYS, LEGACY_FEATURE_KEYS, LAYOUTS, CATALOG, CURRENT_SCHEMA_VERSION,
  CURRENT_CONSENT_VERSION, featureKeysFor, observesUse, emptyFeatures,
  envelopeSchema, envelopeSchemas, payloads, payloadsByVersion,
};
