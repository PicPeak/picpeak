const Backend = require('i18next-http-backend');
const sharp = require('sharp');

function read(loadPath, language, namespace) {
  const requests = [];
  const backend = new Backend(null, {
    loadPath,
    request: (_options, url, _payload, callback) => {
      requests.push(url);
      callback(null, { status: 200, data: '{"translated":"ok"}' });
    },
  });
  return new Promise(resolve => backend.read(language, namespace,
    (error, data) => resolve({ requests, error, data })));
}

describe('patched native image and translation dependencies', () => {
  it('loads patched bundled librsvg rather than the vulnerable native component', () => {
    expect(sharp.versions.sharp).toBe(require('../../package.json').dependencies.sharp);
    const [major, minor, patch] = (sharp.versions.rsvg || '').split('.').map(Number);
    expect(Number.isFinite(major) && (major > 2 || (major === 2
      && (minor > 63 || (minor === 63 && patch >= 2))))).toBe(true);
  });

  it('keeps benign SVG logos, SVG composition and JPEG/PNG transforms working', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="red"/><text x="2" y="18" font-size="8">PicPeak</text></svg>');
    const png = await sharp(svg).resize(16, 16).png().toBuffer({ resolveWithObject: true });
    expect(png.info).toMatchObject({ format: 'png', width: 16, height: 16 });
    const jpeg = await sharp(png.data).composite([{ input: svg, top: 0, left: 0,
      density: 36 }]).jpeg().toBuffer();
    expect(await sharp(jpeg).metadata()).toMatchObject({ format: 'jpeg', width: 16, height: 16 });
  });

  it.each([
    ['{{lng}}/{{ns}}.json', 'http:127.0.0.1:1234', 'translation'],
    ['{{ns}}.json', 'en', 'http:127.0.0.1:1234/translation'],
    ['{{ns}}.json', 'en', '//collector.invalid/translation'],
  ])('refuses URL-control inputs before making a request (%s)', async (path, language, namespace) => {
    const result = await read(path, language, namespace);
    expect(result.error).toBeTruthy();
    expect(result.requests).toEqual([]);
  });

  it('retains ordinary regional language and translation namespace loading', async () => {
    const result = await read('/locales/{{lng}}/{{ns}}.json', 'de-DE', 'translation');
    expect(result.error).toBeFalsy();
    expect(result.requests).toEqual(['/locales/de-DE/translation.json']);
    expect(result.data).toEqual({ translated: 'ok' });
  });
});
