// service/google.js

const { sysEnv, Attr } = require('@drumee/server-essentials');
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
console.log("AAA:30Attr.state ", Attr.state)
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
        this.googleClient = new OAuth2Client(id, secret, redirect_uri);
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
      // the redirect out to Google and back — the server-side callback has
      // no access to the browser context (localStorage) that captured it.
      const ref = (this.input.get('ref') || '').toString().trim().toLowerCase().slice(0, 64);
      await this.yp.await_query(
        'INSERT IGNORE INTO oauth_state (state, session_id, ref, ctime) VALUES (?, ?, ?, UNIX_TIMESTAMP())',
        state, this.input.sid(), ref || null
      );

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
    const code = this.getOAuthCode('google');
    if (!code) return;
    const profile = await this._getGoogleProfile(code);
    profile.provider = 'google';
    let res = await this.handleOAuthCallback(profile);
    const home = `https://${res.domain}${endpoint_path}/`;
    if (!res.error) {
      const tpl = resolve(__dirname, './templates/signup-completed.html');
      this.sendHtml({ ...res, home }, tpl)
    }
  }

}

module.exports = Goggle;