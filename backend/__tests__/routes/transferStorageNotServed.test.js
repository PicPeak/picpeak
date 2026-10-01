'use strict';

/**
 * PicTransfer storage is never served as content (#1544).
 *
 * Accepting arbitrary file types — the "accept all" toggle — is only defensible
 * because a stored transfer file is bytes PicPeak hands back, never content it
 * hosts. Every download goes through a route that sets an attachment
 * disposition, nosniff and a sandboxing CSP.
 *
 * That guarantee is one `app.use(express.static(...))` away from being lost,
 * and the loss would be silent: the feature would keep working while every
 * uploaded .html and .svg quietly became a live page on the PicPeak origin.
 *
 * These checks are written to FAIL CLOSED. An earlier version matched only
 * mounts spelled `secureStatic(path.join(storagePath, '<literal>'))`, so a
 * future mount written any other way would have been invisible to it and the
 * test would have passed by matching nothing at all. Now an unrecognised mount
 * form is itself a failure, with the message saying to extend this file.
 *
 * The opaque `.bin` storage keys (see transferUploadPolicy) are the second,
 * independent layer — this is the first.
 */

const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '../../server.js');
const SERVER_SRC = fs.readFileSync(SERVER, 'utf8');

// Where transfer bytes live, relative to the storage root.
// Mirrors transferService.uploadDirKey / extraFilesDirKey.
const TRANSFER_PREFIXES = ['uploads/transfers', 'transfers'];

/** Is `served` the same directory as, or an ancestor/descendant of, `target`? */
function covers(served, target) {
  return target === served || target.startsWith(`${served}/`) || served.startsWith(`${target}/`);
}

/**
 * Every static mount in server.js, as { raw, prefix }.
 *
 * `prefix` is the storage-relative directory when the call is written in a
 * shape we understand, and null when it is not — a null is a failure, not a
 * pass, because we cannot prove an unknown form is safe.
 */
function staticMounts(src) {
  const call = /(?:secureStatic|express\.static)\(/g;
  const mounts = [];
  while (call.exec(src) !== null) {
    // Take the FIRST argument only, by walking parens from the opening one.
    let depth = 1;
    let i = call.lastIndex;
    let arg = '';
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') { depth -= 1; if (depth === 0) break; }
      else if (ch === ',' && depth === 1) break;
      arg += ch;
      i += 1;
    }
    const raw = arg.replace(/\s+/g, ' ').trim();

    // Recognised: a directory under the storage root — the only kind that can
    // reach user uploads, so the only kind whose prefix has to be checked.
    const underStorage = raw.match(/^path\.join\(\s*storagePath\s*,\s*['"]([^'"]+)['"]\s*\)$/);
    if (underStorage) {
      mounts.push({ raw, prefix: underStorage[1].replace(/^\/+|\/+$/g, ''), scope: 'storage' });
      continue;
    }
    // Recognised: bundled assets that ship with the app.
    if (/^path\.resolve\(\s*__dirname\s*,/.test(raw)) {
      mounts.push({ raw, prefix: null, scope: 'bundled' });
      continue;
    }
    // Recognised: the built SPA. Asserted below to be independent of storagePath.
    if (raw === 'frontendDir') {
      mounts.push({ raw, prefix: null, scope: 'spa' });
      continue;
    }
    mounts.push({ raw, prefix: null, scope: 'unknown' });
  }
  return mounts;
}

describe('transfer storage is not statically served', () => {
  const mounts = staticMounts(SERVER_SRC);

  it('finds the static mounts it is meant to be checking', () => {
    // A guard on the guard: if the mounts are ever written a different way,
    // this test would otherwise pass by matching nothing at all.
    expect(mounts.length).toBeGreaterThan(0);
    expect(mounts.map((x) => x.prefix)).toEqual(expect.arrayContaining(['uploads/logos']));
  });

  it('the SPA mount is not derived from the storage root', () => {
    // `frontendDir` is cleared above by name, so pin what it actually is —
    // if it ever came from storagePath it would serve uploads.
    const assignment = SERVER_SRC.match(/const frontendDir\s*=\s*([^;]+);/);
    expect(assignment).not.toBeNull();
    expect(assignment[1]).not.toMatch(/storagePath/);
  });

  it('every static mount is written in a form this test can evaluate', () => {
    // The point of the file. A mount we cannot parse is a mount we cannot
    // clear, so it fails here rather than slipping through unnoticed.
    const unknown = mounts.filter((x) => x.scope === 'unknown').map((x) => x.raw);
    expect(unknown).toEqual([]);
  });

  it.each(TRANSFER_PREFIXES)('no static mount covers %s', (prefix) => {
    const offenders = mounts
      .filter((x) => x.scope === 'storage' && covers(x.prefix, prefix))
      .map((x) => x.raw);
    expect(offenders).toEqual([]);
  });

  it('serves nothing from the storage root itself', () => {
    // A bare mount on the root would expose every prefix at once.
    const offenders = mounts.filter((x) => x.scope === 'storage' && (x.prefix === '' || x.prefix === '.'));
    expect(offenders).toEqual([]);
  });
});

describe('nginx does not serve transfer bytes from disk', () => {
  const NGINX_CONF = path.join(__dirname, '../../../frontend/nginx.conf');
  const exists = fs.existsSync(NGINX_CONF);
  const conf = exists ? fs.readFileSync(NGINX_CONF, 'utf8') : '';

  /** Every `location <path> { … }` with its body. */
  function locationBlocks(src) {
    const out = [];
    const re = /location\s+([^{]+?)\s*\{/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      // Walk braces from the opening one to find this block's body.
      let depth = 1;
      let i = re.lastIndex;
      while (i < src.length && depth > 0) {
        if (src[i] === '{') depth += 1;
        else if (src[i] === '}') depth -= 1;
        i += 1;
      }
      out.push({ match: m[1].trim(), body: src.slice(re.lastIndex, i - 1) });
    }
    return out;
  }

  it('reads the config it is meant to be checking', () => {
    expect(exists).toBe(true);
    expect(locationBlocks(conf).length).toBeGreaterThan(5);
  });

  it('any location that could cover a transfer path proxies rather than serving files', () => {
    // `location ^~ /uploads` IS an ancestor of /uploads/transfers. That is
    // fine — it proxies to the backend, which has no route there, so the bytes
    // are never read off disk by nginx. What would NOT be fine is the same
    // prefix with a `root` or `alias`, so that is what this asserts.
    const risky = locationBlocks(conf)
      .filter(({ match }) => {
        const p = match.replace(/^[~^=*\s]+/, '');
        return TRANSFER_PREFIXES.some((prefix) => covers(p.replace(/^\/+/, ''), prefix))
          || /^\/?uploads\b/.test(p);
      })
      .filter(({ body }) => !/proxy_pass/.test(body) || /\b(root|alias)\s/.test(body))
      .map(({ match }) => match);
    expect(risky).toEqual([]);
  });
});
