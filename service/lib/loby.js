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
  sysEnv, uniqueId, Attr, toArray, Cache, Messenger
} = require("@drumee/server-essentials");
const { Entity } = require("@drumee/server-core");
const { readFileSync } = require("fs");
const { resolve } = require("path");
// isEmpty/isArray are used by _resolve_pending_invitation, which moved here
// from signup.js — where they were imported. Moving the method without them
// left it throwing ReferenceError at its first guard.
const { template, isEmpty, isArray } = require("lodash");

const { sendAs, legalFooterText } = require("./mail-sender");
const {
  normaliseClient, oauthStateFor, clientFromState, statePrefixFor,
  mobileReturnUrl, mintHandoffCode, HANDOFF_TTL: OAUTH_HANDOFF_TTL,
} = require("./oauth-mobile");

// How long a parked state may wait; matches the callback's own TTL. The
// hand-off TTL lives beside the claim rules in oauth-mobile.js.
const OAUTH_STATE_TTL = 600;

class Account extends Entity {

  /**
   * The account schema is picked from the pool of hubs that are already created by offline process 
   */
  /**
   * Moved up from Signup so BOTH sign-up paths share it: email-and-password
   * (signup.create_account) and OAuth (addUser below). It used to live
   * only on Signup, which is why an OAuth sign-up created the account, linked
   * the provider and seeded the default folders but never granted the
   * workspaces the person had been invited to.
   *
   * Resolve pending hub invitations từ hub.add_contributors (email được invite trước khi đăng ký).
   * Add user vào các hub và xóa khỏi pending_invitation.
   * Logic tham khảo adminpanel.js: join_hub + permission_grant (user db) + permission_grant (hub db).
   * @param {string} email - email user vừa đăng ký
   */
  async _resolve_pending_invitation(email, knownUid, knownDbName) {
    // The OAuth path already holds the id of the account it just created, so it
    // passes it in. Re-deriving it from the address there is an extra failure
    // mode for no gain: drumate_exists has to see a row that was written
    // moments earlier, and when it does not this returns quietly and the
    // invitation stays unresolved with only a log line to show for it.
    let uid = knownUid || null;
    if (!uid) {
      let newUser = await this.yp.await_proc("drumate_exists", email);
      if (isArray(newUser)) newUser = newUser[0];
      if (isEmpty(newUser) || !newUser.id) {
        this.warn("[_resolve_pending_invitation] Cannot find user for", email);
        return;
      }
      uid = newUser.id;
    }
    const newUser = { id: uid };

    // The caller may already hold the account's db. That matters because this
    // lookup is one of three early returns that land before the delete (the
    // others: no user, and no pending rows), and the delete is otherwise
    // unconditional — even failed grants consume the rows.
    // get_entity needs drumate JOIN entity JOIN domain on dom_id,
    // all of which have to be in place; asking it about an account created
    // moments ago is the one call here that can come back empty on a brand-new
    // row and abandon the invitation with a single log line.
    let userDbName = knownDbName || null;
    if (!userDbName) {
      const userEntity = await this.yp.await_proc("get_entity", newUser.id);
      userDbName = userEntity && userEntity.db_name;
    }
    if (!userDbName) {
      this.warn("[_resolve_pending_invitation] Cannot find db_name for user", newUser.id);
      return;
    }

    const pending = await this.yp.await_proc("pending_invitation_get_by_email", email);
    const rows = toArray(pending);
    if (isEmpty(rows)) {
      this.debug("[_resolve_pending_invitation] No pending invitations for", email);
      return;
    }

    this.debug("[_resolve_pending_invitation] Resolving", rows.length, "pending invitations for", email);
    for (const row of rows) {
      const { hub_id, permission, expiry_time } = row;
      try {
        const hubDbName = await this.yp.await_func("get_db_name", hub_id);
        if (!hubDbName) {
          this.warn('[_resolve_pending_invitation] Cannot find db_name for hub', hub_id);
          continue;
        }

        await this.yp.await_proc(`${userDbName}.join_hub`, hub_id);
        await this.yp.await_proc(
          `${userDbName}.permission_grant`,
          hub_id, newUser.id, expiry_time, permission, 'system', 'Resolved from pending_invitation on signup'
        );
        await this.yp.await_proc(
          `${hubDbName}.permission_grant`,
          '*', newUser.id, expiry_time, permission, 'system', 'Resolved from pending_invitation on signup'
        );
        this.debug("[_resolve_pending_invitation] Added user", newUser.id, "to hub", hub_id);
      } catch (err) {
        this.warn(`[_resolve_pending_invitation] Failed for hub ${hub_id}:`, err && err.message);
      }
    }

    await this.yp.await_proc("pending_invitation_delete_by_email", email);
  }

