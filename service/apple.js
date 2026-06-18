
const { sysEnv } = require('@drumee/server-essentials');
const { resolve } = require('path');
const { readFileSync: readJson } = require('jsonfile');
const { readFileSync } = require('fs');
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const axios = require('axios');
const { randomUUID } = require('crypto');
const Loby = require('./lib/loby');
const { credential_dir, svc_location, endpoint_path, main_domain } = sysEnv();

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
   * Verify Apple ID Token with JWKS
   */
  async _verifyAppleIdToken(id_token) {
    const decodedToken = jwt.decode(id_token, { complete: true });
    if (!decodedToken) {
      throw new Error("Invalid Apple ID Token format.");
    }

    const kid = decodedToken.header.kid;
    const key = await this.appleJwksClient.getSigningKey(kid);
    const signingKey = key.getPublicKey();

    const payload = jwt.verify(id_token, signingKey, {
      algorithms: ['RS256'],
      audience: APPLECREDS.service_id,
      issuer: 'https://appleid.apple.com'
    });

    if (!payload.email_verified) {
      throw new Error("Apple email not verified");
    }

    return payload;
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
    this.debug("AAAA:151", userParam, payload, this.input.toJSON(), this.input.data())
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

    return {
      email: payload.email,
      provider_id: payload.sub,
      firstname,
      lastname,
      access_token: tokenResponse.data.access_token,
      refresh_token: tokenResponse.data.refresh_token
    };
  }

  // Handle response
  handleAppleResponse(response) {
    if (response.authorization) {
      const authorization = response.authorization;
      const user = authorization.user;

      // Name might be in the id_token or user object
      console.log("User:", user);
    }
  }

  /**
   * Start Apple OAuth flow
   */
  async initiate() {
    try {
      if (!APPLECREDS) {
        return this.output.data({ status: 'error', error: 'credentials_missing' });
      }

      const { service_id } = APPLECREDS;
      // const redirect_uri = `https://${main_domain}${svc_location}/apple.callback?`;
      const redirect_uri = `https://${main_domain}${svc_location}/apple.callback`;

      const state = `a_${randomUUID()}`;
      await this.yp.await_query(
        'INSERT IGNORE INTO oauth_state (state, session_id, ctime) VALUES (?, ?, UNIX_TIMESTAMP())',
        state, this.input.sid()
      );
      const authUrl = `https://appleid.apple.com/auth/authorize?` +
        `client_id=${encodeURIComponent(service_id)}` +
        `&redirect_uri=${encodeURIComponent(redirect_uri)}` +
        `&response_type=code` +
        `&response_mode=form_post` +
        `&scope=${encodeURIComponent("name email")}` +
        `&state=${state}`;
      this.debug("AAAA:210", redirect_uri, authUrl)
      this.output.data({ success: true, authUrl, state: state, status: 'prompt' });
    } catch (error) {
      this.warn('[Auth] Error initiating Apple OAuth:', error);
      return this.output.data({ status: 'error', error: 'oauth_init_failed' });
    }
  }

  /**
   * 
   * @returns 
   */
  async callback(response) {
    console.log("User:", response);
    const code = this.getOAuthCode();
    if (!code) return;
    const profile = await this._getAppleProfile(code);
    profile.provider = 'apple';
    let res = await this.handleOAuthCallback(profile);
    this.debug("AAAA:221", res)
    // 2FA required: the session is pending, not finalized. Keep the pending
    // session cookie (sendHtml/setAuthorization) and bounce the browser to the
    // signin app's OTP screen, which finalizes via oauth.verify_otp.
    if (res.status === 'otp_required') {
      const redirect = `https://${main_domain}${endpoint_path}/#/welcome/signin?oauth_mfa=1&email=${encodeURIComponent(res.email || '')}`;
      const tpl = resolve(__dirname, './templates/otp-challenge.html');
      // res.session_id is the pending cookie's id (original signin session) —
      // sendHtml binds the browser's authorization to it.
      this.sendHtml({ ...res, redirect }, tpl);
      return;
    }
    const home = `https://${res.domain}${endpoint_path}/`;
    if (!res.error) {
      const tpl = resolve(__dirname, './templates/account-created.html');
      // New OAuth account: show the welcome card (auto_redirect off) so the
      // user lands on it; the CTA continues to the desk, where the onboarding
      // gate kicks in. Existing sign-ins skip the card and go straight home.
      const is_new = res.method === 'signup';
      this.sendHtml({ ...res, home, auto_redirect: is_new ? 0 : 1 }, tpl)
    }
  }

}

module.exports = Register;