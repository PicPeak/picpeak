const jobService = require('../../../services/downloadJobService');

describe('photo sales download job identity', () => {
  it('never reuses a job built before the gallery was priced', () => {
    const unpriced = jobService.dedupKey(1, 'original', [1, 2, 3], null, 'public');
    const priced = jobService.dedupKey(1, 'original', [1, 2, 3], null, 'public', true);
    expect(priced).not.toBe(unpriced);
  });

  it('keeps unpriced keys identical to upstream', () => {
    expect(jobService.dedupKey(1, 'original', [1, 2, 3], null, 'public', false))
      .toBe(jobService.dedupKey(1, 'original', [1, 2, 3], null, 'public'));
  });
});
