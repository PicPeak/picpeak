"use strict";
const crypto = require("node:crypto");
const Ajv = require("ajv");
const {
  envelopeSchema,
  FEATURE_KEYS,
  LAYOUTS,
  payloads,
} = require("./schema.cjs");
const validate = new Ajv({ allErrors: false, strict: true }).compile(
  envelopeSchema,
);
const MAX_BYTES = 16384;
const MAX_AGE_MS = 5 * 60 * 1000;

class ProtocolError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
const digest = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");
function publicKeyIdentity(publicKey) {
  const bytes = Buffer.from(publicKey, "base64url");
  if (bytes.toString("base64url") !== publicKey || bytes.length !== 44)
    throw new ProtocolError("INVALID_KEY");
  const key = crypto.createPublicKey({
    key: bytes,
    format: "der",
    type: "spki",
  });
  if (key.asymmetricKeyType !== "ed25519")
    throw new ProtocolError("INVALID_KEY");
  return { key, id: digest(bytes) };
}
function generateIdentity() {
  const keys = crypto.generateKeyPairSync("ed25519");
  const public_key = keys.publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64url");
  return {
    installation_id: publicKeyIdentity(public_key).id,
    public_key,
    private_key: keys.privateKey.export({ format: "pem", type: "pkcs8" }),
  };
}
function makePacket(identity, action, sequence, payload) {
  return {
    schema_version: "usage.v1",
    installation_id: identity.installation_id,
    packet_id: crypto.randomUUID(),
    action,
    sequence,
    payload,
  };
}
function signPacket(packet, identity, now = new Date()) {
  const signed = {
    packet,
    public_key: identity.public_key,
    issued_at: now.toISOString(),
    nonce: crypto.randomUUID(),
  };
  const signature = crypto
    .sign(null, Buffer.from(canonical(signed)), identity.private_key)
    .toString("base64url");
  const envelope = { ...signed, signature };
  if (
    !validate(envelope) ||
    Buffer.byteLength(JSON.stringify(envelope)) > MAX_BYTES
  )
    throw new ProtocolError("INVALID_PACKET");
  return envelope;
}
function verifyEnvelope(envelope, now = Date.now()) {
  if (
    Buffer.byteLength(JSON.stringify(envelope) || "") > MAX_BYTES ||
    !validate(envelope)
  )
    throw new ProtocolError("INVALID_PACKET");
  const issued = Date.parse(envelope.issued_at);
  if (
    !Number.isFinite(issued) ||
    new Date(issued).toISOString() !== envelope.issued_at ||
    Math.abs(now - issued) > MAX_AGE_MS
  ) {
    throw new ProtocolError("EXPIRED_SIGNATURE", 401);
  }
  let identity;
  try {
    identity = publicKeyIdentity(envelope.public_key);
  } catch (_) {
    throw new ProtocolError("INVALID_KEY", 401);
  }
  if (identity.id !== envelope.packet.installation_id)
    throw new ProtocolError("IDENTITY_MISMATCH", 401);
  const { signature, ...signed } = envelope;
  const signatureBytes = Buffer.from(signature, "base64url");
  if (
    signatureBytes.toString("base64url") !== signature ||
    !crypto.verify(
      null,
      Buffer.from(canonical(signed)),
      identity.key,
      signatureBytes,
    )
  )
    throw new ProtocolError("INVALID_SIGNATURE", 401);
  const { action, payload } = envelope.packet;
  if (action === "report") {
    const generated = Date.parse(payload.generated_at);
    if (
      !Number.isFinite(generated) ||
      new Date(generated).toISOString() !== payload.generated_at ||
      payload.report_date !== payload.generated_at.slice(0, 10) ||
      generated > now + MAX_AGE_MS
    )
      throw new ProtocolError("INVALID_REPORT_DATE");
  }
  if (
    action === "feedback" &&
    payload.allow_marketing &&
    (payload.kind !== "testimonial" || !payload.allow_public)
  ) {
    throw new ProtocolError("INVALID_PUBLICATION_CONSENT");
  }
  return envelope.packet;
}
module.exports = {
  canonical,
  digest,
  generateIdentity,
  makePacket,
  signPacket,
  verifyEnvelope,
  ProtocolError,
  MAX_BYTES,
  MAX_AGE_MS,
  FEATURE_KEYS,
  LAYOUTS,
  envelopeSchema,
  payloads,
};
