"use strict";

// Vendored unchanged in PicPeak. Changing the wire contract requires a new
// schema version and matching conformance tests in both repositories.
const FEATURE_KEYS = [
  "crm",
  "crm_quotes",
  "crm_invoices",
  "crm_contracts",
  "crm_projects",
  "crm_calendar",
  "crm_hours",
  "customer_portal",
  "accounting",
  "workflows",
  "newsletters",
  "face_recognition",
  "custom_css",
  "oauth",
  "smtp",
  "whatsapp",
  "backup",
  "s3_storage",
  "share_mounts",
];
const LAYOUTS = [
  "grid",
  "masonry",
  "carousel",
  "timeline",
  "mosaic",
  "gallery-premium",
  "gallery-story",
  "other",
];
const object = (properties, required = Object.keys(properties)) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});
const uuid = {
  type: "string",
  pattern:
    "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
};
const hash = { type: "string", pattern: "^[0-9a-f]{64}$" };
const timestamp = {
  type: "string",
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$",
};
const text = (maxLength, minLength = 1) => ({
  type: "string",
  minLength,
  maxLength,
});
const boolean = { type: "boolean" };
const features = object(
  Object.fromEntries(
    FEATURE_KEYS.map((key) => [
      key,
      object({ configured: boolean, used: boolean }),
    ]),
  ),
);
const report = object({
  picpeak_version: {
    type: "string",
    maxLength: 48,
    pattern: "^\\d+\\.\\d+\\.\\d+(?:-(?:alpha|beta|rc)\\.\\d+)?$",
  },
  report_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
  generated_at: timestamp,
  features,
  gallery_layouts: {
    type: "array",
    uniqueItems: true,
    maxItems: LAYOUTS.length,
    items: { enum: LAYOUTS },
  },
});
const feedback = object({
  feedback_id: uuid,
  kind: { enum: ["feedback", "feature_request", "testimonial"] },
  title: text(120),
  body: text(4000),
  name: text(80, 0),
  allow_public: boolean,
  allow_marketing: boolean,
});
const payloads = {
  register: object({ consent_version: { const: "usage-consent.v1" } }),
  report,
  delete: object({}),
  feedback,
  vote: object({ feedback_id: uuid, voted: boolean }),
  session: object({}),
};
const packetBase = {
  schema_version: { const: "usage.v1" },
  installation_id: hash,
  packet_id: uuid,
  sequence: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
};
const packetSchema = {
  oneOf: Object.entries(payloads).map(([action, payload]) =>
    object({
      ...packetBase,
      action: { const: action },
      payload,
    }),
  ),
};
const envelopeSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://usage.picpeak.app/schema/usage.v1.json",
  title: "PicPeak usage.v1 signed envelope",
  description:
    "Only report.payload is automatic feature telemetry. Other actions are explicit participant operations. See /transparency for field semantics and retention.",
  ...object({
    packet: packetSchema,
    public_key: {
      type: "string",
      minLength: 59,
      maxLength: 59,
      pattern: "^[A-Za-z0-9_-]+$",
    },
    issued_at: timestamp,
    nonce: uuid,
    signature: {
      type: "string",
      minLength: 86,
      maxLength: 86,
      pattern: "^[A-Za-z0-9_-]+$",
    },
  }),
};
module.exports = { FEATURE_KEYS, LAYOUTS, envelopeSchema, payloads };
