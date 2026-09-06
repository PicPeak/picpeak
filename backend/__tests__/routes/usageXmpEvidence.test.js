const express = require('express');
const request = require('supertest');
const mockExport = jest.fn();
const mockMarkUsed = jest.fn().mockResolvedValue();
jest.mock('../../src/database/db', () => ({
  db: jest.fn(() => ({ where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue({ id: 1 }) })),
  withRetry: fn => fn()
}));
jest.mock('../../src/middleware/auth', () => ({ adminAuth: (req, res, next) => {
  if (!req.headers.authorization) return res.sendStatus(401);
  req.admin = { id: 1 }; next();
} }));
jest.mock('../../src/middleware/permissions', () => ({ requirePermission: () => (_req, _res, next) => next() }));
jest.mock('../../src/middleware/ownership', () => ({ requireEventOwnership: (_req, _res, next) => next() }));
jest.mock('../../src/services/photoExportService', () => ({ PhotoExportService: jest.fn().mockImplementation(() => ({ exportPhotos: mockExport })) }));
jest.mock('../../src/services/photoAdminMarksService', () => ({}));
jest.mock('../../src/services/feedbackService', () => ({}));
jest.mock('../../src/services/productUsageService', () => ({ markUsed: (...args) => mockMarkUsed(...args) }));
const { productUsage } = require('../../src/middleware/productUsage');
const router = require('../../src/routes/adminPhotoExport');
const app = express();
app.use(express.json());
app.use('/admin', productUsage);
app.use('/admin/photo-export', router);

beforeEach(() => { mockMarkUsed.mockClear(); mockExport.mockReset(); });
test('only a successful authenticated XMP export produces the new bit, without request or exported content', async () => {
  mockExport.mockResolvedValue({ type: 'content', contentType: 'text/plain', filename: 'PRIVATE-export.txt', content: 'PRIVATE-content' });
  await request(app).post('/admin/photo-export/1/export').set('Authorization', 'test').send({ photo_ids: [9], format: 'xmp' }).expect(200);
  expect(mockMarkUsed).toHaveBeenCalledWith(['photo_exports', 'photo_xmp_export'], { legacyFeatures: [], destinationBackup: false });
  expect(JSON.stringify(mockMarkUsed.mock.calls)).not.toContain('PRIVATE');
  mockMarkUsed.mockClear();
  await request(app).post('/admin/photo-export/1/export').set('Authorization', 'test').send({ photo_ids: [9], format: 'csv' }).expect(200);
  expect(mockMarkUsed.mock.calls[0][0]).toEqual(['photo_exports']);
});
test('failed, invalid and unauthenticated exports never produce an XMP-use marker', async () => {
  mockExport.mockRejectedValue(new Error('Synthetic export failure'));
  await request(app).post('/admin/photo-export/1/export').set('Authorization', 'test').send({ photo_ids: [9], format: 'xmp' }).expect(500);
  await request(app).post('/admin/photo-export/1/export').set('Authorization', 'test').send({ photo_ids: [9], format: 'unknown' }).expect(400);
  await request(app).post('/admin/photo-export/1/export').send({ photo_ids: [9], format: 'xmp' }).expect(401);
  expect(mockMarkUsed).not.toHaveBeenCalled();
});
