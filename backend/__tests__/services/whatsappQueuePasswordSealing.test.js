/**
 * The WhatsApp gallery notice carries the gallery password. While the row
 * waits it is sealed (utils/emailQueueEncryption); once the row is final
 * (sent, or out of retries) only the archive mask is left.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'whatsapp-seal-test-secret';

const mockSend = jest.fn();
jest.mock('../../src/services/whatsappService', () => ({
  sendWhatsAppMessage: (...args) => mockSend(...args),
}));

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');
const { MASK } = require('../../src/utils/emailSecretRedaction');

jest.setTimeout(120000);

const PASSWORD = 'Harbour-77!';
let db; let cleanup;

const storedText = async (id) => {
  const raw = (await db('whatsapp_queue').where('id', id).first()).message_data;
  return typeof raw === 'string' ? raw : JSON.stringify(raw);
};

async function queue(phone) {
  const { queueWhatsapp } = require('../../src/services/whatsappProcessor');
  await queueWhatsapp(null, phone, 'gallery_created', {
    customer_name: 'Ada', event_name: 'Harbour Wedding', gallery_link: 'https://photos.example/g/harbour',
    gallery_password: PASSWORD, expiry_date: null, language: null,
  });
  return (await db('whatsapp_queue').where({ recipient_phone: phone }).first()).id;
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  await seedMinimal(db);
  await db('whatsapp_configs').insert({
    enabled: true, phone_number_id: '123', access_token: 'token', template_name: 'gallery_ready',
  });
});

afterAll(async () => { if (cleanup) await cleanup(); });
beforeEach(() => mockSend.mockReset());

test('a queued WhatsApp holds no plaintext password, sends it, and keeps only the mask', async () => {
  const id = await queue('+491700000001');
  expect(await storedText(id)).not.toContain(PASSWORD);

  mockSend.mockResolvedValue({});
  const { processWhatsAppQueue } = require('../../src/services/whatsappProcessor');
  await processWhatsAppQueue();

  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockSend.mock.calls[0][3].join('\n')).toContain(PASSWORD);
  const row = await db('whatsapp_queue').where('id', id).first();
  expect(row.status).toBe('sent');
  expect(JSON.parse(await storedText(id)).gallery_password).toBe(MASK);
  expect(JSON.parse(await storedText(id)).event_name).toBe('Harbour Wedding');
});

test('a transient failure keeps the password sealed for the retry, a permanent one masks it', async () => {
  const id = await queue('+491700000002');
  const { processWhatsAppQueue } = require('../../src/services/whatsappProcessor');

  mockSend.mockRejectedValueOnce(new Error('meta down'));
  await processWhatsAppQueue();
  let row = await db('whatsapp_queue').where('id', id).first();
  expect(row.status).toBe('pending');
  expect(row.retry_count).toBe(1);
  expect(await storedText(id)).not.toContain(PASSWORD);

  mockSend.mockResolvedValueOnce({});
  await processWhatsAppQueue();
  expect(mockSend.mock.calls[1][3].join('\n')).toContain(PASSWORD);
  row = await db('whatsapp_queue').where('id', id).first();
  expect(row.status).toBe('sent');

  const failing = await queue('+491700000003');
  mockSend.mockRejectedValue(new Error('meta down'));
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await processWhatsAppQueue();
  }
  row = await db('whatsapp_queue').where('id', failing).first();
  expect(row.status).toBe('failed');
  expect(JSON.parse(await storedText(failing)).gallery_password).toBe(MASK);
});
