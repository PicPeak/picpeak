const crypto = require('crypto');
const p = require('../../src/usage/protocol.cjs');
const now = Date.parse('2026-09-06T12:00:00.000Z');

const signHistorical = (packet, id) => {
  const signed = { packet, public_key: id.public_key, issued_at: new Date(now).toISOString(), nonce: crypto.randomUUID() };
  return { ...signed, signature: crypto.sign(null, Buffer.from(p.canonical(signed)), id.private_key).toString('base64url') };
};

describe.each(['usage.v1', 'usage.v2', 'usage.v3', 'usage.v4'])('%s receiver compatibility never loosens the PicPeak sender', version => {
  test('complete original reports still sign and verify', () => {
    const id = p.generateIdentity();
    const packet = p.makePacket(id, 'report', 1, {
      picpeak_version: '1.0.0', report_date: '2026-09-06', generated_at: new Date(now).toISOString(),
      features: p.emptyFeatures(version), gallery_layouts: [],
      ...(['usage.v3', 'usage.v4'].includes(version) ? { inventory: { galleries: 0, photos: 0 } } : {}),
    }, version);
    const envelope = p.signPacket(packet, id, new Date(now));
    expect(p.verifyEnvelope(envelope, now)).toEqual(packet);
    expect(p.verifyReceivedEnvelope(envelope, now)).toEqual(packet);
  });

  test.each([undefined, null, {}, { crm: { used: true, configured: null } }])('accepts partial incoming measurements %p without rewriting them', features => {
    const id = p.generateIdentity();
    const packet = p.makePacket(id, 'report', 1, {
      report_date: '2020-01-02', generated_at: '2020-01-02T12:00:00.000Z',
      ...(features === undefined ? {} : { features }),
    }, version);
    expect(() => p.signPacket(packet, id, new Date(now))).toThrow('INVALID_PACKET');
    const envelope = signHistorical(packet, id), original = JSON.stringify(envelope);
    expect(() => p.verifyEnvelope(envelope, now)).toThrow('INVALID_PACKET');
    expect(p.verifyReceivedEnvelope(envelope, now)).toEqual(packet);
    expect(JSON.stringify(envelope)).toBe(original);
  });

  test('registration still requires exact explicit consent', () => {
    const id = p.generateIdentity();
    const packet = p.makePacket(id, 'register', 0, {}, version);
    expect(() => p.verifyReceivedEnvelope(signHistorical(packet, id), now)).toThrow('INVALID_PACKET');
  });
});
