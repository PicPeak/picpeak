const { createBuildProgress } = require('../../src/services/downloadJobProgress');

afterEach(() => jest.useRealTimers());

it('lets a healthy long build continue, then rejects stalled work and a late result', async () => {
  jest.useFakeTimers();
  const progress = createBuildProgress(1000);
  let finish;
  const waiting = progress.wait(new Promise((resolve) => { finish = resolve; }));
  const failed = expect(waiting).rejects.toThrow(/stopped making progress/);
  try {
    for (let i = 0; i < 5; i += 1) {
      await jest.advanceTimersByTimeAsync(900); progress.touch();
      expect(progress.signal.aborted).toBe(false);
    }
    await jest.advanceTimersByTimeAsync(2000);
    await failed;
    finish('late source');
    await expect(progress.wait(Promise.resolve('another late result'))).rejects.toThrow(/stopped making progress/);
  } finally { progress.close(); }
});
