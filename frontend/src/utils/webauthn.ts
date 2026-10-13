// Browser side of the passkey ceremonies (issue 1733). The server speaks the
// WebAuthn JSON forms (base64url strings); navigator.credentials wants
// ArrayBuffers. These helpers convert in both directions and nothing else:
// every decision about a credential is the server's.

type Json = Record<string, any>;

const toBuffer = (value: string): ArrayBuffer => {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
};

const toBase64Url = (buffer: ArrayBuffer | null | undefined): string | undefined => {
  if (!buffer) return undefined;
  let binary = '';
  new Uint8Array(buffer).forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const withBufferIds = (list: Json[] | undefined) =>
  list?.map((item) => ({ ...item, id: toBuffer(item.id) }));

export const isPasskeySupported = (): boolean =>
  typeof window !== 'undefined'
  && typeof window.PublicKeyCredential !== 'undefined'
  && typeof navigator.credentials?.create === 'function';

/** Run a registration ceremony; resolves to the JSON the server verifies. */
export async function createPasskey(options: Json): Promise<Json> {
  const credential = await navigator.credentials.create({
    publicKey: {
      ...options,
      challenge: toBuffer(options.challenge),
      user: { ...options.user, id: toBuffer(options.user.id) },
      excludeCredentials: withBufferIds(options.excludeCredentials),
    } as PublicKeyCredentialCreationOptions,
  }) as PublicKeyCredential | null;
  if (!credential) throw new DOMException('No credential returned', 'NotAllowedError');
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: toBase64Url(response.clientDataJSON),
      attestationObject: toBase64Url(response.attestationObject),
      transports: typeof response.getTransports === 'function' ? response.getTransports() : undefined,
    },
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
  };
}

/** Run a sign-in ceremony; resolves to the JSON the server verifies. */
export async function getPasskey(options: Json): Promise<Json> {
  const credential = await navigator.credentials.get({
    publicKey: {
      ...options,
      challenge: toBuffer(options.challenge),
      allowCredentials: withBufferIds(options.allowCredentials),
    } as PublicKeyCredentialRequestOptions,
  }) as PublicKeyCredential | null;
  if (!credential) throw new DOMException('No credential returned', 'NotAllowedError');
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: toBase64Url(response.clientDataJSON),
      authenticatorData: toBase64Url(response.authenticatorData),
      signature: toBase64Url(response.signature),
      userHandle: toBase64Url(response.userHandle),
    },
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
  };
}

export type PasskeyErrorKind = 'cancelled' | 'exists' | 'unsupported' | 'security';

/**
 * What a rejected navigator.credentials call means for the person in front
 * of it, or null when the error is not a browser one (an API error, say).
 * Browsers report "dismissed" and "timed out" as the same NotAllowedError.
 */
export function passkeyErrorKind(error: unknown): PasskeyErrorKind | null {
  const name = (error as { name?: string } | null)?.name;
  switch (name) {
    case 'NotAllowedError':
    case 'AbortError':
      return 'cancelled';
    case 'InvalidStateError':
      return 'exists';
    case 'NotSupportedError':
      return 'unsupported';
    case 'SecurityError':
      return 'security';
    default:
      return null;
  }
}
