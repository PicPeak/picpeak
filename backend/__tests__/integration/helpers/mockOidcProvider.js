/**
 * Minimal in-process OIDC provider for integration tests (#798).
 *
 * Serves just enough of the spec for openid-client's full validation to
 * pass: discovery, JWKS (RS256), authorization endpoint (immediate redirect,
 * no login UI), and token endpoint (authorization_code + PKCE). Claims for
 * the next login are scripted per test via `setNextUser()`.
 *
 * Runs on an ephemeral localhost port over plain http — the service allows
 * that in NODE_ENV=test only.
 */

const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

class MockOidcProvider {
  constructor() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.privateKey = privateKey;
    this.publicJwk = publicKey.export({ format: 'jwk' });
    this.publicJwk.kid = 'test-key-1';
    this.publicJwk.alg = 'RS256';
    this.publicJwk.use = 'sig';

    this.clientId = 'picpeak-test';
    this.clientSecret = 'test-client-secret';
    this.codes = new Map(); // code -> { nonce, redirectUri, codeChallenge, user }
    this.nextUser = { sub: 'user-1', email: 'sso@example.com', email_verified: true };
    // Test hooks:
    this.tamperNonce = false; // sign the ID token with a WRONG nonce
    this.emailViaUserinfoOnly = false; // omit email from the ID token; serve it on /userinfo
    this.advertiseEndSession = true; // include end_session_endpoint in discovery (#798 phase 3)
    this.accessTokens = new Map(); // access_token -> user (for /userinfo)
    this.server = null;
    this.issuer = null;
  }

  setNextUser(user) {
    this.nextUser = user;
  }

  signIdToken({ sub, nonce, extraClaims = {} }) {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', kid: this.publicJwk.kid, typ: 'JWT' };
    const payload = {
      iss: this.issuer,
      aud: this.clientId,
      sub,
      iat: now,
      exp: now + 300,
      nonce,
      ...extraClaims,
    };
    const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), this.privateKey);
    return `${signingInput}.${signature.toString('base64url')}`;
  }

  async start() {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.issuer = `http://127.0.0.1:${this.server.address().port}`;
    return this.issuer;
  }

  async stop() {
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
  }

  handle(req, res) {
    const url = new URL(req.url, this.issuer);
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        userinfo_endpoint: `${this.issuer}/userinfo`,
        jwks_uri: `${this.issuer}/jwks`,
        ...(this.advertiseEndSession ? { end_session_endpoint: `${this.issuer}/logout` } : {}),
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      });
    }

    if (url.pathname === '/jwks') {
      return json(200, { keys: [this.publicJwk] });
    }

    if (url.pathname === '/authorize') {
      // "Log in" instantly: mint a code bound to this request's params and
      // bounce back to the redirect_uri like a real IdP would.
      const code = crypto.randomBytes(16).toString('base64url');
      this.codes.set(code, {
        nonce: url.searchParams.get('nonce'),
        redirectUri: url.searchParams.get('redirect_uri'),
        codeChallenge: url.searchParams.get('code_challenge'),
        user: this.nextUser,
      });
      const back = new URL(url.searchParams.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(302, { location: back.href });
      return res.end();
    }

    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const params = new URLSearchParams(body);
        const stored = this.codes.get(params.get('code'));
        if (!stored) return json(400, { error: 'invalid_grant' });
        this.codes.delete(params.get('code'));

        // PKCE check — S256(code_verifier) must match the challenge.
        const verifier = params.get('code_verifier') || '';
        const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
        if (challenge !== stored.codeChallenge) {
          return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        }

        const { sub, ...extraClaims } = stored.user;
        // Spec-compliant providers may keep profile/email claims OFF the ID
        // token and serve them from /userinfo only — this hook simulates that.
        const idTokenClaims = this.emailViaUserinfoOnly ? {} : extraClaims;
        const idToken = this.signIdToken({
          sub,
          nonce: this.tamperNonce ? 'tampered-nonce' : stored.nonce,
          extraClaims: idTokenClaims,
        });
        const accessToken = crypto.randomBytes(16).toString('base64url');
        this.accessTokens.set(accessToken, stored.user);
        return json(200, {
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: 300,
          id_token: idToken,
        });
      });
      return undefined;
    }

    if (url.pathname === '/userinfo') {
      const auth = req.headers.authorization || '';
      const user = this.accessTokens.get(auth.replace(/^Bearer\s+/i, ''));
      if (!user) return json(401, { error: 'invalid_token' });
      return json(200, { ...user });
    }

    return json(404, { error: 'not_found' });
  }
}

module.exports = { MockOidcProvider };
