
const { sysEnv, Attr } = require('@drumee/server-essentials');
const { resolve } = require('path');
const { readFileSync: readJson } = require('jsonfile');
const { readFileSync } = require('fs');
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const axios = require('axios');
const Loby = require('./lib/loby');
const { verifyAppleIdentityToken, NONCE_SHAPE } = require('./lib/apple-token');
const { mintHandoffCode } = require('./lib/oauth-mobile');
const { credential_dir, svc_location, endpoint_path, main_domain } = sysEnv();

// A native nonce waits in oauth_state for the app to come back with a token.
const NATIVE_NONCE_TTL = 600;

let APPLECREDS = {}
// Apple credentials with dynamic callback URI aCreds
try {
  const akey = resolve(credential_dir, `apple/info.json`);
  const aCreds = readJson(akey);
  const pkey = resolve(credential_dir, `apple`, `${aCreds.key_file}`);
  const private_key = readFileSync(pkey, 'utf8');
  if (aCreds && aCreds.team_id && aCreds.service_id && aCreds.key_id && private_key) {
    APPLECREDS = {
      team_id: aCreds.team_id,
      service_id: aCreds.service_id,
      key_id: aCreds.key_id,
      private_key,
      // The ONE app bundle id this deployment accepts native identity tokens
      // for (stage → com.drumee.app.stage, …). Never a list across
      // environments: a token minted for another deployment's app must not be
      // redeemable here. Optional — without it the native services answer
      // credentials_missing and the web flow is unaffected.
      bundle_id: typeof aCreds.bundle_id === 'string' ? aCreds.bundle_id.trim() : '',
    };
    console.log("[Auth] Apple Credentials loaded");
  } else {
    console.error("[Auth] CRITICAL: Failed to load Apple credentials.");
  }
} catch (e) {
  console.error("[Auth] CRITICAL: Failed to load OAuth credentials!", e.message);
}
Object.freeze(APPLECREDS)

class Register extends Loby {
  initialize(opt) {
    super.initialize(opt);

    this.appleJwksClient = jwksClient({
      cache: true,
      rateLimit: true,
      jwksRequestsPerMinute: 5,
      jwksUri: 'https://appleid.apple.com/auth/keys'
    });

    // Cache for Apple client secret
    this.appleClientSecret = null;
    this.appleClientSecretExp = 0;
  }

  /**
   * Get cached Apple client secret (or generate new one)
   */
  _getAppleClientSecret() {
    const now = Math.floor(Date.now() / 1000);
    if (this.appleClientSecret && now < this.appleClientSecretExp) {
      return this.appleClientSecret;
    }

    this.debug("[Auth] Generating new Apple Client Secret...");
    const creds = APPLECREDS;

    if (!creds || !creds.private_key) {
      throw new Error("Apple credentials or private key not loaded.");
    }

    const iat = now;
    const exp = iat + (60 * 4);
    const claims = {
      iss: creds.team_id,
      aud: 'https://appleid.apple.com',
      sub: creds.service_id,
      iat: iat,
      exp: exp
    };

    this.appleClientSecret = jwt.sign(claims, creds.private_key, {
      algorithm: 'ES256',
      keyid: creds.key_id
    });
    this.appleClientSecretExp = exp;

    return this.appleClientSecret;
  }


  /**
   * Verify an Apple ID token against a specific audience.
   *
   * The web flow (authorization-code exchange) audiences the token to the
   * Services ID; a NATIVE token is audienced to the app bundle id. Same
   * signature check, different `aud` — so the audience is a parameter and the
   * two callers pass their own. JWKS fetch is raced against a 10 s timeout so
   * an Apple egress stall fails fast into the callers' error path.
   *
   * @param {string} id_token
   * @param {string} audience
   * @returns {Promise<Object>} the verified payload
   */
  async _verifyAppleIdToken(id_token, audience = APPLECREDS.service_id) {
    const { payload } = await verifyAppleIdentityToken(id_token, {
      getSigningKey: (kid) => this._getSigningKey(kid),
      audience,
    });
    return payload;
  }

