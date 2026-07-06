/**
 * @license
 * Copyright 2024 Thidima SA. All Rights Reserved.
 * Licensed under the GNU AFFERO GENERAL PUBLIC LICENSE, Version 3 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * https://www.gnu.org/licenses/agpl-3.0.html
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */

const {
  sysEnv, uniqueId, Attr, toArray, Cache
} = require("@drumee/server-essentials");
const { Entity } = require("@drumee/server-core");
const { readFileSync } = require("fs");
const { template } = require("lodash");

class Account extends Entity {

  /**
   * The account schema is picked from the pool of hubs that are already created by offline process
   */
  async create_account(data, autosignin = 1) {
    const { main_domain: domain } = sysEnv();
    let {
      email,
      firstname = "",
      password,
      auth_method = "local",   // "local" | "google" | "apple" | ...
      ref = "",                // referral handle recovered from oauth_state
    } = data;
    ref = String(ref || "").trim().toLowerCase().slice(0, 64);
    let onboarded = 1;
    if (!firstname) {
      onboarded = 0;
    }
    let username = firstname || email.split('@')[0];
    username = await this.yp.await_func("ensure_username", { username: username.toLowerCase(), domain });
    let a = firstname.split(/ +/)
    let lastname = "";
    if (a.length > 1) {
      firstname = a[0]
      a.shift()
      lastname = a.join(' ')
    }
    username = username.replace(/[^a-zA-Z0-9]/g, '');
    // password_set tells downstream (delete-account, change-email, etc.)
    // whether check_password_next is a viable verifier. OAuth users land
    // here with auth_method != "local" and a random UUID password they
    // never see — for them, password_set=0 → those flows must use OTP
    // instead. A user can flip this to 1 later by setting a real password.
    const password_set = auth_method === "local" ? 1 : 0;
    let profile = {
      username,
      sharebox: uniqueId(),
      otp: 0,
      category: "trial",
      onboarded,
      profile_type: "trial",
      lang: this.user.language() || this.input.app_language(),
      firstname,
      lastname,
      email,
      auth_method,
      password_set,
      // Referral attribution — read by the analytics plugin
      // (referrals / signup_sources / referral_members procs).
      ...(ref ? { ref } : {}),
    }

    let user = await this.yp.await_proc("drumate_create", password, profile);
    if (!user || !user[0]) {
      return { ...profile, error: 1, status: "unknown_error" }
    }

    if (user[0].failed) {
      return { ...profile, error: 1, status: "db_error", ...user[0] }
    }
    let { permission, failed } = user[0];
    let { drumate } = user[2] || {};
    if (!drumate || !permission || failed) {
      this.warn("[create_account] failed", user)
      return { error: 1, failed, status: "internal_error" }
    }
    if (!autosignin) {
      return drumate;
    }
    try {
      let status = await this.session.signin({ uid: email, password, host: domain });
      return status;
    } catch (e) {
      this.warn("Auto login failed", e)
      return { error: 1, failed, status: "internal_error" }
    }
  }



  /**
   * 
   */
  getOAuthCode(provider) {
    const code = this.input.get(Attr.code);
    if (!code || !/^[A-Za-z0-9-_./]+$/.test(code)) {
      this.warn(`[Auth] Missing or invalid OAuth code from ${provider}`, Attr.code, code);
      this.output.data({ status: 'error', error: 'invalid_code' });
      return null
    }
    return code;
  }

