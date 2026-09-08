// service/google.js

const { sysEnv, Attr } = require('@drumee/server-essentials');
const { resolve } = require('path');
const { readFileSync: readJson } = require('jsonfile');

const { OAuth2Client } = require('google-auth-library');
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

      // A mobile client names itself so the callback can send the auth sheet
      // back to the app instead of the web landing page. It travels inside the
      // state (`g_<uuid>~mobile-stage`), see lib/oauth-mobile.js.
      const client = this._clientFromInput();
      const state = this.oauthStateFor('g', client);
      if (client) await this.sweepOauthTables();
      // Referral attribution: the signup UI forwards the ?ref=<member>
      // handle with initiate. Persist it on the state row so it survives
      // the redirect out to the provider and back — the server-side
      // callback has no access to the browser storage that captured it.
      const ref = (this.input.get('ref') || '').toString().trim().toLowerCase().slice(0, 64);
      // Campaign attribution, parked for exactly the same reason as `ref` and
      // by the same insert. Without it an OAuth signup that arrived on a
      // campaign link is recorded as organic — not wrong, invisible.
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
          // DB without the optional utm columns: fall back to the shape that
          // has only `ref`, then to the bare row. ATTRIBUTION IS BEST-EFFORT
          // AND SIGNING IN IS NOT — a visitor must never be unable to sign in
          // because a column for reporting is missing.
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

      const authUrl = this.googleClient.generateAuthUrl({
        access_type: 'offline',
        scope: ['email', 'profile'],
        prompt: 'consent',
        state
      });

      this.debug('[Auth] Google OAuth URL generated', { mobile: Boolean(client) });
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
    // Resolved from the state param alone and outside the try, so the catch
    // below and the no-code exit can both send a mobile client back to its app.
    const stateParam = this.input.get(Attr.state);
    const client = this.clientFromState(stateParam);
    try {
      const code = this.getOAuthCode('google', true);
      if (!code) {
        // No/invalid code — typically the user cancelled on Google's
        // consent screen (error=access_denied). The state row is consumed so
        // a declined flow cannot be replayed.
        await this.resolveOAuthState(stateParam, 'google');
        return this.sendOauthError('access_denied', client, 'google');
      }
      const profile = await this._getGoogleProfile(code);
      profile.provider = 'google';
      if (client) {
        // Mobile: verify and park, never sign in here — the app redeems the
        // code with oauth.claim over its own session (lib/loby.js).
        const ctx = await this.resolveOAuthState(stateParam, 'google');
        if (ctx.error) return this.sendOauthError(ctx.error, client, 'google');
        const handoff = await this.stashOauthHandoff(ctx, profile);
        return this.sendMobileReturn(client, 'google', { code: handoff });
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
        // invalid_state, oauth_not_linked, account creation failures... —
        // previously this fell through without ever answering the browser.
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
      // getToken/verifyIdToken rejected or timed out (reused code, expired
      // code, Google egress trouble) — the user gets the signin screen back
      // instead of a raw 400/504 page.
      this.warn('[Auth] Google OAuth callback failed:', e.message || e);
      // The state row is consumed on this exit too, so a failed exchange
      // cannot be retried against the same state.
      await this.resolveOAuthState(stateParam, 'google').catch(() => null);
      this.sendOauthError('oauth_failed', client, 'google');
    }
  }

}

module.exports = Goggle;