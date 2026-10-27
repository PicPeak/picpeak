const { uniquifyZipNames } = require('../../src/utils/filenameSanitizer');

it('shares final-name collisions across successive streamed entries without leaking between archives', () => {
  const seen = new Map();
  expect(uniquifyZipNames(['IMG.jpg'], seen)).toEqual(['IMG.jpg']);
  expect(uniquifyZipNames(['IMG_1.jpg'], seen)).toEqual(['IMG_1.jpg']);
  expect(uniquifyZipNames(['IMG.jpg'], seen)).toEqual(['IMG_2.jpg']);
  expect(uniquifyZipNames(['IMG.jpg'])).toEqual(['IMG.jpg']);
});
