const express = require('express');
const request = require('supertest');
const { EventEmitter } = require('events');
const { createWorkRegistry } = require('../../src/services/activeApplicationWork');
const { createApplicationWorkMiddleware, ownRouteHandlers } = require('../../src/middleware/applicationWork');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

describe('HTTP application work ownership', () => {
  it('retains an async handler after its response has finished', async () => {
    const work = createWorkRegistry();
    const gate = deferred();
    const app = express();
    const router = express.Router();
    app.use(createApplicationWorkMiddleware({ work }));
    router.get('/write', async (_req, res) => { res.json({ accepted: true }); await gate.promise; });
    app.use('/nested', router);
    ownRouteHandlers(app, work);
    await request(app).get('/nested/write').expect(200);
    work.closeAdmission();
    let drained = false;
    const drain = work.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    await request(app).get('/nested/write').expect(503);
    gate.resolve();
    await drain;
    expect(work.pendingCount()).toBe(0);
  });

  it('retains the handler when a disconnected client releases the response', async () => {
    const work = createWorkRegistry();
    const gate = deferred();
    const response = new EventEmitter();
    let continued = false;
    const app = express();
    app.use(createApplicationWorkMiddleware({ work }));
    app.get('/write', async (_req, _res) => { await gate.promise; continued = true; });
    ownRouteHandlers(app, work);
    const middleware = app._router.stack.find(layer => layer.name === 'applicationWorkMiddleware').handle;
    const route = app._router.stack.find(layer => layer.route).route.stack[0].handle;
    const received = middleware({}, response, () => route({}, response, error => { throw error; }));
    await Promise.resolve();
    await Promise.resolve();
    response.emit('close');
    await received;
    work.closeAdmission();
    let drained = false;
    const drain = work.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    gate.resolve();
    await drain;
    expect(continued).toBe(true);
  });

  it('preserves synchronous middleware ordering and four-argument error dispatch', async () => {
    const work = createWorkRegistry();
    const app = express();
    const order = [];
    app.use(createApplicationWorkMiddleware({ work }));
    app.use((_req, _res, next) => { order.push('before'); next(); order.push('after'); });
    app.get('/error', async () => { order.push('route'); throw new Error('owned rejection'); });
    app.use((error, _req, res, _next) => res.status(422).json({ error: error.message }));
    ownRouteHandlers(app, work);
    expect((await request(app).get('/error').expect(422)).body).toEqual({ error: 'owned rejection' });
    expect(order).toEqual(['before', 'route', 'after']);
    await work.drain();
  });

  it('holds a pending admission check and does not dispatch after the client disconnects', async () => {
    const work = createWorkRegistry();
    const gate = deferred();
    const response = new EventEmitter();
    const next = jest.fn();
    const middleware = createApplicationWorkMiddleware({ work, admitRequest: () => gate.promise });
    const pending = middleware({}, response, next);
    response.destroyed = true;
    response.emit('close');
    work.closeAdmission();
    let drained = false;
    const drain = work.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    gate.resolve();
    await Promise.all([pending, drain]);
    expect(next).not.toHaveBeenCalled();
    expect(work.pendingCount()).toBe(0);
  });

  it('allows only explicitly selected internal control requests during closure', async () => {
    const work = createWorkRegistry();
    const app = express();
    app.use(createApplicationWorkMiddleware({ work,
      isControlRequest: req => req.method === 'GET' && req.path === '/maintenance-status' }));
    app.get('/maintenance-status', (_req, res) => res.json({ control: work.isControl() }));
    app.get('/write', (_req, res) => res.json({ unexpected: true }));
    ownRouteHandlers(app, work);
    work.closeAdmission();
    expect((await request(app).get('/maintenance-status').expect(200)).body).toEqual({ control: true });
    await request(app).get('/write').set('x-restore-control', 'true').expect(503);
    expect(work.pendingCount()).toBe(0);
  });
});
