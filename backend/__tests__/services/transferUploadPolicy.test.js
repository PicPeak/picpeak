'use strict';

/**
 * PicTransfer upload policy + opaque delivery (#1544).
 *
 * These pin the three promises the "accept all file types" toggle rests on:
 *   1. the allowlist is the admin's, not fileSecurityUtils' media registry;
 *   2. an accepted file is stored under a name that carries no extension;
 *   3. it is handed back as an opaque attachment, whatever the client called it.
 */

const {
  normalizeAllowedTypes,
  validateTransferFileType,
  allowedExtensionList,
  opaqueStoredName,
  attachmentHeaders,
} = require('../../src/services/transferUploadPolicy');

const policyOf = (types, acceptAll = false) => ({
  acceptAll,
  allowedTypes: normalizeAllowedTypes(types),
  maxSizeMb: 50,
});

describe('normalizeAllowedTypes', () => {
  it('accepts the {mime, extensions} shape and lowercases/dot-prefixes extensions', () => {
    expect(normalizeAllowedTypes([{ mime: 'Image/PNG', extensions: ['PNG', '.PnG'] }]))
      .toEqual([{ mime: 'image/png', extensions: ['.png'] }]);
  });

  it('tolerates the legacy flat MIME list and fills in known extensions', () => {
    expect(normalizeAllowedTypes(['application/zip']))
      .toEqual([{ mime: 'application/zip', extensions: ['.zip'] }]);
  });

  it('merges duplicate entries for one MIME rather than letting the first win', () => {
    expect(normalizeAllowedTypes([
      { mime: 'image/jpeg', extensions: ['.jpg'] },
      { mime: 'image/jpeg', extensions: ['.jpeg'] },
    ])).toEqual([{ mime: 'image/jpeg', extensions: ['.jpg', '.jpeg'] }]);
  });

  it('drops entries that are not a MIME type at all', () => {
    expect(normalizeAllowedTypes(['notamime', '', null, 42, { mime: 'x' }])).toEqual([]);
  });
});

describe('validateTransferFileType', () => {
  it('admits ZIP and TIFF — seeded as allowed since 170, rejected until now', () => {
    // Neither has an entry in fileSecurityUtils' ALLOWED_* registry, so the old
    // validateFileType path refused both however the setting was configured.
    const policy = policyOf(['application/zip', 'image/tiff']);
    expect(validateTransferFileType('assets.zip', 'application/zip', policy)).toBe(true);
    expect(validateTransferFileType('scan.tif', 'image/tiff', policy)).toBe(true);
  });

  describe('the browser\'s MIME is a guess, so a listed extension wins', () => {
    // The ZIP fix does not hold if the entry is looked up by MIME first:
    // Chrome and Firefox on Windows send application/x-zip-compressed, and
    // .dng/.psd/.heic routinely arrive as octet-stream or with no type at all.
    const policy = policyOf(['application/zip', { mime: 'image/x-adobe-dng', extensions: ['.dng'] }]);

    it.each([
      ['application/x-zip-compressed', 'assets.zip'],
      ['application/octet-stream', 'assets.zip'],
      ['', 'assets.zip'],
      ['application/octet-stream', 'shoot.dng'],
      ['', 'shoot.dng'],
    ])('admits %s named %s', (mime, name) => {
      expect(validateTransferFileType(name, mime, policy)).toBe(true);
    });

    it('still refuses an unlisted extension whatever the MIME claims', () => {
      expect(validateTransferFileType('payload.html', 'application/zip', policy)).toBe(false);
      expect(validateTransferFileType('payload.html', 'image/png', policyOf(['image/png']))).toBe(false);
      expect(validateTransferFileType('macro.exe', 'application/octet-stream', policy)).toBe(false);
    });

    it('refuses a file with no extension when no entry matches on MIME alone', () => {
      expect(validateTransferFileType('noextension', 'application/octet-stream', policy)).toBe(false);
    });
  });

  it('admits a type the built-in registry has never heard of', () => {
    const policy = policyOf([{ mime: 'image/vnd.adobe.photoshop', extensions: ['.psd'] }]);
    expect(validateTransferFileType('logo.psd', 'image/vnd.adobe.photoshop', policy)).toBe(true);
  });

  it('rejects a MIME that is not on the list', () => {
    expect(validateTransferFileType('x.exe', 'application/x-msdownload', policyOf(['image/png']))).toBe(false);
  });

  it('rejects a listed MIME carrying an extension that entry does not claim', () => {
    // The classic "image/png" label on a .html file.
    expect(validateTransferFileType('payload.html', 'image/png', policyOf(['image/png']))).toBe(false);
  });

  it('matches on MIME alone when the admin listed no extensions', () => {
    // An admin adding a long office MIME without guessing its extension means
    // "allow this type"; inventing a rule we cannot verify would reject the
    // very file they were trying to admit.
    const policy = policyOf([{ mime: 'application/vnd.ms-project', extensions: [] }]);
    expect(validateTransferFileType('plan.mpp', 'application/vnd.ms-project', policy)).toBe(true);
  });

  it('ignores charset parameters on the MIME', () => {
    expect(validateTransferFileType('a.zip', 'application/zip; charset=binary', policyOf(['application/zip'])))
      .toBe(true);
  });

  describe('accept-all', () => {
    it('admits anything when on', () => {
      const policy = policyOf(['image/png'], true);
      expect(validateTransferFileType('whatever.xyz', 'application/x-weird', policy)).toBe(true);
      expect(validateTransferFileType('shell.php', 'application/x-httpd-php', policy)).toBe(true);
    });

    it('still refuses those exact files when off', () => {
      const policy = policyOf(['image/png'], false);
      expect(validateTransferFileType('whatever.xyz', 'application/x-weird', policy)).toBe(false);
      expect(validateTransferFileType('shell.php', 'application/x-httpd-php', policy)).toBe(false);
    });
  });

  it('refuses everything without a policy rather than failing open', () => {
    expect(validateTransferFileType('a.png', 'image/png', null)).toBe(false);
  });
});