  /** */
  async addUser(profile) {
    let { email, provider_id, provider, firstname, lastname, access_token, refresh_token } = profile;
    this.debug(`[Auth] addUser...`);
    let session_id = this.input.sid()

    // Double-check email doesn't exist
    let existingUser = await this.yp.await_proc('drumate_exists', email);
    if (existingUser && existingUser.email) {
      this.debug(`[Auth] Email ${email} exists but OAuth not linked`);
      return { status: 'error', error: 'user_exists' };
    }
    // Create new account
    if (!firstname) {
      firstname = email.split('@')[0];
    }
    if (!lastname) {
      let a = firstname.split('.');
      firstname = a[0] || '';
      lastname = a[1] || '';
    }
    // TODO(P5): post-OAuth onboarding. drumate_create gets `onboarded:1`
    // when firstname is present (which Google/Apple typically supply),
    // so the user lands directly on the desk with no chance to set lang
    // preference or avatar. Worth routing new SSO users through the
    // welcome onboarding step on first sign-in.
    const fullname = `${firstname} ${lastname}`.trim();
    const createData = {
      email,
      firstname: fullname || firstname,
      // OAuth users get a random password they never see. password_set=0
      // is set in create_account based on auth_method, which routes any
      // future step-up auth (delete, email change) through email-OTP.
      password: uniqueId(),
      auth_method: provider,
      // Referral handle recovered from oauth_state by handleOAuthCallback.
      ref: profile.ref || "",
    };

    const creationResult = await this.create_account(createData, 0) || {};
    if (!creationResult.home_id || !creationResult.db_name) {
      this.warn(`[Auth] Failed to create account for ${email}:`, creationResult);
      return { status: 'error', error: 'account_creation_failed' };
    }

    this.debug(`[Auth] Account created for ${email}`, creationResult);

    // Get new user ID
    let newUser = await this.yp.await_proc('drumate_exists', email);
    if (!newUser || !newUser.id) {
      this.warn(`[Auth] Cannot find user ID after account creation`);
      throw new Error("Failed to get new user ID.");
    }
    const newUserId = newUser.id;
    this.debug(`[Auth] New user ID: ${newUserId}`);

    // Link OAuth account with rollback on failure
    try {
      await this.yp.await_query(
        'INSERT INTO oauth_accounts (user_id, provider, provider_user_id, email, ctime, mtime, access_token, refresh_token) VALUES (?, ?, ?, ?, UNIX_TIMESTAMP(), UNIX_TIMESTAMP(), ?, ?)',
        newUserId, provider, provider_id, email, access_token, refresh_token
      );
    } catch (linkError) {
      this.warn(`[Auth] Failed to link OAuth. Rolling back...`, linkError.message);
      try {
        await this.yp.await_proc('drumate_delete', newUserId);
      } catch (rollbackError) {
        this.warn('[Auth] Rollback failed:', rollbackError);
      }
      throw new Error(`Failed to link OAuth account: ${linkError.message}`);
    }

    this.debug(`[Auth] OAuth account linked for user ${newUserId}, ${session_id}`);

    // Get full session data
    const domain_name = this.input.host();
    let finalSessionData = await this.yp.await_proc(
      'session_login_with_oauth',
      provider, provider_id, email, session_id, domain_name
    );
    finalSessionData = toArray(finalSessionData)[0];

    if (finalSessionData && finalSessionData.status === 'ok') {
      this.debug(`[Auth] Sign-up complete for ${email}`);
      return (finalSessionData);
    } else {
      this.warn(`[Auth] Failed to get session after sign-up:`, finalSessionData);
      return { status: 'error', error: 'session_fetch_failed' };
    }

  }

