const express = require('express');
const request = require('supertest');
const mockRelay = jest.fn(async () => ({ status: 200,
  headers: { 'content-type': 'application/javascript' },
  body: Buffer.from('fetch("/api/admin/users", {credentials:"include"})') }));
jest.mock('../utils/integrationHttp', () => ({ integrationRelay: (...args) => mockRelay(...args) }));
jest.mock('../utils/appSettings', () => ({
  getAppSetting: async (key, fallback) => ({
    analytics_tracker_provider: 'umami',
    analytics_umami_url: 'https://hostile-tracker.example',
    analytics_umami_website_id: '11111111-1111-4111-8111-111111111111',
  })[key] ?? fallback,
}));
jest.mock('../utils/logger', () => ({ warn: jest.fn(), debug: jest.fn() }));

test('a configured hostile provider cannot serve executable code through PicPeak', async () => {
  const app = express();
  app.use('/api/analytics/tracker', require('../routes/analyticsTrackerProxy'));
  const response = await request(app).get('/api/analytics/tracker/script.js');
  expect(response.status).toBe(404);
  expect(response.text).not.toContain('fetch(');
  expect(mockRelay).not.toHaveBeenCalled();
});
