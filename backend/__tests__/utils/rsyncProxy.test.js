const { EventEmitter } = require('events');
const net = require('net');
const { connectApprovedAddresses } = require('../../src/utils/rsyncProxy');

afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });
function socket() {
  const value = new EventEmitter(); value.destroy = jest.fn(); return value;
}

test('tries the next vetted literal on pre-connect failure without any DNS lookup', async () => {
  const first = socket(); const second = socket();
  const connect = jest.spyOn(net, 'createConnection').mockReturnValueOnce(first).mockReturnValueOnce(second);
  const result = connectApprovedAddresses(['8.8.4.4', '8.8.8.8']);
  first.emit('error', new Error('ECONNREFUSED')); second.emit('connect');
  await expect(result).resolves.toBe(second);
  expect(connect.mock.calls.map(([options]) => options.host)).toEqual(['8.8.4.4', '8.8.8.8']);
  expect(connect.mock.calls.every(([options]) => options.port === 22 && options.family === 4)).toBe(true);
  const callback = jest.fn(); connect.mock.calls[0][0].lookup('rebound.example.com', {}, callback);
  expect(callback).toHaveBeenCalledWith(expect.any(Error));
  expect(first.destroy).toHaveBeenCalled();
});

test.each([['8.8.8.8', '127.0.0.1'], ['evil.example.com'], ['ff02::1'], ['::ffff:127.0.0.1'], []].map(addresses => [addresses]))
('validates the complete literal set %j before opening any socket', async addresses => {
  const connect = jest.spyOn(net, 'createConnection');
  await expect(connectApprovedAddresses(addresses)).rejects.toThrow(/public IP literals/);
  expect(connect).not.toHaveBeenCalled();
});

test('never retries after a socket connects, including a later authentication/stream failure', async () => {
  const first = socket(); const connect = jest.spyOn(net, 'createConnection').mockReturnValue(first);
  const result = connectApprovedAddresses(['8.8.4.4', '8.8.8.8']); first.emit('connect'); await result;
  first.emit('error', new Error('later protocol failure'));
  expect(connect).toHaveBeenCalledTimes(1);
});

test('cancellation destroys pending work and prevents later address attempts', async () => {
  const first = socket(); const connect = jest.spyOn(net, 'createConnection').mockReturnValue(first);
  const controller = new AbortController();
  const result = connectApprovedAddresses(['8.8.4.4', '8.8.8.8'], { signal: controller.signal });
  controller.abort();
  await expect(result).rejects.toThrow(/cancelled/);
  first.emit('error', new Error('late error'));
  expect(first.destroy).toHaveBeenCalled(); expect(connect).toHaveBeenCalledTimes(1);
});

test('a timed-out connect is destroyed before trying the next approved address', async () => {
  jest.useFakeTimers();
  const first = socket(); const second = socket();
  const connect = jest.spyOn(net, 'createConnection').mockReturnValueOnce(first).mockReturnValueOnce(second);
  const result = connectApprovedAddresses(['8.8.4.4', '8.8.8.8'], { timeoutMs: 50 });
  jest.advanceTimersByTime(50); second.emit('connect');
  await expect(result).resolves.toBe(second);
  expect(first.destroy).toHaveBeenCalled(); expect(connect).toHaveBeenCalledTimes(2);
  expect(jest.getTimerCount()).toBe(0);
});

test('connects to the configured SSH port and refuses anything that is not one', async () => {
  const first = socket(); const connect = jest.spyOn(net, 'createConnection').mockReturnValue(first);
  const result = connectApprovedAddresses(['8.8.8.8'], { port: 2222 }); first.emit('connect'); await result;
  expect(connect.mock.calls[0][0].port).toBe(2222);
  connect.mockClear();
  for (const port of [0, 65536, NaN, '2222', 22.5]) {
    await expect(connectApprovedAddresses(['8.8.8.8'], { port })).rejects.toThrow(/port from 1 to 65535/);
  }
  expect(connect).not.toHaveBeenCalled();
});
