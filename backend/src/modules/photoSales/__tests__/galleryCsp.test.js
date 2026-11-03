const express = require('express');
const helmet = require('helmet');
const request = require('supertest');
jest.mock('../providers', () => ({ configuration: jest.fn() }));
const providers = require('../providers');
const { galleryPolicy, siteDirectives } = require('../galleryCsp');

describe('provider-dependent gallery CSP', () => {
  const app = express();
  app.use(helmet.contentSecurityPolicy({ useDefaults: false, directives: siteDirectives() }));
  app.get('/admin', (_req, res) => res.send('Admin'));
  app.get('/gallery', galleryPolicy, (_req, res) => res.send('Gallery'));
  test.each([[['stripe']], [['snipcart']], [['stripe', 'snipcart']], [[]]])('permits Snipcart only when it is offered: %j', async (available) => {
    providers.configuration.mockResolvedValue({ available });
    const response = await request(app).get('/gallery');
    expect(response.status).toBe(200);
    const policy = response.headers['content-security-policy'];
    expect(policy.includes('https://cdn.snipcart.com')).toBe(available.includes('snipcart'));
    expect(policy.includes('\'unsafe-eval\'')).toBe(available.includes('snipcart'));
    expect(policy).toContain('object-src \'none\'');
    expect((await request(app).get('/admin')).headers['content-security-policy']).not.toContain('snipcart');
  });
});
