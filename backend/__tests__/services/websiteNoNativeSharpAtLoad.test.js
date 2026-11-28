/**
 * The website builder (issue 2618) is loaded by server.js whether its flag is
 * on or not. On a host where Sharp's native module cannot initialise (an
 * x86-64 CPU without the v2 instructions), loading it must not throw: image
 * work goes through isolatedSharp's worker, which only starts when used.
 */
jest.mock('sharp', () => { throw new Error('Could not load the "sharp" module: unsupported CPU'); });

test('the website routers and services load without the native Sharp module', () => {
  expect(() => {
    require('../../src/routes/adminWebsite');
    require('../../src/routes/publicWebsite');
    require('../../src/routes/publicWebsiteMedia');
    require('../../src/services/website/assets');
    require('../../src/services/website/service');
  }).not.toThrow();
});