  /**
 * Handle OAuth callback for both Google and Apple
 */
  async handleOAuthCallback(profile) {
    try {

      const { email, provider_id, provider, access_token, refresh_token } = profile;
      const state = this.input.get(Attr.state);
      if (!state) {
        this.warn(`[Auth] Missing state parameter from ${provider}`);
        return { status: 'error', error: 'missing_state' };
      }

      const { validState, session_id, ref } = await this.yp.await_query(
        'SELECT 1 validState, session_id, ref FROM oauth_state WHERE state = ? AND ctime > UNIX_TIMESTAMP() - 600 LIMIT 1',
        state
      ) || {};

      if (!validState) {
        this.warn(`[Auth] Invalid or expired state: ${state}`);
        return { status: 'error', error: 'invalid_state' };
      }

      // const session_id = this.input.sid()

      // Delete used state
      await this.yp.await_query('DELETE FROM oauth_state WHERE state = ?', state);

      const domain_name = this.input.host();
      this.debug(`[Auth] OAuth callback: email=${email},session_id=${session_id}, provider=${provider}, provider_id=${provider_id}`);

      // Try to sign in
      let sessionData = await this.yp.await_proc(
        'session_login_with_oauth',
        provider, provider_id, email, session_id, domain_name
      );
      sessionData = toArray(sessionData)[0];

      // CASE A: Sign-in successful
      if (sessionData && sessionData.status === 'ok') {
        this.debug(`[Auth] Sign-in successful for ${email}`, sessionData);
        await this.yp.await_query(
          'UPDATE oauth_accounts SET access_token = ?, refresh_token = ?, mtime = UNIX_TIMESTAMP() WHERE user_id = ? AND provider = ?',
          access_token, refresh_token, sessionData.id, provider
        );
        sessionData.method = 'signin';
        return sessionData;
      }

      // TODO(P5): consider an explicit-confirmation step on first link.
      // session_login_with_oauth currently auto-links any existing local
      // user with a matching email (yp/procedures/session/session_login_with_oauth.sql:40-58).
      // That's convenient but a minor footgun if an attacker controls
      // a Google account with the same email — they get auto-merged.
      // Adding a confirmation step ("Link this Google account to your
      // existing Drumee account?") would close the gap.

      // CASE B: Email exists but not linked
      if (sessionData && sessionData.error_code === 'oauth_not_linked') {
        this.debug(`[Auth] Email ${email} exists but not linked to ${provider}`);
        return {
          status: 'error',
          error: 'oauth_not_linked',
          message: sessionData.message,
          email
        };
      }

      // CASE C: New user - sign up
      if (sessionData && sessionData.error_code === 'oauth_user_not_found') {
        // Thread the referral handle (persisted at initiate) into the new
        // account's profile for analytics attribution.
        if (ref) profile.ref = ref;
        let res = await this.addUser(profile);
        res.method = 'signup';
        return res;
      }

      this.warn(`[Auth] Unexpected OAuth callback result:`, sessionData);
      return { status: 'error', error: 'unexpected_error' };

    } catch (error) {
      this.warn(`[Auth] OAuth callback exception:`, error);
      throw error;
    }
  }

  /**
 * 
 * @returns 
 */
  _authorization() {
    let auth = this.input.authorization() || {};
    let c = {
      type: auth.type,
      session_type: auth.type,
      sid: auth.id,
      device_id: this.input.get(Attr.device_id)
    }
    return c;
  }


  /**
 *
 */
  async sendHtml(data, tpl) {
    const { main_domain } = sysEnv()
    let html = readFileSync(tpl);
    html = String(html).trim().toString();
    const content = template(html)(data);
    this.output.set_header(
      "Cache-Control",
      "no-cache, no-store, must-revalidate"
    );

    let auth = this._authorization();
    let keysel = Attr.regsid;
    auth[keysel] = data.session_id;
    const params = {
      host: main_domain,
      session_type: Attr.regular,
      keysel,
      sid: data.session_id,
      id: data.session_id
    }
    this.output.set_header(
      "Cache-Control",
      "no-cache, no-store, must-revalidate"
    );
    this.output.setAuthorization(params);
    this.output.set_header("Access-Control-Allow-Origin", `*.${main_domain}`);
    this.output.html(content);
  }


