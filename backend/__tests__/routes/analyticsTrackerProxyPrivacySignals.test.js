/**
 * Which opted-out requests the relay refuses (issue 1921).
 *
 * Global Privacy Control is always an opt-out. Do Not Track is one unless the
 * operator switched "Honour Do Not Track" off; a setting that cannot be read
 * honours it. No collector is configured here, so a request that gets past
 * the check answers 404 (nothing to relay to) instead of 204 (dropped).
 */
const express = require('express');
const request = require('supertest');

const mockSettings = {};
let mockFailRead = false;
jest.mock('../../src/utils/appSettings', () => ({
  getAppSetting: async (key, fallback = null) => {
    if (mockFailRead) throw new Error('database down');
    return Object.hasOwn(mockSettings, key) ? mockSettings[key] : fallback;
  },
}));
jest.mock('../../src/utils/logger', () => ({ warn: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/utils/frontendUrl', () => ({ getFrontendBaseUrl: async () => 'https://picpeak.example' }));

const EVENT = { type: 'pageview', path: '/gallery/wedding', hostname: 'picpeak.example', language: 'en', screenWidth: 1280, screenHeight: 800 };
const DROPPED = 204;
const PASSED_ON = 404;

function post(headers) {
  jest.resetModules();
  const app = express();
  app.use('/api/analytics/tracker', require('../../src/routes/analyticsTrackerProxy'));
  return request(app).post('/api/analytics/tracker/events').set(headers).send(EVENT);
}

beforeEach(() => {
  mockFailRead = false;
  for (const key of Object.keys(mockSettings)) delete mockSettings[key];
});

it('drops a Do Not Track request by default, and when the setting says so', async () => {
  expect((await post({ DNT: '1' })).status).toBe(DROPPED);
  mockSettings.analytics_honor_do_not_track = true;
  expect((await post({ DNT: '1' })).status).toBe(DROPPED);
});

it('relays a Do Not Track request once the operator switched that off', async () => {
  mockSettings.analytics_honor_do_not_track = false;
  expect((await post({ DNT: '1' })).status).toBe(PASSED_ON);
});

it('reads a stored string the way the public settings do', async () => {
  mockSettings.analytics_honor_do_not_track = 'false';
  expect((await post({ DNT: '1' })).status).toBe(PASSED_ON);
  mockSettings.analytics_honor_do_not_track = 'true';
  expect((await post({ DNT: '1' })).status).toBe(DROPPED);
});

it('always drops Global Privacy Control, whatever the setting', async () => {
  mockSettings.analytics_honor_do_not_track = false;
  expect((await post({ 'Sec-GPC': '1' })).status).toBe(DROPPED);
  expect((await post({ 'Sec-GPC': '1', DNT: '1' })).status).toBe(DROPPED);
});

it('drops a Do Not Track request when the setting cannot be read', async () => {
  mockSettings.analytics_honor_do_not_track = false;
  mockFailRead = true;
  expect((await post({ DNT: '1' })).status).toBe(DROPPED);
});

it('lets a request without either signal through', async () => {
  expect((await post({})).status).toBe(PASSED_ON);
});
