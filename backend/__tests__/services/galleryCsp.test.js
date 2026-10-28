jest.mock('../../src/modules/photoSales/providers', () => ({ configuration: jest.fn() }));
jest.mock('../../src/utils/logger', () => ({ warn: jest.fn() }));
const express = require('express');
const request = require('supertest');
const { configuration } = require('../../src/modules/photoSales/providers');
const { galleryPolicy } = require('../../src/modules/photoSales/galleryCsp');

const app = express();
app.get('/gallery/example', galleryPolicy, (req, res) => res.send('gallery shell'));

it('serves the shell with a strict policy when provider configuration fails', async () => {
  configuration.mockRejectedValueOnce(new Error('Database unavailable'));
  const response = await request(app).get('/gallery/example');
  expect(response.status).toBe(200);
  expect(response.text).toBe('gallery shell');
  expect(response.headers['content-security-policy']).toContain('https://www.google.com');
  expect(response.headers['content-security-policy']).not.toMatch(/snipcart|unsafe-eval/);
});

it('adds Snipcart sources only when the provider is available', async () => {
  configuration.mockResolvedValueOnce({ available: ['snipcart'] });
  const response = await request(app).get('/gallery/example');
  expect(response.headers['content-security-policy']).toContain('https://cdn.snipcart.com');
  configuration.mockResolvedValueOnce({ available: ['stripe'] });
  const strict = await request(app).get('/gallery/example');
  expect(strict.headers['content-security-policy']).not.toMatch(/snipcart|unsafe-eval/);
});