  /**
 * 
 * @param {*} args 
 * @param {*} opt 
 */
  async createHub(args, opt = {}) {
    let { owner_id, domain, area, filename, hostname, pid, user_db } = args;
    if (!domain || !area) {
      this.warn("MAL_FORMED_DATA", { args }, { domain, area });
      return this.exception.user("MAL_FORMED_DATA");
    }

    if (opt.is_wicket) {
      hostname = uniqueId()
      filename = hostname;
    } else {
      hostname = filename;
      hostname = hostname.replace(/[ \.,;:!&~#'|@*\$><\?\(\)\[\]\{\}\"\/]/g, '');
      hostname = await this.yp.await_func("strip_accents", hostname);
      hostname = hostname.replace(/\-$/, '');
      hostname = hostname.trim().toLowerCase();
      hostname = new URL(`http://${hostname}`).hostname;
    }

    opt.lang = "en"; //this.input.use(Attr.lang) || "en";
    filename = await this.yp.await_func(`${user_db}.unique_filename`, pid, filename, "");
    args = { hostname, area, filename, owner_id, domain };
    const rows = await this.yp.await_proc(`${user_db}.desk_create_hub`, args, opt);
    let hub_id, hub_db, home_id;
    for (let r of rows) {
      if (r && r.failed) {
        this.debug("Rows returned", rows)
        this.warn("Failed to create hub", { args, opt, rows });
        return {};
      }
      if (r.db_name && r.filesize != null && r.actual_home_id) {
        hub_db = r.db_name;
        home_id = r.actual_home_id;
      }
      if (r.db_name && r.home_dir) {
        hub_id = r.id;
        hub_db = hub_db || r.db_name;
      }
    }

    /** place the folder at the end on the user desk */
    let { count } = await this.yp.await_query(`SELECT count(*) count FROM ${user_db}.media`);
    await this.yp.await_query(`UPDATE ${user_db}.media media SET rank=? WHERE id=?`, count, hub_id);
    return { filename, hostname, hub_id, hub_db, db_name: hub_db, home_id }

  }

  /**
   * 
   */
  async setWallpaper(uid) {
    let wp = Cache.getSysConf('default_wallpaper');
    if (!wp) {
      this.warn("No wallpapers available");
      return;
    }
    let { nid, hub_id } = JSON.parse(wp);
    let { settings } = await this.yp.await_proc("entity_touch", uid) || {};
    settings = JSON.parse(settings);
    settings.wallpaper = {
      nid, hub_id
    }
    await this.yp.call_proc("drumate_update_settings", uid, settings);
  }

  /**
 * 
 */
  async createSymLink(target, dest) {
    const { hub_id } = target;
    //this.debug("Create symlink 147", { hub_id });
    let { db_name } = await this.yp.await_proc('get_entity', hub_id);
    if (!db_name) {
      this.warn(`Target not found`, target);
    }
    //this.debug("Create symlink 152", target.filetype, { db_name });
    switch (target.filetype) {
      case Attr.hub:
        this.warn("Can not link a hub")
        return
      case Attr.folder:
        let args = {
          owner_id: user_id,
          filename: target.filename,
          pid: dest.nid,
          category: Attr.folder,
          ext: "",
          mimetype: Attr.folder,
          filesize: 0,
        };
        let node = await this.db.await_proc(`mfs_create_node`, args, {}, { show_results: 1 });
        if (db_name) {
          await this.yp.await_proc(`${db_name}.mfs_create_link_by`,
            target.nid,
            dest.uid,
            node.id,
            dest.hub_id
          );
        }
        break;
      default:
        //this.debug("Create symlink 175", target.nid, dest.uid, dest.nid, dest.hub_id, db_name);
        if (db_name) {
          if (!dest.nid || !dest.hub_id) {
            this.debug("Link desination in empty", dest)
            break;
          }
          await this.yp.await_proc(`${db_name}.mfs_create_link`,
            target.nid,
            dest.uid,
            dest.nid,
            dest.hub_id
          );
        }
    }
  }

  /**
   *
   * @returns
   */
  async make_dir(db_name, pid, dirname) {
    try {
      await this.yp.await_proc(`${db_name}.mfs_make_dir`, pid, [dirname], 0)
    } catch (e) {
      this.warn("Failed to create dir", e)
    }
  }

  /**
   *
   * @returns
   */
  async make_default_folers(opt) {
    const { db_name, home_id } = opt;
    for (let dirname of ["Photos", "Documents", "Videos"]) {
      await this.make_dir(db_name, home_id, dirname)
    }
  }

}

module.exports = Account;
