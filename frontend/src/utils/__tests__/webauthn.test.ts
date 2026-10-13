/**
 * The passkey helpers only translate between the server's JSON (base64url)
 * and the ArrayBuffers navigator.credentials works with (issue 1733). A wrong
 * byte here fails every ceremony, so the round trip is pinned.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createPasskey, getPasskey, isPasskeySupported, passkeyErrorKind } from '../webauthn';

const bytes = (...values: number[]) => new Uint8Array(values).buffer;
const asArray = (buffer: ArrayBuffer) => Array.from(new Uint8Array(buffer));

const stubCredentials = (impl: Record<string, unknown>) =>
  Object.defineProperty(navigator, 'credentials', { configurable: true, value: impl });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('webauthn helpers', () => {
  it('feature-detects passkey support', () => {
    expect(isPasskeySupported()).toBe(false);
    vi.stubGlobal('PublicKeyCredential', function PublicKeyCredential() {});
    stubCredentials({ create: vi.fn(), get: vi.fn() });
    expect(isPasskeySupported()).toBe(true);
  });

  it('hands the browser buffers and the server base64url on registration', async () => {
    const create = vi.fn().mockResolvedValue({
      id: 'cred',
      rawId: bytes(251, 255, 254),
      type: 'public-key',
      authenticatorAttachment: 'platform',
      response: {
        clientDataJSON: bytes(1, 2),
        attestationObject: bytes(3),
        getTransports: () => ['internal'],
      },
      getClientExtensionResults: () => ({}),
    });
    stubCredentials({ create });

    const result = await createPasskey({
      challenge: '-_-_',
      rp: { id: 'photos.example.com', name: 'PicPeak' },
      user: { id: 'AQID', name: 'admin', displayName: 'admin' },
      excludeCredentials: [{ id: '-_8', type: 'public-key' }],
      pubKeyCredParams: [],
    });

    const sent = create.mock.calls[0][0].publicKey;
    expect(asArray(sent.challenge)).toEqual([251, 255, 191]);
    expect(asArray(sent.user.id)).toEqual([1, 2, 3]);
    expect(asArray(sent.excludeCredentials[0].id)).toEqual([251, 255]);
    expect(sent.rp.id).toBe('photos.example.com');

    expect(result).toMatchObject({
      id: 'cred',
      rawId: '-__-',
      type: 'public-key',
      response: { clientDataJSON: 'AQI', attestationObject: 'Aw', transports: ['internal'] },
    });
  });

  it('serialises an assertion, with or without a user handle', async () => {
    const get = vi.fn().mockResolvedValue({
      id: 'cred',
      rawId: bytes(1),
      type: 'public-key',
      response: {
        clientDataJSON: bytes(1),
        authenticatorData: bytes(2),
        signature: bytes(3),
        userHandle: null,
      },
      getClientExtensionResults: () => ({}),
    });
    stubCredentials({ get });

    const result = await getPasskey({ challenge: 'AQ', rpId: 'photos.example.com' });
    expect(get.mock.calls[0][0].publicKey.allowCredentials).toBeUndefined();
    expect(result.response).toEqual({
      clientDataJSON: 'AQ', authenticatorData: 'Ag', signature: 'Aw', userHandle: undefined,
    });
  });

  it('classifies what the browser rejects with', () => {
    const named = (name: string) => Object.assign(new Error('x'), { name });
    expect(passkeyErrorKind(named('NotAllowedError'))).toBe('cancelled');
    expect(passkeyErrorKind(named('InvalidStateError'))).toBe('exists');
    expect(passkeyErrorKind(named('NotSupportedError'))).toBe('unsupported');
    expect(passkeyErrorKind(named('SecurityError'))).toBe('security');
    expect(passkeyErrorKind({ response: { status: 401 } })).toBeNull();
  });
});