describe('getTransferUploadPolicy fallback chain', () => {
  // The distinction that matters: an ABSENT key means "never configured, use
  // the defaults"; a key holding an empty list means "the admin removed
  // everything". Collapsing them re-permits types that were deliberately taken
  // away, which is the §17 empty-means-unconfigured shape.
  const load = async (settings) => {
    jest.resetModules();
    jest.doMock('../../src/utils/appSettings', () => ({
      getAppSetting: async (key, fallback) => (key in settings ? settings[key] : fallback),
    }));
    // eslint-disable-next-line global-require
    return require('../../src/services/transferUploadPolicy').getTransferUploadPolicy();
  };

  afterEach(() => { jest.resetModules(); jest.dontMock('../../src/utils/appSettings'); });

  it('uses the seeded defaults when neither key has ever been written', async () => {
    const policy = await load({});
    const mimes = policy.allowedTypes.map((t) => t.mime);
    expect(mimes).toContain('application/zip');
    // Windows sends this one; a stock instance has to take it.
    expect(mimes).toContain('application/x-zip-compressed');
  });

  it('reads the legacy flat MIME list when only that exists', async () => {
    const policy = await load({ transfer_upload_allowed_mime: ['image/svg+xml'] });
    expect(policy.allowedTypes).toEqual([{ mime: 'image/svg+xml', extensions: ['.svg'] }]);
  });

  it('honours an explicitly emptied list instead of restoring the defaults', async () => {
    const policy = await load({ transfer_upload_allowed_types: [] });
    expect(policy.allowedTypes).toEqual([]);
    // Fail closed: nothing is accepted, rather than jpeg/png/pdf/zip coming back.
    expect(validateTransferFileType('a.zip', 'application/zip', policy)).toBe(false);
  });

  it('never turns a missing or empty list into accept-all', async () => {
    for (const settings of [{}, { transfer_upload_allowed_types: [] }]) {
      expect((await load(settings)).acceptAll).toBe(false);
    }
  });

  it('reads accept-all from the string the settings row stores', async () => {
    expect((await load({ transfer_upload_accept_all: 'true' })).acceptAll).toBe(true);
    expect((await load({ transfer_upload_accept_all: false })).acceptAll).toBe(false);
  });
});

describe('allowedExtensionList', () => {
  it('flattens and de-duplicates for the upload page hint', () => {
    expect(allowedExtensionList(policyOf(['image/jpeg', 'application/pdf'])))
      .toEqual(['.jpeg', '.jpg', '.pdf']);
  });
});

describe('opaqueStoredName', () => {
  it('never keeps a renderable extension', () => {
    for (const name of ['index.html', 'logo.svg', 'x.js', 'shell.php', 'doc.pdf']) {
      const stored = opaqueStoredName('deadbeef');
      expect(stored).toBe('deadbeef.bin');
      expect(stored.endsWith('.bin')).toBe(true);
      // The client's name never reaches the stored key at all.
      expect(stored).not.toContain(name.split('.').pop());
    }
  });
});

describe('attachmentHeaders', () => {
  it('refuses to echo a client-supplied renderable type', () => {
    for (const mime of [
      'text/html', 'image/svg+xml', 'application/xml', 'application/pdf',
      'text/plain', 'application/xhtml+xml', 'application/x-httpd-php',
    ]) {
      expect(attachmentHeaders('x', mime)['Content-Type']).toBe('application/octet-stream');
    }
  });

  it('echoes only the inert types on the safe list', () => {
    expect(attachmentHeaders('a.png', 'image/png')['Content-Type']).toBe('image/png');
    expect(attachmentHeaders('a.mp4', 'video/mp4')['Content-Type']).toBe('video/mp4');
  });

  it('falls back to octet-stream for a missing or junk MIME', () => {
    expect(attachmentHeaders('a', null)['Content-Type']).toBe('application/octet-stream');
    expect(attachmentHeaders('a', 'not a mime')['Content-Type']).toBe('application/octet-stream');
  });

  it('always sends attachment, nosniff and a sandboxing CSP', () => {
    const h = attachmentHeaders('a.png', 'image/png');
    expect(h['Content-Disposition']).toMatch(/^attachment;/);
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['Content-Security-Policy']).toBe('default-src \'none\'; sandbox');
  });

  it('carries an RFC 5987 filename* so umlauts survive', () => {
    // The routes used to percent-encode inside the plain filename= token, which
    // showed the recipient a literal "Gru%CC%88sse.jpg".
    const h = attachmentHeaders('Grüße Bericht.pdf', 'application/pdf');
    expect(h['Content-Disposition']).toContain('filename*=UTF-8\'\'');
    expect(h['Content-Disposition']).toContain('Gr%C3%BC%C3%9Fe');
  });

  it('cannot be used to inject a header', () => {
    const h = attachmentHeaders('evil\r\nX-Injected: 1.png', 'image/png');
    expect(h['Content-Disposition']).not.toMatch(/[\r\n]/);
  });
});
