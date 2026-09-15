/**
 * Merging a document with its attachments (#1445): fixed order, the page
 * range of each part, and the same bytes for the same inputs.
 */

const crypto = require('crypto');
const { PDFDocument } = require('pdf-lib');
const { mergePdfs, insertBeforeLastPage } = require('../../src/services/pdf/merge');

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

async function makePdf(pages, size = [200, 200]) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) doc.addPage(size);
  return Buffer.from(await doc.save());
}

test('keeps the order and reports where each part landed', async () => {
  const parts = [await makePdf(2), await makePdf(3, [300, 300]), await makePdf(1)];
  const { buffer, ranges } = await mergePdfs(parts, { title: 'C-2026-0001', createdAt: '2026-09-14T10:00:00Z' });

  expect(ranges).toEqual([
    { index: 0, start: 0, count: 2 },
    { index: 1, start: 2, count: 3 },
    { index: 2, start: 5, count: 1 },
  ]);
  const merged = await PDFDocument.load(buffer);
  expect(merged.getPageCount()).toBe(6);
  expect(merged.getPage(1).getSize()).toEqual({ width: 200, height: 200 });
  expect(merged.getPage(2).getSize()).toEqual({ width: 300, height: 300 });
  expect(merged.getTitle()).toBe('C-2026-0001');
});

test('the same inputs in the same order give the same bytes', async () => {
  const parts = [await makePdf(1), await makePdf(2)];
  const info = { title: 'C-2026-0001', createdAt: '2026-09-14T10:00:00Z' };
  const first = await mergePdfs(parts, info);
  const second = await mergePdfs(parts, info);
  expect(sha256(first.buffer)).toBe(sha256(second.buffer));
});

test('needs at least one part', async () => {
  await expect(mergePdfs([])).rejects.toThrow();
});

test('attachments go before the last page, which stays last', async () => {
  const contract = await (async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    doc.addPage([200, 200]);
    doc.addPage([400, 400]); // the signature page
    return Buffer.from(await doc.save());
  })();
  const { buffer, ranges, lastPageIndex } = await insertBeforeLastPage(
    contract, [await makePdf(2, [300, 300]), await makePdf(1, [250, 250])], { title: 'C-2026-0001' },
  );
  expect(ranges).toEqual([{ index: 0, start: 2, count: 2 }, { index: 1, start: 4, count: 1 }]);
  const merged = await PDFDocument.load(buffer);
  expect(merged.getPageCount()).toBe(6);
  expect(lastPageIndex).toBe(5);
  expect(merged.getPage(5).getSize()).toEqual({ width: 400, height: 400 });
  expect(merged.getPage(2).getSize()).toEqual({ width: 300, height: 300 });
});

test('with nothing to insert the document is returned as it was', async () => {
  const contract = await makePdf(2);
  const result = await insertBeforeLastPage(contract, []);
  expect(result.buffer).toBe(contract);
  expect(result.lastPageIndex).toBeNull();
});