  /**
   * Resolve Apple's signing key, failing fast when Apple's JWKS endpoint
   * stalls: jwks-rsa has no request timeout of its own, and a hung fetch
   * would otherwise hold the callback until nginx cuts it at 60 s.
   * @param {string} kid
   */
  _getSigningKey(kid) {
    let timer;
    return Promise.race([
      this.appleJwksClient.getSigningKey(kid),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Apple JWKS timeout")), 10000);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  /**
   * Mint the nonce a native Sign in with Apple request must carry.
   *
   * Parked in oauth_state under an `n_` prefix and bound to the caller's
   * session: the token Apple later returns embeds the SHA-256 of this value,
   * so a token minted for one app session cannot be replayed into another
   * (the mobile analogue of the browser flow's `state`). Single use.
   */
  async native_nonce() {
    if (!APPLECREDS.bundle_id) {
      return this.output.data({ status: 'error', error: 'credentials_missing' });
    }
    const sid = this.input.sid();
    if (!sid) {
      return this.output.data({ status: 'error', error: 'unexpected_error' });
    }
    const nonce = mintHandoffCode();
    // A plain INSERT (not the initiate tiers' INSERT IGNORE): a 128-bit random
    // nonce never collides, and this row is not one of the attribution tiers
    // offline/test/oauth-dest.test.js counts. The result is checked because
    // await_query resolves (not rejects) on a SQL failure — a nonce the app
    // holds but the table does not would make every sign-in fail as
    // invalid_nonce with nothing pointing at the cause. No sweep here: this is
    // an anonymous endpoint; expired rows are swept once the token verifies.
    const ins = await this.yp.await_query(
      'INSERT INTO oauth_state (state, session_id, ctime) VALUES (?, ?, UNIX_TIMESTAMP())',
      `n_${nonce}`, sid
    );
    if (!ins || ins.affectedRows !== 1) {
      this.warn('[Auth] Native Apple nonce not stored');
      return this.output.data({ status: 'error', error: 'unexpected_error' });
    }
    this.output.data({ status: 'ok', nonce });
  }

  /**
   * Spend the nonce row `nonce` minted for `sid`: it must exist, be younger
   * than NATIVE_NONCE_TTL and belong to this session, and exactly one caller
   * may delete it.
   * @param {string} nonce
   * @param {string} sid
   * @returns {Promise<boolean>}
   */
  async _consumeNonce(nonce, sid) {
    const row = await this.yp.await_query(
      "SELECT state FROM oauth_state WHERE state = ? AND session_id = ? AND ctime > UNIX_TIMESTAMP() - ? LIMIT 1",
      `n_${nonce}`, sid, NATIVE_NONCE_TTL
    ) || {};
    if (!row.state) return false;
    const del = await this.yp.await_query(
      "DELETE FROM oauth_state WHERE state = ? AND session_id = ?", `n_${nonce}`, sid
    );
    return Boolean(del && del.affectedRows === 1);
  }

  /**
   * The address an Apple identity signed up with, for the rare token that
   * omits `email` on a repeat sign-in.
   * @param {string} sub
   * @returns {Promise<string|null>}
   */
  async _emailForSub(sub) {
    const row = await this.yp.await_query(
      "SELECT email FROM oauth_accounts WHERE provider = 'apple' AND provider_user_id = ? ORDER BY mtime DESC LIMIT 1",
      sub
    ) || {};
    return row.email ? String(row.email) : null;
  }

  /**
   * Sign a native Sign in with Apple result into the calling session.
   *
   * iOS hands the app an identity token audienced to the APP BUNDLE ID (not
   * the Services ID the web flow uses) and, on the first authorization only,
   * the user's name. This verifies that token against the one bundle id this
   * deployment serves, spends the nonce bound to the caller's session, and
   * joins the same completion path as the web callback and the mobile claim.
   * JSON only: {status:'ok', method} | {status:'otp_required', email} |
   * {status:'error', error}.
   */
  async native_signin() {
    const sid = this.input.sid();
    const identityToken = String(this.input.get('identity_token') || '');
    const nonce = String(this.input.get('nonce') || '');
    const firstname = String(this.input.get('firstname') || '').trim().slice(0, 64);
    const lastname = String(this.input.get('lastname') || '').trim().slice(0, 64);

    if (!APPLECREDS.bundle_id) {
      return this.output.data({ status: 'error', error: 'credentials_missing' });
    }
    if (!sid || !NONCE_SHAPE.test(nonce)) {
      return this.output.data({ status: 'error', error: 'invalid_nonce' });
    }

    let verified;
    try {
      verified = await verifyAppleIdentityToken(identityToken, {
        getSigningKey: (kid) => this._getSigningKey(kid),
        audience: APPLECREDS.bundle_id,
        nonce,
      });
    } catch (e) {
      // e.code names the rejection. key_unavailable is Apple's key set being
      // unreachable, not a bad credential: it is logged with its cause and
      // answered as a transient failure so the app can say "try again".
      if (e && e.code === 'key_unavailable') {
        this.warn('[Auth] Apple signing key unavailable:', e.message);
        return this.output.data({ status: 'error', error: 'unexpected_error' });
      }
      const code = e && ['invalid_token', 'invalid_nonce', 'email_unverified'].includes(e.code)
        ? e.code : 'invalid_token';
      this.warn('[Auth] Native Apple token rejected:', code);
      return this.output.data({ status: 'error', error: code });
    }

    // Expired nonces and hand-offs are swept here, behind a verified Apple
    // token, rather than on the anonymous mint path.
    await this.sweepOauthTables();

    // The nonce row is spent only after the token verified: a garbage token
    // must not be able to burn a nonce the real request still needs.
    if (!(await this._consumeNonce(nonce, sid))) {
      return this.output.data({ status: 'error', error: 'invalid_nonce' });
    }

    const email = verified.email || await this._emailForSub(verified.sub);
    if (!email) {
      return this.output.data({ status: 'error', error: 'invalid_token' });
    }

    let res;
    try {
      res = await this.completeOAuthSignin({
        provider: 'apple',
        provider_id: verified.sub,
        email,
        is_private_email: verified.is_private_email,
        firstname,
        lastname,
        access_token: null,
        refresh_token: null,
      }, { session_id: sid, ref: '', utm: {}, dest: null });
    } catch (e) {
      this.warn('[Auth] Native Apple completion failed:', e && e.message);
      return this.output.data({ status: 'error', error: 'unexpected_error' });
    }
    if (res && res.status === 'ok') {
      return this.output.data({ status: 'ok', method: res.method || 'signin' });
    }
    if (res && res.status === 'otp_required') {
      return this.output.data({ status: 'otp_required', email: res.email || '' });
    }
    return this.output.data({ status: 'error', error: (res && res.error) || 'unexpected_error' });
  }

  /**
   * Get Apple user profile
   */
  async _getAppleProfile(code) {
    if (!APPLECREDS.service_id) {
      throw new Error("Apple credentials are not loaded.");
    }

    const client_secret = this._getAppleClientSecret();
    const { service_id } = APPLECREDS;
    const redirect_uri = `https://${main_domain}${svc_location}/apple.callback`;
    const params = new URLSearchParams();
    params.append('client_id', service_id);
    params.append('client_secret', client_secret);
    params.append('code', code);
    params.append('grant_type', 'authorization_code');
    params.append('redirect_uri', redirect_uri);

    const tokenResponse = await axios.post(
      'https://appleid.apple.com/auth/token',
      params,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const id_token = tokenResponse.data.id_token;
    if (!id_token) {
      throw new Error("Failed to retrieve ID Token from Apple.");
    }

    const payload = await this._verifyAppleIdToken(id_token);
    if (!payload || !payload.sub || !payload.email) {
      throw new Error("Invalid ID Token payload from Apple.");
    }

    // Apple sends name only on first sign-in via 'user' parameter
    let firstname = '';
    let lastname = '';
    const userParam = this.input.get('user');
    if (userParam) {
      try {
        const userData = JSON.parse(userParam);
        if (userData.name) {
          firstname = userData.name.firstName || userData.fullName?.givenName || ''
          lastname = userData.name.lastName || userData.fullName?.familyName || '';
        }
      } catch (e) {
        this.warn('[Auth] Failed to parse Apple user data:', e);
      }
    }

    // Apple sends `is_private_email` as a string ("true"/"false") on most
    // tokens, occasionally as a boolean. Normalize to 1/0. When true, email is
    // an @privaterelay.appleid.com forwarding address (user chose "Hide My
    // Email") — there is no way to recover the real address; mail must be sent
    // from an address registered in Apple's Sign in with Apple email sources or
    // the relay silently drops it.
    const is_private_email =
      payload.is_private_email === true || payload.is_private_email === 'true' ? 1 : 0;

    return {
      email: payload.email,
      is_private_email,
      provider_id: payload.sub,
      firstname,
      lastname,
      access_token: tokenResponse.data.access_token,
      refresh_token: tokenResponse.data.refresh_token
    };
  }

  /**
   * Start Apple OAuth flow
   */
  async initiate() {
    try {
      // APPLECREDS is a frozen object even when loading failed, so the check
      // has to be on a field: without a Services ID no authorize URL is valid.
      if (!APPLECREDS.service_id) {
        return this.output.data({ status: 'error', error: 'credentials_missing' });
      }

      const { service_id } = APPLECREDS;
      // const redirect_uri = `https://${main_domain}${svc_location}/apple.callback?`;
      const redirect_uri = `https://${main_domain}${svc_location}/apple.callback`;

      // A mobile client names itself so the callback can send the auth sheet
      // back to the app instead of the web landing page. It travels inside the
      // state (`a_<uuid>~mobile-stage`), see lib/oauth-mobile.js.
      const client = this._clientFromInput();
      const state = this.oauthStateFor('a', client);
      if (client) await this.sweepOauthTables();
      // Referral attribution: the signup UI forwards the ?ref=<member>
      // handle with initiate. Persist it on the state row so it survives
      // the redirect out to the provider and back — the server-side
      // callback has no access to the browser storage that captured it.
      const ref = (this.input.get('ref') || '').toString().trim().toLowerCase().slice(0, 64);
      // Campaign attribution, parked for the same reason as `ref` — see
      // google.js, which does this identically.
      const utm = this._utmFromInput();
      // Where the visitor was heading, parked for the third time and the same
      // reason as `ref` and `utm` above — see _sanitiseDest. Validated HERE, on
      // the way in, as well as on the way back out at callback.
      const dest = this._destFromInput();
      try {
        await this.yp.await_query(
          'INSERT IGNORE INTO oauth_state (state, session_id, ref, utm_source, utm_medium, utm_campaign, utm_content, dest, ctime)'
          + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, UNIX_TIMESTAMP())',
          state, this.input.sid(), ref || null,
          utm.utm_source || null, utm.utm_medium || null,
          utm.utm_campaign || null, utm.utm_content || null,
          dest || null
        );
      } catch (e) {
        // One tier per column-group, newest first: a database that has utm_*
        // but not `dest` still keeps the campaign. Falling straight to the bare
        // row would throw away attribution that the instance can perfectly well
        // store, for the sake of a column it cannot.
        try {
          await this.yp.await_query(
            'INSERT IGNORE INTO oauth_state (state, session_id, ref, utm_source, utm_medium, utm_campaign, utm_content, ctime)'
            + ' VALUES (?, ?, ?, ?, ?, ?, ?, UNIX_TIMESTAMP())',
            state, this.input.sid(), ref || null,
            utm.utm_source || null, utm.utm_medium || null,
            utm.utm_campaign || null, utm.utm_content || null
          );
        } catch (eUtm) {
          // Attribution is best-effort; signing in is not. Fall back to the
          // ref-only shape, then to the bare row.
          try {
            await this.yp.await_query(
              'INSERT IGNORE INTO oauth_state (state, session_id, ref, ctime) VALUES (?, ?, ?, UNIX_TIMESTAMP())',
              state, this.input.sid(), ref || null
            );
          } catch (e2) {
            await this.yp.await_query(
              'INSERT IGNORE INTO oauth_state (state, session_id, ctime) VALUES (?, ?, UNIX_TIMESTAMP())',
              state, this.input.sid()
            );
          }
        }
      }
      const authUrl = `https://appleid.apple.com/auth/authorize?` +
        `client_id=${encodeURIComponent(service_id)}` +
        `&redirect_uri=${encodeURIComponent(redirect_uri)}` +
        `&response_type=code` +
        `&response_mode=form_post` +
        `&scope=${encodeURIComponent("name email")}` +
        `&state=${state}`;
      this.debug('[Auth] Apple OAuth URL generated', { mobile: Boolean(client) });
      this.output.data({ success: true, authUrl, state: state, status: 'prompt' });
    } catch (error) {
      this.warn('[Auth] Error initiating Apple OAuth:', error);
      return this.output.data({ status: 'error', error: 'oauth_init_failed' });
    }
  }

  /**
   * Apple posts here (response_mode=form_post), so EVERY exit from this method
   * has to put something in front of the browser — it is a top-level navigation,
   * not an XHR. Mirrors google.callback: every failure ends at sendOauthError,
   * which bounces back to the signin screen carrying the reason.
   * @returns
   */
  async callback() {
    // Resolved from the state param alone and outside the try, so the catch
    // below and the no-code exit can both send a mobile client back to its app.
    const stateParam = this.input.get(Attr.state);
    const client = this.clientFromState(stateParam);
    try {
      const code = this.getOAuthCode('apple', true);
      if (!code) {
        // No/invalid code — typically the user cancelled on Apple's consent
        // screen, which comes back as error=user_cancelled_authorize. The state
        // row is consumed so a declined flow cannot be replayed.
        await this.resolveOAuthState(stateParam, 'apple');
        return this.sendOauthError('access_denied', client, 'apple');
      }
      const profile = await this._getAppleProfile(code);
      profile.provider = 'apple';
      if (client) {
        // Mobile: verify and park, never sign in here — the app redeems the
        // code with oauth.claim over its own session (lib/loby.js).
        const ctx = await this.resolveOAuthState(stateParam, 'apple');
        if (ctx.error) return this.sendOauthError(ctx.error, client, 'apple');
        const handoff = await this.stashOauthHandoff(ctx, profile);
        return this.sendMobileReturn(client, 'apple', { code: handoff });
      }
      let res = await this.handleOAuthCallback(profile);
      // 2FA required: the session is pending, not finalized. Keep the pending
      // session cookie (sendHtml/setAuthorization) and bounce the browser to the
      // signin app's OTP screen, which finalizes via oauth.verify_otp.
      if (res.status === 'otp_required') {
        // `dest` rides through the OTP screen so a 2FA account arrives where the
        // link named. Appended as an ordinary param on a hash that already has
        // a query; the signin app hands it back once verify_otp finalises.
        const destParam = res.dest ? `&dest=${encodeURIComponent(res.dest)}` : '';
        const redirect = `https://${main_domain}${endpoint_path}/#/welcome/signin?oauth_mfa=1&email=${encodeURIComponent(res.email || '')}${destParam}`;
        const tpl = resolve(__dirname, './templates/otp-challenge.html');
        // res.session_id is the pending cookie's id (original signin session) —
        // sendHtml binds the browser's authorization to it.
        this.sendHtml({ ...res, redirect }, tpl);
        return;
      }
      if (res.error) {
        // invalid_state, oauth_not_linked, account creation failures... — these
        // previously fell through and answered the browser with nothing at all.
        return this.sendOauthError(res.error);
      }
      // THE DESTINATION GOES ON THE URL, not into storage. The visitor may land
      // on a different deploy slot from the one they clicked on, and a fragment
      // could never have reached this server in the first place — so the
      // landing URL is the only carrier that works from here. ui-team's
      // billing-deep-link consume() already reads a destination off the URL
      // when storage has none, which is why nothing has to change over there.
      //
      // Re-validated at the point of use (handleOAuthCallback already ran it):
      // this string is about to be interpolated into the landing page's
      // location.replace(), and the code that builds a template's input is the
      // code that has to have checked it.
      const dest = this._sanitiseDest(res.dest);
      const home = `https://${res.domain}${endpoint_path}/${dest ? `#${dest}` : ''}`;
      const tpl = resolve(__dirname, './templates/account-created.html');
      // New OAuth account: show the welcome card (auto_redirect off) so the
      // user lands on it; the CTA continues to the desk, where the onboarding
      // gate kicks in. Existing sign-ins skip the card and go straight home.
      const is_new = res.method === 'signup';
      this.sendHtml({ ...res, home, auto_redirect: is_new ? 0 : 1, is_new: is_new ? 1 : 0 }, tpl)
    } catch (e) {
      // Token exchange rejected, JWKS fetch failed, unverified email, malformed
      // id_token — the user gets the signin screen back instead of a hung
      // request or a raw 500 page.
      this.warn('[Auth] Apple OAuth callback failed:', e.message || e);
      // The state row is consumed on this exit too, so a failed exchange
      // cannot be retried against the same state.
      await this.resolveOAuthState(stateParam, 'apple').catch(() => null);
      this.sendOauthError('oauth_failed', client, 'apple');
    }
  }

}

module.exports = Register;