  /**
   * The campaign tags on the current request, normalised.
   *
   * SHARED BY BOTH OAUTH PROVIDERS because both have the same problem: the
   * visitor is bounced out to the provider and the callback runs server-side,
   * so whatever the browser captured is unreachable by the time the account is
   * made. Both park these on the oauth_state row beside `ref`.
   *
   * Same four keys and the same clamp as every other capture point in the
   * chain (signup router, ui-team campaign.js, signup.create_account). A key
   * added here has to be added there too, or it is stored on one path only.
   *
   * @returns {Object} only the tags that were actually present
   */
  _utmFromInput() {
    const utm = {};
    for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_content"]) {
      const v = (this.input.get(k) || "").toString().trim().slice(0, 64);
      if (v) utm[k] = v;
    }
    return utm;
  }

  /**
   * The destination this visit named, as a flat request param.
   *
   * Read at initiate and parked on oauth_state beside `ref` and utm_*, for the
   * same reason those are: the callback runs server-side, the visitor is
   * bounced out to the provider in between, and browser storage is unreachable
   * from there. A URL fragment is worse off still — it is never sent to a
   * server at all.
   *
   * @returns {String|null} a validated fragment, or null
   */
  _destFromInput() {
    return this._sanitiseDest(this.input.get("dest"));
  }

  /**
   * The mobile client that started this flow, or null for the web widget.
   * Whitelisted in oauth-mobile.js; anything else is the web behaviour.
   * @returns {string|null}
   */
  _clientFromInput() {
    return normaliseClient(this.input.get("client"));
  }

  /**
   * Mint the state for a provider, carrying the mobile client when one asked.
   * @param {"g"|"a"} prefix
   * @param {string|null} client
   */
  oauthStateFor(prefix, client) {
    return oauthStateFor(prefix, client);
  }

  /**
   * Which mobile client a callback belongs to, read from the state param
   * alone. Decided before any provider call or row read, so every exit of the
   * callback — a cancelled consent, an expired row, an exchange failure in the
   * catch — can still return to the app.
   * @param {*} state
   * @returns {string|null}
   */
  clientFromState(state) {
    return clientFromState(state);
  }

  /**
   * Drop expired parked rows so no scheduled job is needed.
   *
   * MOBILE PATHS ONLY (a mobile initiate, the hand-off insert). The web flow
   * never touches oauth_handoff, and the table is created by the same
   * deployment that enables mobile — so the web sign-in cannot depend on a
   * table an instance may not have yet. Expired rows are unreadable anyway
   * (every SELECT carries its own ctime window); this is hygiene.
   */
  async sweepOauthTables() {
    await this.yp.await_query(
      "DELETE FROM oauth_state WHERE ctime < UNIX_TIMESTAMP() - ?", OAUTH_STATE_TTL);
    await this.yp.await_query(
      "DELETE FROM oauth_handoff WHERE ctime < UNIX_TIMESTAMP() - ?", OAUTH_HANDOFF_TTL);
  }

  /**
   * Consume the oauth_state row for `state`, the ONLY reader of that table.
   *
   * Prefix-checked against the provider so a nonce row or another provider's
   * state cannot be spent here, and deleted with an affected-row check so two
   * callbacks racing on the same state produce exactly one winner. Called on
   * every exit that has a state param — a cancelled consent consumes its row
   * too, so a state can never be replayed after the user declined.
   *
   * @param {*} state
   * @param {string} provider
   * @returns {Promise<{error:string}|{session_id:string, ref:string, utm:Object, dest:*}>}
   */
  async resolveOAuthState(state, provider) {
    if (!state) {
      this.warn(`[Auth] Missing state parameter from ${provider}`);
      return { error: "missing_state" };
    }
    const prefix = statePrefixFor(provider);
    if (!prefix || !String(state).startsWith(prefix)) {
      this.warn(`[Auth] State does not belong to ${provider}`);
      return { error: "invalid_state" };
    }
    // SELECT * (not an explicit column list) so this keeps working on
    // databases that don't have the optional oauth_state.ref / utm_* columns
    // yet — those simply come back undefined there.
    const {
      validState, session_id, ref, dest,
      utm_source, utm_medium, utm_campaign, utm_content,
    } = await this.yp.await_query(
      "SELECT 1 validState, s.* FROM oauth_state s WHERE state = ? AND ctime > UNIX_TIMESTAMP() - ? LIMIT 1",
      state, OAUTH_STATE_TTL
    ) || {};
    if (!validState) {
      this.warn(`[Auth] Invalid or expired state for ${provider}`);
      return { error: "invalid_state" };
    }
    const del = await this.yp.await_query("DELETE FROM oauth_state WHERE state = ?", state);
    if (!del || del.affectedRows !== 1) {
      this.warn(`[Auth] State already consumed for ${provider}`);
      return { error: "invalid_state" };
    }
    // The campaign this visit arrived on, recovered from the state row the
    // same way `ref` is. Only the tags that were actually parked — an empty
    // object means the visit carried no campaign, which is the common case.
    const utm = {};
    for (const [k, v] of Object.entries({
      utm_source, utm_medium, utm_campaign, utm_content,
    })) {
      if (v) utm[k] = String(v).trim().slice(0, 64);
    }
    return { session_id, ref: ref || "", utm, dest };
  }

  /**
   * Park a verified provider profile for the app to redeem (oauth.claim).
   *
   * The callback runs in a browser sheet that holds no app session, so it
   * cannot sign the app in; it also must not sign in the session that called
   * initiate, because that binding is what a phished authUrl would exploit.
   * The row therefore carries BOTH the initiator's session id and a one-time
   * code: the code reaches only the device that completed consent, the
   * session id is held only by the app, and the claim needs both.
   *
   * @param {{session_id:string, ref:string, utm:Object}} ctx from resolveOAuthState
   * @param {Object} profile the provider profile, incl. `provider`
   * @returns {Promise<string>} the code
   */
  async stashOauthHandoff(ctx, profile) {
    const code = mintHandoffCode();
    const parked = { ...profile, ref: ctx.ref || "", utm: ctx.utm || {} };
    await this.yp.await_query(
      "INSERT INTO oauth_handoff (code, session_id, provider, profile, ctime) VALUES (?, ?, ?, ?, UNIX_TIMESTAMP())",
      code, ctx.session_id, profile.provider, JSON.stringify(parked)
    );
    return code;
  }

  /**
   * Send the auth sheet back to the app. A 302, not a scripted navigation:
   * Chrome Custom Tabs follow a server redirect to a custom scheme without
   * user activation, and ASWebAuthenticationSession matches it against its
   * callbackURLScheme. No cookie is set — the app's own session is the one
   * that will be signed in, at claim time.
   * @param {string} client
   * @param {string} provider
   * @param {{code?:string, error?:string}} params
   */
  sendMobileReturn(client, provider, params) {
    this.output.set_header("Cache-Control", "no-cache, no-store, must-revalidate");
    this.output.redirect(mobileReturnUrl(client, provider, params));
  }

  /**
   * Validate a destination, or refuse it.
   *
   * A SHAPE CHECK THAT REBUILDS, not an escaping pass. Every part is parsed,
   * matched against an allowlist, and the string is assembled again from what
   * survived — so a value can only ever be one this function could have
   * written. Escaping alone would let an unrecognised-but-quoted destination
   * through, and "somewhere the campaign never named" is the failure that
   * matters here, not "a broken quote".
   *
   * WHY IT MATTERS MORE THAN IT LOOKS. The result ends up interpolated into
   * the landing page's location.replace(), and lib/loby.js renders those
   * templates with LODASH — whose <%= %> is the RAW delimiter, the reverse of
   * EJS. An unvalidated apostrophe would therefore break out of that JS string
   * literal into script context, on the page that runs immediately after
   * authentication. The template is being escaped too (both are cheap); this
   * is the guard that does not depend on remembering which delimiter is which.
   *
   * RUN AT BOTH ENDS — on the way into oauth_state and on the way back out of
   * it. The row is data, and the code that builds the template's input is the
   * code that has to have checked it.
   *
   * @param {*} raw
   * @returns {String|null} "/desk/billing?…" or null
   */
  _sanitiseDest(raw) {
    const s = (raw == null ? "" : String(raw)).trim();
    // Length first, and REFUSED rather than truncated: half a destination is a
    // wrong one, and the column is 255.
    if (!s || s.length > 255) return null;
    // No character that could leave the fragment, the attribute or the string
    // literal it will sit in. Checked before parsing so nothing exotic reaches
    // URLSearchParams.
    if (/[\s"'`<>\\]/.test(s)) return null;

    const q = s.indexOf("?");
    const path = q === -1 ? s : s.slice(0, q);
    // ONE path. Widening this list is the only way this function should ever
    // learn a new destination — never by relaxing the parse.
    if (path !== "/desk/billing") return null;
    if (q === -1) return path;

    const ALLOWED = {
      plan: /^(free|pro|team|business)$/,
      cycle: /^(monthly|yearly)$/,
      tab: /^checkout$/,
      // The shape yp.mkt_coupon.code stores (ascii, and the dashboard's own
      // field). Not a lookup: whether the code exists is the checkout's
      // question, and answering it here would refuse a valid link because a
      // coupon was created a minute later.
      promo: /^[A-Za-z0-9_-]{1,64}$/,
      // The marker naming who the campaign CTA was written for
      // (analytics-server _recipientTag): 8 hex. It MUST be here — an unknown
      // param is refused outright, so a destination carrying `for` would be
      // rejected whole and the OAuth deep link would stop working entirely
      // rather than merely losing its marker.
      //
      // Case-insensitive, and lowercased on the way out below. The server only
      // ever emits lowercase and the dashboard compares case-insensitively, so
      // refusing an uppercased tag would kill an entire destination over
      // something neither end cares about.
      for: /^[0-9a-fA-F]{8}$/,
    };
    let usp;
    try {
      usp = new URLSearchParams(s.slice(q + 1));
    } catch (e) {
      return null;
    }
    // Rebuilt in a FIXED order from a fixed key list, so two links that mean
    // the same thing produce the same string and an unknown key cannot ride
    // along by being ignored.
    const out = [];
    for (const k of ["plan", "cycle", "tab", "promo", "for"]) {
      const v = usp.get(k);
      if (v == null || v === "") continue;
      if (!ALLOWED[k].test(v)) return null;
      // Normalised so the two ends compare equal whatever case arrived.
      out.push(`${k}=${k === "for" ? v.toLowerCase() : v}`);
    }
    // An unknown param is a refusal, not something to drop: it means this link
    // was written against a contract this code does not have, and guessing
    // which half of it to honour is how a destination becomes a wrong one.
    for (const k of usp.keys()) {
      if (!Object.prototype.hasOwnProperty.call(ALLOWED, k)) return null;
    }
    if (!out.length) return path;
    const rebuilt = `${path}?${out.join("&")}`;
    return rebuilt.length > 255 ? null : rebuilt;
  }

  /**
   * Record one signup in yp.signup_track.
   *
   * IDEMPOTENT BY KEY, not by check: the table is PRIMARY KEY (uid) and this
   * is INSERT IGNORE, so a retried create cannot double-count a campaign. A
   * check-then-insert would race with itself on exactly the retry it is meant
   * to survive.
   *
   * EVERY FAILURE IS SWALLOWED. The caller has a live account by the time this
   * runs; a missing table, a missing column or a dead connection must cost a
   * row of reporting and nothing else.
   *
   * @param {Object} drumate the created account (carries id)
   * @param {Object} ctx     { profile, ref, utm, method }
   */
  async _trackSignup(drumate, ctx) {
    try {
      const uid = (drumate && (drumate.id || drumate.uid)) || "";
      if (!uid) return;
      const o = ctx || {};
      const utm = o.utm || {};
      const p = o.profile || {};
      await this.yp.await_query(
        "INSERT IGNORE INTO signup_track"
        + " (uid, email, campaign, source, medium, content, ref, method, ctime)"
        + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, UNIX_TIMESTAMP())",
        uid,
        p.email || null,
        utm.utm_campaign || null,
        utm.utm_source || null,
        utm.utm_medium || null,
        utm.utm_content || null,
        o.ref || null,
        // 'local' unless a provider said otherwise — the OAuth paths pass
        // their own, and knowing which is which is how anyone would notice
        // OAuth attribution regressing again.
        o.method || "local"
      );
    } catch (e) {
      this.warn("[create_account] signup not tracked —", e && e.message);
    }
  }

  async create_account(data, autosignin = 1) {
    const { main_domain: domain } = sysEnv();
    let {
      email,
      firstname = "",
      password,
      onboarded,
      ref = "",                // referral handle recovered from oauth_state
      utm,                     // UTM campaign params (source attribution)
    } = data;
    ref = String(ref || "").trim().toLowerCase().slice(0, 64);
    // Sanitize UTM to the four known keys — persisted as profile.utm and read
    // by the analytics signup-source attribution alongside ref.
    let _utm = {};
    if (utm && typeof utm === "object") {
      for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_content"]) {
        const v = (utm[k] || "").toString().trim().slice(0, 64);
        if (v) _utm[k] = v;
      }
    }
    // OAuth signups pass onboarded explicitly (always 0 — a Google/Apple name
    // says nothing about whether the user has done the industry/role/team-size
    // onboarding). Other callers fall back to the name-presence heuristic.
    if (onboarded == null) {
      onboarded = firstname ? 1 : 0;
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
    let profile = {
      username,
      sharebox: uniqueId(),
      otp: 0,
      category: "trial",
      onboarded,
      profile_type: "trial",
      // Product default is English — never derive a new account's language
      // from the request (session/Xlang/accept-language).
      lang: 'en',
      firstname,
      lastname,
      email,
      // Referral attribution — read by the analytics plugin
      // (referrals / signup_sources / referral_members procs).
      ...(ref ? { ref } : {}),
      ...(Object.keys(_utm).length ? { utm: _utm } : {}),
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

    // Record the signup as an EVENT, now that the account exists.
    //
    // AFTER THE FACT AND SWALLOWED. A signup that was not tracked is a
    // reporting gap; a signup that failed because tracking threw is an outage.
    // So this never blocks and never propagates: the account is already real
    // by this line and nothing below depends on the write.
    //
    // Why an event at all, when profile.utm already holds the campaign: the
    // profile key dies with the account, so a deleted user silently reduces
    // last month's campaign total. See schemas/tables/signup_track.sql.
    await this._trackSignup(drumate, { profile, ref, utm: _utm, method: data.method });

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
  getOAuthCode(provider, quiet = false) {
    const code = this.input.get(Attr.code);
    if (!code || !/^[A-Za-z0-9-_./]+$/.test(code)) {
      // The value is an authorization code: log its presence, not the code.
      this.warn(`[Auth] Missing or invalid OAuth code from ${provider}`, { present: Boolean(code) });
      // quiet: the caller sends its own response (e.g. a signin redirect)
      if (!quiet) this.output.data({ status: 'error', error: 'invalid_code' });
      return null
    }
    return code;
  }

  /**
   * Create the account for a provider identity nobody has yet, link it, seed
   * it, and open the session `session_id` — the session the caller resolved
   * (the state row's on the web, the claiming app's on mobile), never this
   * request's own: the web callback and the mobile claim arrive on different
   * requests from the session that must end up signed in.
   * @param {Object} profile
   * @param {string} session_id
   */
  async addUser(profile, session_id) {
    let { email, provider_id, provider, firstname, lastname, access_token, refresh_token, is_private_email = 0 } = profile;
    this.debug(`[Auth] addUser...`);

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
    const fullname = `${firstname} ${lastname}`.trim();
    const createData = {
      email,
      firstname: fullname || firstname,
      password: uniqueId(), // OAuth users don't have password, set default
      // Brand-new OAuth account: force onboarding regardless of the name Google
      // supplied. Without this, create_account's name-presence heuristic flags
      // the account onboarded=1 and the desk gate skips onboarding entirely.
      onboarded: 0,
      // Referral handle recovered from oauth_state by handleOAuthCallback.
      ref: profile.ref || "",
      // AND THE CAMPAIGN, recovered the same way. Without this an OAuth signup
      // that arrived on a campaign link was persisted with no utm at all and
      // counted as organic — the referral handle made the round trip and the
      // campaign did not, because only one of them had somewhere to wait.
      utm: profile.utm || undefined,
      // Names itself for signup_track. Without it every signup reads as
      // 'local' and the OAuth split — the one that was broken until now — is
      // invisible again.
      method: profile.provider || "oauth",
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
        'INSERT INTO oauth_accounts (user_id, provider, provider_user_id, email, is_private_email, ctime, mtime, access_token, refresh_token) VALUES (?, ?, ?, ?, ?, UNIX_TIMESTAMP(), UNIX_TIMESTAMP(), ?, ?)',
        newUserId, provider, provider_id, email, is_private_email, access_token, refresh_token
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

    this.debug(`[Auth] OAuth account linked (${provider})`);

    // Brand-new OAuth account: seed the default Personal Workspace folder just
    // like the email-signup path (signup.create_account). creationResult
    // carries the db_name/home_id make_default_folers needs.
    try {
      await this.make_default_folers(creationResult);
    } catch (e) {
      this.warn(`[Auth] Failed to create default folders for ${email}:`, e && e.message);
    }

    // Grant the workspaces this address was invited to before it had an
    // account — the same step signup.create_account performs for the
    // email-and-password path. Without it an OAuth sign-up lands on a desk
    // holding only the three default workspaces, and opening the one they were
    // invited to fails with "the file you requested does not exist".
    //
    // Scope-agnostic: it resolves whatever pending_invitation rows exist for
    // the address, so internal and external are handled identically.
    //
    // Best-effort, exactly as on the email path: a failure here must not undo
    // an account that has already been created and linked.
    try {
      // uid and db come from the account this method just created — both are
      // already validated above (creationResult.db_name gate) — so resolution
      // never has to re-derive them from a row it is racing.
      await this._resolve_pending_invitation(email, newUserId, creationResult.db_name);
    } catch (e) {
      this.warn(`[Auth] Failed to resolve pending invitations for ${email}:`, e && e.message);
    }

    // Get full session data
    const domain_name = this.input.host();
    let finalSessionData = await this.yp.await_proc(
      'session_login_with_oauth',
      provider, provider_id, email, session_id, domain_name
    );
    finalSessionData = toArray(finalSessionData)[0];

    if (finalSessionData && finalSessionData.status === 'ok') {
      // create_account ran with autosignin=0, so nothing has logged this
      // connection yet: the session was opened by session_login_with_oauth,
      // which writes no services_log row.
      await this._logConnection(finalSessionData.id);
      this.debug(`[Auth] Sign-up complete (${provider})`);
      return (finalSessionData);
    } else {
      this.warn(`[Auth] Failed to get session after sign-up:`, finalSessionData);
      return { status: 'error', error: 'session_fetch_failed' };
    }

  }

  /**
 * Handle OAuth callback for both Google and Apple
 */
  /**
   * Record an accepted sign-in that was opened by a PROCEDURE rather than by
   * session.signin()/session.login().
   *
   * server-core logs a connection in those two methods and nowhere else, so a
   * session opened by session_login_with_oauth or session_login_otp is invisible
   * to everything reading services_log -- yp.show_login_log, and the analytics
   * "Last login" column, which takes MAX(ctime) over rows carrying
   * args.success='1'.
   *
   * This is not a new behaviour, it is a restored one: stage still holds
   * google.callback and apple.callback rows, but none newer than 2025-11-18,
   * while yp.signin rows continue to today. The logging was lost when these
   * paths moved into this module.
   *
   * NEVER LET THIS BREAK A LOGIN. The provider has already authenticated the
   * user by the time we run; a logging failure must cost an analytics row, not
   * their session. Hence the swallow.
   * @param {String} uid
   */
  async _logConnection(uid) {
    try {
      await this.session._log_connection({ uid });
    } catch (e) {
      this.warn('[Auth] failed to record login for', uid, e && e.message);
    }
  }

  /**
   * The web callback: consume the state row, then complete the sign-in for
   * the session that row names. Both halves are reused separately by the
   * mobile flow (the callback only parks; oauth.claim completes).
   * @param {Object} profile
   */
  async handleOAuthCallback(profile) {
    const ctx = await this.resolveOAuthState(this.input.get(Attr.state), profile.provider);
    if (ctx.error) return { status: 'error', error: ctx.error };
    return this.completeOAuthSignin(profile, ctx);
  }

  /**
   * Sign the provider identity into `ctx.session_id`: existing link (A),
   * email known but unlinked (B), brand-new account (C) or 2FA pending (D).
   * @param {Object} profile provider profile incl. `provider`
   * @param {{session_id:string, ref?:string, utm?:Object, dest?:*}} ctx
   */
  async completeOAuthSignin(profile, ctx) {
    try {

      const { email, provider_id, provider, access_token, refresh_token } = profile;
      const { session_id, dest } = ctx;
      const ref = ctx.ref || "";
      const utm = ctx.utm || {};

      const domain_name = this.input.host();
      this.debug(`[Auth] OAuth sign-in: provider=${provider}`);

      // Try to sign in
      let sessionData = await this.yp.await_proc(
        'session_login_with_oauth',
        provider, provider_id, email, session_id, domain_name
      );
      sessionData = toArray(sessionData)[0];

      // CASE A: Sign-in successful
      if (sessionData && sessionData.status === 'ok') {
        this.debug(`[Auth] Sign-in successful for ${email}`, sessionData);
        // Don't clobber a Drive-migration token. Google *login* and Drive
        // *connect* use DIFFERENT OAuth clients but share one oauth_accounts
        // row (keyed by provider + provider_user_id). A refresh_token is bound
        // to the client that minted it, and the migration worker refreshes with
        // the Drive client — so overwriting the row's tokens with login-client
        // tokens makes that refresh throw invalid_grant (surfaced to the user as
        // NEEDS_RECONNECT) even though the login itself succeeded. When the row
        // already carries drive.readonly scope, leave its access_token/
        // refresh_token untouched and only bump mtime; otherwise behave as
        // before (store the fresh login tokens).
        await this.yp.await_query(
          `UPDATE oauth_accounts
             SET access_token  = IF(scope IS NOT NULL AND (scope LIKE '%drive.readonly%' OR scope LIKE '%drive.file%'), access_token, ?),
                 refresh_token = IF(scope IS NOT NULL AND (scope LIKE '%drive.readonly%' OR scope LIKE '%drive.file%'), refresh_token, ?),
                 mtime = UNIX_TIMESTAMP()
           WHERE user_id = ? AND provider = ?`,
          access_token, refresh_token, sessionData.id, provider
        );
        // The session was opened by session_login_with_oauth, which writes no
        // services_log row, so it is logged here. CASE C logs inside addUser
        // (create_account runs with autosignin=0 there, so session.signin()
        // never logs it); CASE D is finalized in oauth.verify_otp and logged
        // there.
        await this._logConnection(sessionData.id);
        sessionData.method = 'signin';
        // Where this visit was heading, recovered from the state row and
        // re-validated on the way out — the callers append it to the landing
        // URL. Carried on all three successful exits (signin, signup, 2FA), or
        // it would work for some users and silently not for others.
        sessionData.dest = this._sanitiseDest(dest);
        return sessionData;
      }

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
        // Thread the referral handle AND the campaign (both persisted at
        // initiate) into the new account's profile for analytics attribution.
        // This is the only point at which an OAuth signup can be attributed:
        // the browser storage that captured the campaign is two redirects away
        // and unreachable from here.
        if (ref) profile.ref = ref;
        if (Object.keys(utm).length) profile.utm = utm;
        let res = await this.addUser(profile, session_id);
        res.method = 'signup';
        res.dest = this._sanitiseDest(dest);
        return res;
      }

      // CASE D: 2FA required. session_login_with_oauth left the cookie in an
      // 'otp_pending' state instead of finalizing it. Mint + email an OTP and
      // hand off to the signin app's OTP screen (which finalizes the same
      // pending cookie via oauth.verify_otp -> session_login_otp).
      if (sessionData && sessionData.error_code === 'otp_required') {
        this.debug(`[Auth] 2FA required for ${email} (${provider})`);
        await this._send2faOtp(sessionData.id, sessionData.email || email);
        return {
          status: 'otp_required',
          email: sessionData.email || email,
          id: sessionData.id,
          // The pending cookie is keyed by the original signin session
          // (oauth_state.session_id), NOT this callback request's sid. The
          // redirect must bind the browser to THIS session so the SPA's later
          // oauth.verify_otp call resolves the right pending cookie.
          session_id,
          provider,
          // Carried through the OTP screen: a 2FA account that arrived on a
          // campaign link must land where the link named, like everyone else.
          // The signin app hands it back on the redirect it builds after
          // oauth.verify_otp finalises the session.
          dest: this._sanitiseDest(dest),
        };
      }

      this.warn(`[Auth] Unexpected OAuth callback result:`, sessionData);
      return { status: 'error', error: 'unexpected_error' };

    } catch (error) {
      this.warn(`[Auth] OAuth sign-in exception:`, error && error.message);
      throw error;
    }
  }

  /**
   * Mint a one-time code for `_uid` and email it to `_email`, reusing the
   * shared otp.html template. The secret stays server-side; the signin app
   * later submits only the code (oauth.verify_otp resolves the secret from the
   * pending session). Mirrors server-team's _send2faOtpEmail.
   * @param {string} _uid
   * @param {string} _email
   */
  async _send2faOtp(_uid, _email) {
    const token = uniqueId();
    const otp = await this.yp.await_proc("otp_create", _uid, token);
    if (!otp || !otp.code) {
      this.warn("[Auth] otp_create returned no code", { _uid });
      return 0;
    }
    const lang = this.input.ua_language() || "en";
    const lex = Cache.lex(lang);
    // Cache.lex() hands back the lexicon MAP, so a key it does not carry reads
    // as undefined — echoing the key name is Cache.message(), not this. Both
    // keys are absent from the default lexicon, so on any box whose lexicon has
    // not been loaded these went out with the literal string "undefined" as the
    // subject AND the headline. Guarded here rather than in the template so the
    // HTML part and the text part cannot fall back differently.
    const heading = lex._your_otp || "Your one-time code";
    const why_this_otp = lex._why_this_otp ||
      "You are receiving this code because a sign-in to your Drumee account needs to be verified.";
    const data = {
      heading,
      code: otp.code,
      why_this_otp,
    };
    const subject = heading;
    const msg = new Messenger({
      subject,
      recipient: _email,
      handler: this.exception && this.exception.email,
    });
    try {
      const tpl = resolve(__dirname, "../templates/otp.html");
      const html = msg.renderFrom(tpl, data);
      // The window is read back from the row otp_create actually minted
      // (it returns `expiry` = ctime + 600 beside the code) instead of being
      // restated here, because the OTP procedures disagree about it:
      // authenticate.sql and session_login_otp.sql expire at 10 minutes,
      // check.sql at 30, misc.sql sweeps at 5. A mail naming the wrong number
      // is worse than one naming none, so the line is dropped whenever the
      // two fields are not both present and sane.
      const ttl = Number(otp.expiry) - Number(otp.ctime);
      const expiry_line = Number.isFinite(ttl) && ttl > 0
        ? [`This code expires in ${Math.round(ttl / 60)} minutes.`, ""]
        : [];
      // Built from the same `data` the template gets, so the code and the copy
      // cannot diverge between the two alternatives. otp.html carries no
      // greeting, so none is invented here.
      const text = [
        heading,
        "",
        String(otp.code),
        "",
        why_this_otp,
        "",
        ...expiry_line,
        "Never share this code with anyone. Drumee will never ask you for it.",
        "",
        legalFooterText(),
      ].join("\n");
      // sendAs, not msg.send: the pinned Messenger re-wraps the From and turns
      // a full mailbox into a "Drumee>" display name. See ./mail-sender.
      return await sendAs(msg, { to: _email, subject, html, text });
    } catch (e) {
      this.warn("[Auth] 2FA OTP email send failed", e);
      return 0;
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
   * OAuth callback error paths would otherwise leave the browser on a raw
   * JSON/400 page (or a 504 when the provider call hangs) — bounce it back
   * to the signin screen with a status flag instead.
   * A mobile client is sent to its own scheme instead (302, no cookie).
   * @param {string} error
   * @param {string|null} [client] from clientFromState
   * @param {string} [provider] required when client is set
   */
  sendOauthError(error, client = null, provider = null) {
    if (client && provider) {
      return this.sendMobileReturn(client, provider, { error: error || 'oauth_failed' });
    }
    const { main_domain, endpoint_path } = sysEnv();
    const redirect = `https://${main_domain}${endpoint_path}/#/welcome/signin?oauth_error=${encodeURIComponent(error || 'oauth_failed')}`;
    const tpl = resolve(__dirname, '../templates/oauth-error.html');
    const html = String(readFileSync(tpl)).trim();
    const content = template(html)({ redirect });
    this.output.set_header(
      "Cache-Control",
      "no-cache, no-store, must-revalidate"
    );
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
    // Seed the new account's desk with a Personal Workspace: a plain folder at
    // the home root, NOT a hub — which mirrors the desk create-workspace form's
    // "personal" branch (ui-team media/form), avoiding hub membership and
    // sidebar semantics.
    //
    // INTERNAL AND EXTERNAL WORKSPACES ARE NO LONGER SEEDED HERE. This used to
    // create two hubs as well — "Internal Workspace" (area 'private') and
    // "External Workspace" (area 'share') — through createHub(). Both are gone
    // deliberately; a new account now starts with the Personal folder only and
    // creates whatever else it wants, which is the path the post-signup
    // tutorial already walks it through.
    //
    // Two things followed from seeding hubs here, for whoever considers putting
    // them back:
    //   - Every signup drew TWO entities from the hub pool, silently. Signups
    //     were a pool consumer nobody counted alongside the create-workspace
    //     button, and the pool is finite (yp.pickupEntity + the hubs factory).
    //   - When the pool was empty the createHub calls failed, and this method
    //     only WARNED, so signup completed and the account was simply missing
    //     its workspaces with nothing shown to the user and no repair path.
    //     That happened on stage between 24 Aug and 3 Sep 2026: accounts from
    //     that window own no hubs at all.
    // The Personal folder never had either problem — mfs_make_dir touches no
    // pool — which is why it is the one that stays.
    //
    // The account object returned by drumate_create (create_account with
    // autosignin=0) carries what we need: db_name (user_db) and home_id
    // (desk root = parent).
    const user_db = opt.db_name;
    const pid = opt.home_id;

    if (!user_db || !pid) {
      this.warn("[make_default_folers] Missing account context; skipping", opt);
      return;
    }

    try {
      await this.make_dir(user_db, pid, "Personal Workspace");
    } catch (e) {
      this.warn(`[make_default_folers] Error creating Personal Workspace folder:`, e && e.message);
    }
  }

}

module.exports = Account;
