const {
  decryptEmailData,
  encryptEmailData,
  isEncryptedEmailData,
  maskSecretFields,
} = require('../../src/utils/emailQueueEncryption');

const originalKey = process.env.EMAIL_QUEUE_ENCRYPTION_KEY;

beforeEach(() => {
  process.env.EMAIL_QUEUE_ENCRYPTION_KEY = 'queue-encryption-test-key-at-least-32-characters';
});

afterAll(() => {
  if (originalKey === undefined) delete process.env.EMAIL_QUEUE_ENCRYPTION_KEY;
  else process.env.EMAIL_QUEUE_ENCRYPTION_KEY = originalKey;
});

test('account-recovery variables are authenticated ciphertext at rest', () => {
  const recipient = 'Admin@Example.com';
  const data = { invite_link: `https://photos.example/invite/${'a'.repeat(64)}`, role_name: 'Admin' };
  const encrypted = encryptEmailData('admin_invitation', data, recipient);

  expect(isEncryptedEmailData(encrypted)).toBe(true);
  expect(JSON.stringify(encrypted)).not.toContain(data.invite_link);
  expect(decryptEmailData('admin_invitation', encrypted, ' admin@example.com ')).toEqual(data);
  expect(() => decryptEmailData('customer_invitation', encrypted, recipient))
    .toThrow(/could not be decrypted/i);
  expect(() => decryptEmailData('admin_invitation', encrypted, 'other@example.com'))
    .toThrow(/could not be decrypted/i);
});

test('ordinary email variables are not encrypted', () => {
  const data = { event_name: 'Wedding' };
  expect(encryptEmailData('gallery_expired', data, 'guest@example.com')).toBe(data);
  expect(decryptEmailData('gallery_expired', data, 'guest@example.com')).toBe(data);
});

test('password fields of ordinary email are sealed one by one', () => {
  const recipient = 'Client@Example.com';
  const data = {
    customer_name: 'Ada', gallery_password: 'Sunset-42!', client_password: '7788',
    nested: { pin: '1234' }, untouched: 'No password required',
  };
  const sealed = encryptEmailData('gallery_created', data, recipient);
  const stored = JSON.stringify(sealed);
  expect(stored).not.toContain('Sunset-42!');
  expect(stored).not.toContain('7788');
  expect(stored).not.toContain('1234');
  expect(sealed.customer_name).toBe('Ada');
  expect(isEncryptedEmailData(sealed)).toBe(false);
  // sealing again is a no-op; sentinels stay readable
  expect(encryptEmailData('gallery_created', sealed, recipient)).toBe(sealed);
  expect(decryptEmailData('gallery_created', sealed, ' client@example.com ')).toEqual(data);
  expect(maskSecretFields(sealed, '••').gallery_password).toBe('••');

  // bound to the type, the recipient and the field
  expect(() => decryptEmailData('gallery_expired', sealed, recipient)).toThrow(/could not be decrypted/i);
  expect(() => decryptEmailData('gallery_created', sealed, 'other@example.com')).toThrow(/could not be decrypted/i);
  const swapped = { ...sealed, gallery_password: sealed.client_password };
  expect(() => decryptEmailData('gallery_created', swapped, recipient)).toThrow(/could not be decrypted/i);
});

test('plaintext account-recovery variables fail closed', () => {
  expect(() => decryptEmailData(
    'admin_password_reset', { new_password: 'plaintext-secret' }, 'admin@example.com',
  )).toThrow(/not encrypted/i);
});

test('marker-shaped caller data is rejected instead of trusted', () => {
  const real = encryptEmailData('customer_password_reset', { reset_link: 'inside' }, 'customer@example.com');
  const marker = real.__picpeak_encrypted_email_v1;
  const disguised = { __picpeak_encrypted_email_v1: marker, reset_link: 'raw-secret' };
  expect(isEncryptedEmailData(disguised)).toBe(false);
  expect(() => encryptEmailData('customer_password_reset', disguised, 'customer@example.com'))
    .toThrow(/reserved/i);

  const structurallyValidFake = {
    __picpeak_encrypted_email_v1: `AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.${'f'.repeat(64)}`,
  };
  expect(isEncryptedEmailData(structurallyValidFake)).toBe(true);
  expect(() => encryptEmailData('customer_password_reset', structurallyValidFake, 'customer@example.com'))
    .toThrow(/reserved/i);
  expect(isEncryptedEmailData({ __picpeak_encrypted_email_v1: 'not.an.envelope' })).toBe(false);
});

test('tamper and key rotation fail closed', () => {
  const type = 'customer_password_reset';
  const recipient = 'customer@example.com';
  const encrypted = encryptEmailData(type, { reset_link: 'secret' }, recipient);
  const envelopeKey = Object.keys(encrypted)[0];
  const [iv, encodedTag, ciphertext] = encrypted[envelopeKey].split('.');
  const tag = Buffer.from(encodedTag, 'base64url');
  const changedTag = Buffer.from(tag);
  changedTag[0] ^= 0xff;
  const tampered = { [envelopeKey]: [iv, changedTag.toString('base64url'), ciphertext].join('.') };
  expect(() => decryptEmailData(type, tampered, recipient)).toThrow(/could not be decrypted/i);
  const truncatedTag = { [envelopeKey]: [iv, tag.subarray(0, 4).toString('base64url'), ciphertext].join('.') };
  expect(() => decryptEmailData(type, truncatedTag, recipient)).toThrow(/could not be decrypted/i);

  process.env.EMAIL_QUEUE_ENCRYPTION_KEY = 'a-different-queue-key-that-is-also-long-enough';
  expect(() => decryptEmailData(type, encrypted, recipient)).toThrow(/could not be decrypted/i);
});
