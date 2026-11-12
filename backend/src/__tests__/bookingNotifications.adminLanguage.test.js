/**
 * The business notice for a booking request reuses the client's mail
 * variables. Its dates were formatted in the client's language, so a French
 * request put "10 novembre 2026" into the studio's English notice. They are
 * formatted again in the admin's language (issue 2489 made formatDate name
 * months in every app language, which would have spread this).
 */

jest.mock('../database/db', () => ({ logActivity: jest.fn().mockResolvedValue() }));
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../utils/frontendUrl', () => ({ getFrontendBaseUrl: jest.fn().mockResolvedValue('https://studio.example') }));
jest.mock('../utils/dateFormatter', () => ({ formatDate: jest.fn(async (day, lang) => `${lang}:${day}`) }));
jest.mock('../services/emailProcessor', () => ({ queueEmail: jest.fn().mockResolvedValue() }));
jest.mock('../services/businessProfileService', () => ({ getProfile: jest.fn() }));
jest.mock('../services/bookingService', () => ({
  workingHours: jest.fn().mockResolvedValue({ timezone: 'Europe/Berlin' }),
}));

const emailProcessor = require('../services/emailProcessor');
const businessProfileService = require('../services/businessProfileService');
const { notifyReceived } = require('../services/bookingNotifications');

const request = {
  id: 7,
  reference: 'BR-7',
  name: 'Claire',
  email: 'claire@example.fr',
  language: 'fr',
  service_name: 'Portrait',
  starts_at: '2026-11-10T09:00:00.000Z',
  hold_expires_at: '2026-11-08T17:00:00.000Z',
  estimate_minor: 25000,
  currency: 'EUR',
};

const sent = (type) => emailProcessor.queueEmail.mock.calls.find((call) => call[2] === type)[3];

beforeEach(() => emailProcessor.queueEmail.mockClear());

it('formats the client mail in the client language and the notice in the admin language', async () => {
  businessProfileService.getProfile.mockResolvedValue({ profile: { email: 'studio@example.com', default_locale: 'en' } });
  await notifyReceived(request);

  expect(sent('booking_request_received')).toMatchObject({
    booking_date: 'fr:2026-11-10', hold_until: 'fr:2026-11-08 18:00', __language: 'fr',
  });
  expect(sent('booking_request_admin')).toMatchObject({
    booking_date: 'en:2026-11-10', hold_until: 'en:2026-11-08 18:00', __language: 'en', booking_time: '10:00',
  });
});

it('keeps the client dates when both speak the same language', async () => {
  businessProfileService.getProfile.mockResolvedValue({ profile: { email: 'studio@example.com', default_locale: 'fr' } });
  await notifyReceived(request);
  expect(sent('booking_request_admin')).toMatchObject({ booking_date: 'fr:2026-11-10', __language: 'fr' });
});
