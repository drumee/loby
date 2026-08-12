// service/google.js

const { sysEnv } = require('@drumee/server-essentials');
const { resolve } = require('path');
const { readFileSync: readJson } = require('jsonfile');

const { OAuth2Client } = require('google-auth-library');
const { randomUUID } = require('crypto');
const Loby = require('./lib/loby');

const { credential_dir, svc_location, main_domain, endpoint_path } = sysEnv();

let CREDENTIALS = {};

try {

  // Google credentials with dynamic callback URI
  const gkey = resolve(credential_dir, `google/info.json`);
  CREDENTIALS = readJson(gkey);
  if (CREDENTIALS.id && CREDENTIALS.secret) {
    console.log("[Auth] Google Credentials loaded");
  } else {
    console.error("[Auth] CRITICAL: Failed to load 'google/info.json'.");
  }
} catch (e) {
  console.error("[Auth] CRITICAL: Failed to load OAuth credentials!", e.message);
}
/** Prevent accidentla changes */
Object.freeze(CREDENTIALS)

class Goggle extends Loby {

  /**
   * 
   * @param {*} opt 
   */
  initialize(opt) {
    super.initialize(opt);

    try {
      let { id, secret } = CREDENTIALS;
      if (id && secret) {
        // Dynamic callback: works for all developer endpoints
        const redirect_uri = `https://${main_domain}${svc_location}/google.callback?`;
        // Timeout on every Google HTTP call (token exchange, cert fetch):
        // a stalled egress must fail fast into the callback error path,
        // not hang until nginx cuts the request with a 504 at 60s.
        this.googleClient = new OAuth2Client({
          clientId: id,
          clientSecret: secret,
          redirectUri: redirect_uri,
          transporterOptions: { timeout: 10000 }
        });
        this.googleClientId = id;
        this.debug("[Auth] Google Credentials loaded. Callback:", redirect_uri);
      } else {
        this.warn("[Auth] CRITICAL: Failed to load 'google/info.json'.");
      }
    } catch (e) {
      this.warn("[Auth] CRITICAL: Failed to load OAuth credentials!", e.message);
    }
  }


  /**
   * Get Google user profile
   */
  async _getGoogleProfile(code) {
    if (!this.googleClient) {
      throw new Error("Google credentials are not loaded.");
    }

    const { tokens } = await this.googleClient.getToken(code);
    const id_token = tokens.id_token;
    if (!id_token) {
      throw new Error("Failed to retrieve ID Token from Google.");
    }

    const ticket = await this.googleClient.verifyIdToken({
      idToken: id_token,
      audience: this.googleClientId
    });

    const payload = ticket.getPayload();

    return {
      email: payload.email,
      provider_id: payload.sub,
      firstname: payload.given_name || '',
      lastname: payload.family_name || '',
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token
    };
  }

  /**
   * Start Google OAuth flow
   */
  async initiate() {
    try {
      if (!this.googleClient) {
        return this.output.data({ status: 'error', error: 'credentials_missing' });
      }

      const state = `g_${randomUUID()}`;
      // Referral attribution: the signup UI forwards the ?ref=<member>
      // handle with initiate. Persist it on the state row so it survives
      // the redirect out to the provider and back — the server-side
      // callback has no access to the browser storage that captured it.
      const ref = (this.input.get('ref') || '').toString().trim().toLowerCase().slice(0, 64);
      try {
        await this.yp.await_query(
          'INSERT IGNORE INTO oauth_state (state, session_id, ref, ctime) VALUES (?, ?, ?, UNIX_TIMESTAMP())',
          state, this.input.sid(), ref || null
        );
      } catch (e) {
        // DB without the optional oauth_state.ref column: keep OAuth working,
        // just without referral attribution.
        await this.yp.await_query(
          'INSERT IGNORE INTO oauth_state (state, session_id, ctime) VALUES (?, ?, UNIX_TIMESTAMP())',
          state, this.input.sid()
        );
      }

      const authUrl = this.googleClient.generateAuthUrl({
        access_type: 'offline',
        scope: ['email', 'profile'],
        prompt: 'consent',
        state
      });

      this.debug('[Auth] Google OAuth URL generated with state:', this.input.sid(), state, { success: true, authUrl: authUrl, status: 'prompt' });
      this.output.data({ success: true, authUrl: authUrl, status: 'prompt' });
    } catch (error) {
      this.warn('[Auth] Error initiating Google OAuth:', error);
      return this.output.data({ status: 'error', error: 'oauth_init_failed' });
    }
  }


  /**
   * 
   * @returns 
   */
  async callback() {
    this.debug('[Auth] Google OAuth URL CALL BACK:');
    try {
      const code = this.getOAuthCode('google', true);
      if (!code) {
        // No/invalid code — typically the user cancelled on Google's
        // consent screen (error=access_denied).
        return this.sendOauthError('access_denied');
      }
      const profile = await this._getGoogleProfile(code);
      profile.provider = 'google';
      let res = await this.handleOAuthCallback(profile);
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
      if (res.error) {
        // invalid_state, oauth_not_linked, account creation failures... —
        // previously this fell through without ever answering the browser.
        return this.sendOauthError(res.error);
      }
      const home = `https://${res.domain}${endpoint_path}/`;
      const tpl = resolve(__dirname, './templates/account-created.html');
      // New OAuth account: show the welcome card (auto_redirect off) so the
      // user lands on it; the CTA continues to the desk, where the onboarding
      // gate kicks in. Existing sign-ins skip the card and go straight home.
      const is_new = res.method === 'signup';
      this.sendHtml({ ...res, home, auto_redirect: is_new ? 0 : 1, is_new: is_new ? 1 : 0 }, tpl)
    } catch (e) {
      // getToken/verifyIdToken rejected or timed out (reused code, expired
      // code, Google egress trouble) — the user gets the signin screen back
      // instead of a raw 400/504 page.
      this.warn('[Auth] Google OAuth callback failed:', e.message || e);
      this.sendOauthError('oauth_failed');
    }
  }

}

module.exports = Goggle;