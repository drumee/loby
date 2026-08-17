// service/onboarding.js

const { Entity } = require('@drumee/server-core');
const { toArray, Cache, Constants, Attr, Messenger, RedisStore } = require('@drumee/server-essentials');
const { resolve } = require('path');
const { ID_NOBODY } = Constants;
class Onboarding extends Entity {

  initialize(opt) {
    super.initialize(opt);
    this.conf = Cache.getSysConf('ob_conf');
    let { db_name } = JSON.parse(this.conf);
    this.app_db = db_name;
    console.log("Onboarding Service Initialized.  Config:", db_name, this.conf);
  }

  // Session ID
  _getSessionId() {
    const sessionId = this.input.sid();
    if (!sessionId) {
      console.error('[ONBOARDING ERROR] this.input.sid() returned null or undefined.');
      throw new Error("Session ID not found.");
    }
    return sessionId;
  }

  /**
   * The authenticated user, or null when the request is anonymous.
   * `this.uid` is ID_NOBODY (not falsy) for anonymous callers, so a bare
   * `if (!this.uid)` — which is what several handlers used to do — passes for
   * anonymous traffic and then blows up on `this.user.get(...)`.
   */
  _uid() {
    if (!this.uid || this.uid === ID_NOBODY) return null;
    return this.uid;
  }

  /**
   * Identity for a write/read of onboarding answers.
   *
   * Returns { sessionId, uid }. `uid` is the STABLE key: session ids rotate on
   * re-login, token refresh and expiry, and keying survey answers on a
   * transient value is what made the wizard lose data mid-flow. sessionId is
   * still passed through so pre-uid rows keep resolving (see
   * schemas/procedures/onboarding_resolve_row.sql for the resolution order).
   *
   * Returns null — after answering the request — when authentication is
   * required and absent, so callers can `if (!id) return;`. Defence in depth:
   * the ACL is the first gate (acl/onboarding.json), this is the second, and
   * it is the one that does not depend on ACL configuration being right.
   */
  _identity({ required = true } = {}) {
    const sessionId = this.input.sid();
    const uid = this._uid();
    if (required && !uid) {
      this.exception.unauthorized('_authentication_required');
      return null;
    }
    if (!sessionId && !uid) {
      this.exception.user('No session or user identity on this request.');
      return null;
    }
    return { sessionId, uid };
  }

  /**
   * 
   */
  async get_env() {
    console.log("[ONBOARDING] get_env called. Returning config:", this.conf);
    this.output.data(this.conf || {});
  }

  /**
   * 
   */
  async save_signup_info() {
    const sessionId = this.input.sid();
    const email = this.input.need(Attr.email);

    // Call SP
    await this.db.await_proc(
      `${this.app_db}.save_signup_info`,
      sessionId, email
    );
    this.output.data({ success: true, message: 'User info saved.', data: {} });
  }

  /**
   * v2 Step 1: capture firstname only. lastname/email/country_code are
   * collected at signup (signup_data); they're forwarded here when the
   * legacy v1 wizard is still in use, but no longer required.
   */
  async save_user_info() {
    const id = this._identity();
    if (!id) return;
    const { sessionId, uid } = id;
    const firstName = this.input.need(Attr.firstname);
    const lastName = this.input.get(Attr.lastname) || null;
    // Backfill the account email onto the onboarding row when the client
    // doesn't send it (the v2 wizard posts only firstname). Onboarding runs
    // authenticated, so this.user carries the profile. Persisting the email
    // here is what lets analytics join a response back to its user account —
    // without it, onboarding_responses.email stays NULL and the onboarding
    // export's User ID / Username / Email / Joined columns come out empty.
    let email = this.input.get(Attr.email) || null;
    if (!email && uid) {
      const profile = this.user.get(Attr.profile) || {};
      email = profile.email || null;
    }
    // Trim here as well as in the procedure. Neither source of this address is
    // typed into the wizard - it comes from signup or from the stored profile -
    // and a stray space in either made the anchored format check reject it,
    // which blocked step 1 with no field for the user to correct.
    const trim = (v) => (typeof v === 'string' ? v.trim() : v);
    email = trim(email) || null;
    const countryCode = trim(this.input.get('country_code')) || null;

    if (!firstName) {
      return this.exception.user("firstname is required.");
    }

    await this.db.await_proc(
      `${this.app_db}.save_onboarding_user_info`,
      sessionId, uid, firstName, lastName, email, countryCode
    );
    this.output.data({ success: true, message: 'User info saved.', data: {} });
  }

  /**
   * v2 Step 2: industry / kind of work.
   */
  async save_industry() {
    const id = this._identity();
    if (!id) return;
    const industry = this.input.need('industry');
    const industryOther = this.input.get('industry_other') || null;
    await this.db.await_proc(
      `${this.app_db}.save_onboarding_industry`,
      id.sessionId, id.uid, industry, industryOther
    );
    this.output.data({ success: true, message: 'Industry saved.', data: {} });
  }

  /**
   * v2 Step 3: role.
   */
  async save_role() {
    const id = this._identity();
    if (!id) return;
    const role = this.input.need('role');
    const roleOther = this.input.get('role_other') || null;
    await this.db.await_proc(
      `${this.app_db}.save_onboarding_role`,
      id.sessionId, id.uid, role, roleOther
    );
    this.output.data({ success: true, message: 'Role saved.', data: {} });
  }

  /**
   * v2 Step 4: team size. Replaces save_usage_plan in the new wizard.
   */
  async save_team_size() {
    const id = this._identity();
    if (!id) return;
    const teamSize = this.input.need('team_size');
    await this.db.await_proc(
      `${this.app_db}.save_onboarding_team_size`,
      id.sessionId, id.uid, teamSize
    );
    this.output.data({ success: true, message: 'Team size saved.', data: {} });
  }

  /**
   * v2 Step 5: workspace intent ("What do you want to start with?"). Optional.
   */
  async save_intent() {
    const id = this._identity();
    if (!id) return;
    const intent = this.input.need('intent');
    await this.db.await_proc(
      `${this.app_db}.save_onboarding_intent`,
      id.sessionId, id.uid, intent
    );
    this.output.data({ success: true, message: 'Intent saved.', data: {} });
  }

  /**
   * v2 Step 6 (tools page, second block): challenges + free-text note.
   * Both are optional from the UI's "Tell me later" path, but if called
   * the challenges array is required.
   */
  async save_challenges() {
    const id = this._identity();
    if (!id) return;
    // `get`, not `need`: an EMPTY selection is a legal answer ("none of
    // these"), and it must be able to overwrite a previously saved list.
    // `need` would still admit [], but defaulting here also keeps a client
    // that omits the key entirely from erroring out.
    const challenges = toArray(this.input.get('challenges') || []);
    const note = this.input.get('note') || null;
    // Pass array directly — Drumee db driver handles JSON serialization.
    // Do NOT JSON.stringify here (causes double-encoding at the driver layer).
    await this.db.await_proc(
      `${this.app_db}.save_onboarding_challenges`,
      id.sessionId, id.uid, challenges, note
    );
    this.output.data({ success: true, message: 'Challenges saved.', data: {} });
  }

  /**
   * v2 Step 8: teammates invited from the wizard.
   *
   * The invitations themselves are sent by contact/invite, which creates the
   * contact and mails it; this records the RESULT on the onboarding row, so a
   * response can say how many people the user brought in. Without it the last
   * step of the wizard left no trace at all and the funnel export stopped one
   * column short.
   *
   * `get`, not `need`: an empty array is a legal answer — the user skipped the
   * step without inviting anyone — and has to be able to overwrite. The client
   * sends the full set it has sent so far rather than a delta, so the array is
   * stored whole (see save_onboarding_invites.sql).
   */
  async save_invites() {
    const id = this._identity();
    if (!id) return;
    // Pass the array directly — the Drumee db driver handles JSON
    // serialization, and stringifying here double-encodes at the driver layer.
    const invites = toArray(this.input.get('invites') || []);
    await this.db.await_proc(
      `${this.app_db}.save_onboarding_invites`,
      id.sessionId, id.uid, invites
    );
    this.output.data({ success: true, message: 'Invites saved.', data: {} });
  }

  /**
   * True reset: clear the user's stored onboarding answers.
   *
   * The old implementation called clearAuthorization() and nothing else — it
   * discarded the SESSION but kept the DATA. That is backwards on both counts:
   *
   *   - the half-filled onboarding_responses row survived, keyed to a session
   *     id that no longer existed, so it was unreachable forever. Every reset
   *     leaked one orphan row.
   *   - the wizard restarted against a dead session, so the first save of the
   *     "fresh" run wrote under a different identity than the reads.
   *
   * The wizard runs inside an authenticated desk session; resetting a
   * questionnaire is not a reason to destroy the user's login. So this drops
   * the answers and leaves the session intact. The stored procedure also
   * collects any orphan rows the previous implementation left behind.
   */
  async reset() {
    const id = this._identity();
    if (!id) return;
    const res = toArray(
      await this.db.await_proc(
        `${this.app_db}.reset_onboarding_response`,
        id.sessionId, id.uid
      )
    )[0] || {};
    this.output.data({ success: true, removed: res.removed || 0, status: 'reset' });
  }

  /**
   * 
   */
  async get_countries() {
    const requestedLocale = this.input.get('locale_code') || this.session?.locale || 'en_US';

    let countriesListRaw;
    try {
      countriesListRaw = await this.db.await_proc(
        `${this.app_db}.get_countries`,
        requestedLocale
      );
    } catch (spError) {
      console.error(`[ONBOARDING ERROR] Error calling get_countries SP: ${spError.message}`);
      throw spError;
    }

    const countriesList = toArray(countriesListRaw);

    this.output.data({
      success: true,
      data: countriesList
    });
  }

  /**
   * Step 2: Save team type selection.
   * Valid values: personal | startup | enterprise
   */
  async save_usage_plan() {
    const id = this._identity();
    if (!id) return;
    const sessionId = id.sessionId;
    const usagePlan = this.input.need(Attr.args);

    const VALID_PLANS = ['personal', 'startup', 'enterprise'];
    if (!VALID_PLANS.includes(usagePlan)) {
      return this.exception.user(
        'Invalid usage plan. Must be one of: personal, startup, enterprise.'
      );
    }

    await this.db.await_proc(
      `${this.app_db}.save_onboarding_usage_plan`,
      sessionId, usagePlan
    );
    this.output.data({ success: true, message: 'Usage plan saved.', data: {} });
  }

  /**
   * v2 Step 5A: tools currently used by the team (multi-select).
   * Valid values: google_drive | notion | slack | dropbox |
   *               clickup | trello | jira | other
   * FE sends: { tools: ["notion", "other"], tools_other: "Obsidian" }
   *
   * Two deliberate changes from v2:
   *
   *  - An empty array is accepted instead of rejected. It used to throw
   *    ('tools array is required and must not be empty'), so the client
   *    skipped the call when nothing was selected — which meant de-selecting
   *    every tool silently left the previously saved list in the database.
   *    An empty selection is a real answer and must overwrite.
   *
   *  - `tools_other` carries the "Other" free text in its own field, matching
   *    industry_other / role_other, instead of being spliced into the array
   *    where it was indistinguishable from a canonical key. The stored
   *    procedure normalises either shape, so older clients keep working.
   */
  async save_tools() {
    const id = this._identity();
    if (!id) return;
    const tools = toArray(this.input.get('tools') || []);
    const toolsOther = this.input.get('tools_other') || null;
    // Pass array directly — Drumee db driver handles JSON serialization.
    await this.db.await_proc(
      `${this.app_db}.save_onboarding_tools`,
      id.sessionId, id.uid, tools, toolsOther
    );
    this.output.data({ success: true, message: 'Tools saved.', data: {} });
  }

  /**
   * 
   */
  async save_privacy() {
    const id = this._identity();
    if (!id) return;
    const sessionId = id.sessionId;
    const privacyLevel = this.input.need('privacy');

    const level = parseInt(privacyLevel);
    if (isNaN(level) || level < 1 || level > 5) {
      return this.exception.user("Privacy level must be between 1 and 5.")
    }
    // Call SP
    await this.db.await_proc(
      `${this.app_db}.save_onboarding_privacy`,
      sessionId, level
    );

    this.output.data({ success: true, message: 'Privacy level saved.', data: {} });
  }

  /**
   * 
   */
  async check_completion() {
    const id = this._identity();
    if (!id) return;
    const { sessionId, uid } = id;
    let completionStatusRaw;

    try {
      completionStatusRaw = await this.db.await_proc(
        `${this.app_db}.check_onboarding_completion`, sessionId, uid
      );
    } catch (spError) {
      console.error(`[ONBOARDING ERROR] Error calling check_completion SP for session ${sessionId}: ${spError.message}`);
      throw spError;
    }

    let completionStatus = toArray(completionStatusRaw)[0] || {
      // Return a default structure if SP returns nothing (user not started)
      session_id: sessionId,
      is_completed: false,
      status: 'not_started',
      steps_completed: null // Match SP output when not started
    };

    this.output.data({ success: true, data: completionStatus });
  }

  /**
   * 
   */
  async mark_complete() {
    const id = this._identity();
    if (!id) return;
    const { sessionId, uid } = id;

    try {
      await this.db.await_proc(`${this.app_db}.mark_onboarding_complete`, sessionId, uid);
    } catch (spError) {
      console.error(`[ONBOARDING ERROR] Error calling mark_complete SP for session ${sessionId}: ${spError.message}`);
      // Surface it as a client error rather than a 500: every SIGNAL this
      // procedure raises is actionable by the user ("Step 2 is incomplete"),
      // and the wizard now shows it and keeps them on the page instead of
      // dropping them into a workspace with unsaved answers.
      return this.exception.user(
        (spError && spError.message) || 'Onboarding could not be completed.'
      );
    }

    this.output.data({ success: true, message: 'Onboarding marked as complete (validated).', data: {} });
  }

  /**
   * Mirror the onboarding answers onto the drumate profile and set
   * onboarded = 1 (which is what stops desk from re-launching the wizard).
   *
   * Identity is now validated BEFORE any user data is touched. The previous
   * order destructured `this.user.get(Attr.profile)` first and only then
   * checked for ID_NOBODY, so an anonymous request threw on the destructure
   * (profile is undefined) instead of returning the intended "no-user" —
   * a 500 where a clean answer was already written two lines below.
   *
   * The row is looked up by uid first and only falls back to email. Email is
   * not an identity: it is nullable on this table, it is only backfilled from
   * step 1, and "latest row with this address" can belong to a different
   * session than the one that just completed. uid is exact.
   */
  async update_profile() {
    const uid = this._uid();
    if (!uid) {
      return this.output.data({ status: "no-user" });
    }
    const { email } = this.user.get(Attr.profile) || {};

    let row = await this.yp.await_query(
      `SELECT * FROM ${this.app_db}.onboarding_responses WHERE uid=? ORDER BY mtime DESC LIMIT 1`,
      uid
    );
    if (!row && email) {
      // Pre-migration rows carry no uid. Resolving them by email here is what
      // keeps an in-flight onboarding (started before this deploy) completing
      // normally instead of syncing an empty profile.
      row = await this.yp.await_query(
        `SELECT * FROM ${this.app_db}.onboarding_responses WHERE email=? ORDER BY mtime DESC LIMIT 1`,
        email
      );
    }
    row = row || {};

    const {
      firstname, lastname, country_code,
      industry, industry_other, role, role_other, team_size, intent
    } = row;
    const profile = { onboarded: 1 };
    if (firstname)    profile.firstname    = firstname;
    if (lastname)     profile.lastname     = lastname;
    if (country_code) profile.country_code = country_code;
    // Store what the user actually said, not the literal "other" marker —
    // consistent with how the analytics export renders these columns.
    if (role)         profile.role         = (role === 'other' && role_other) ? role_other : role;
    if (industry)     profile.industry     = (industry === 'other' && industry_other) ? industry_other : industry;
    if (team_size)    profile.team_size    = team_size;
    if (intent)       profile.intent       = intent;
    await this.yp.await_proc('drumate_update_profile', this.uid, profile);
    // AFTER the write, never before: the dashboard re-reads the row from the
    // database, so publishing first would race its own commit and push the old
    // status. Not awaited — see _pushReferralLive.
    this._pushReferralLive(this.uid);
    this.output.data(profile);
  }

  /**
   * Tell any open analytics dashboard that this user's referral row changed.
   *
   * WHY IT IS HERE. Setting onboarded = 1 is the New -> Onboarding transition
   * on the Referral users board. The board polls every two minutes, so without
   * a push the row reads stale for up to that long; with one it turns over
   * within a second of the user pressing the last button in the wizard.
   *
   * NOT AWAITED AND NEVER THROWS. Onboarding completion is the user's flow;
   * an analytics push is a bystander. A slow Redis or a dashboard nobody has
   * open must not add latency to update_profile, and must certainly not fail
   * it — the caller has already committed the profile write by the time we
   * run, so a rejection here would report failure for work that succeeded.
   *
   * THE ROW COMES FROM referral_members. Not from anything assembled here:
   * that procedure owns the status CASE, and re-deriving it in a publisher is
   * how a live badge and a polled badge start disagreeing. Asking it for the
   * row doubles as the cohort gate — it answers nothing for a user who was
   * never referred, and those are the majority, so the push is skipped without
   * a second query.
   *
   * Recipients are resolved by referral_live_sockets (analytics-server
   * schemas): every active socket of every user permitted to read the
   * analytics hub. That covers each open tab, so multi-tab needs nothing
   * extra, and it is the same access rule get_env gates on.
   *
   * The mirror of this method is server-team service/private/desk.js
   * track_workspace, which reports the Onboarding -> Activated half of the
   * same transition. Keep the payload shape identical.
   *
   * @param {String} uid the referred user whose row moved
   */
  async _pushReferralLive(uid) {
    try {
      if (!uid) return;
      const rows = toArray(await this.yp.await_proc('referral_members', { uid }));
      const model = rows && rows[0];
      if (!model) return; // not a referred user — nothing on that board to move
      const sockets = toArray(await this.yp.await_proc('referral_live_sockets'));
      if (!sockets || !sockets.length) return; // no dashboard open anywhere
      await RedisStore.sendData(
        {
          model,
          // Read by the dashboard's onWsMessage. The envelope carries no
          // top-level `service`, so router/push stamps it "live.update" and
          // the client routes it to the `live` event; this name is what tells
          // the widget which live message it is holding.
          options: { service: 'live.referral_member', keys: '*' },
        },
        sockets
      );
    } catch (e) {
      this.warn('[onboarding] referral live push failed', e && e.message);
    }
  }

  /**
   * 
   * @returns 
   */
  async get_response() {
    const id = this._identity();
    if (!id) return;
    const { sessionId, uid } = id;
    let responseDataRaw;
    let { xlink } = JSON.parse(this.conf);
    try {
      responseDataRaw = await this.db.await_proc(
        `${this.app_db}.get_onboarding_response`, sessionId, uid
      );
    } catch (spError) {
      console.error(`[ONBOARDING ERROR] Error calling get_response SP for session ${sessionId}: ${spError.message}`);
      throw spError;
    }

    let responseData = toArray(responseDataRaw)[0] || null;

    if (!responseData) {
      this.output.data({ xlink });
      return;
    }

    // Parse the JSON columns. `challenges` is parsed too now: this payload
    // drives wizard resume, and an unparsed string there meant the challenge
    // chips came back unselected on every reload.
    for (const key of ['current_tools', 'tools', 'challenges', 'invites']) {
      const v = responseData[key];
      if (v && typeof v === 'string') {
        try {
          responseData[key] = JSON.parse(v);
        } catch (e) {
          this.warn(`Failed to parse ${key} JSON for session:`, sessionId);
          responseData[key] = [];
        }
      }
    }
    this.conf = Cache.getSysConf('ob_conf');
    responseData.xlink = xlink;
    this.output.data(responseData);
  }

  /**
   * Step 3: Generate shareable referral signup link for the current user.
   * Fetches or generates the user's referral code from C_reward,
   * then returns the full signup URL.
   *
   * NOTE: Calls reward_get_referral_code cross-DB via this.db.
   * If loby's DB user lacks EXECUTE on C_reward, switch to this.yp.await_proc(...).
   */
  async get_onboarding_invite_link() {
    if (!this._uid()) {
      // ID_NOBODY is a truthy string, so the old `!this.uid` test let
      // anonymous callers straight through to the reward/referral lookups.
      return this.exception.unauthorized('User not authenticated.');
    }

    const rewardConf = JSON.parse(Cache.getSysConf('reward_hub_conf') || '{}');
    const reward_db = rewardConf.db_name;
    if (!reward_db) {
      return this.exception.user('Reward hub not configured.');
    }

    const result = await this.db.await_proc(
      `${reward_db}.reward_get_referral_code`,
      this.uid
    );

    const rows = toArray(result);
    const row = rows[0] || {};

    if (!row.referral_code || row.status === 'failed') {
      return this.exception.user('Failed to get referral code.');
    }

    const homepath = this.input.homepath();
    const referral_url = `${homepath}#/welcome/signup?ref=${encodeURIComponent(row.referral_code)}`;

    this.output.data({
      referral_code: row.referral_code,
      referral_url
    });
  }

  /**
   * Step 7 (new wizard) / Step 3 (v1 wizard): Send invite emails.
   *
   * Accepts two input formats:
   *   v2 (new wizard): { emails: [{email, role}] }
   *     role is one of: admin | write | read
   *     (maps to Drumee privilege bitmask: admin=31, write=7, read=3)
   *   v1 (legacy):     { emails: ["addr@example.com", ...] }
   *     defaults to role: 'member' for backward-compat
   *
   * Role is included in the invite email as informational context.
   * Actual hub permission granting happens at signup via the referral flow.
   *
   * NOTE: cross-DB call to C_reward via this.db.
   * If loby DB user lacks EXECUTE on C_reward, switch to this.yp.await_proc(...).
   */
  async send_onboarding_invites() {
    if (!this._uid()) {
      // ID_NOBODY is a truthy string, so the old `!this.uid` test let
      // anonymous callers straight through to the reward/referral lookups.
      return this.exception.unauthorized('User not authenticated.');
    }

    const raw = toArray(this.input.need('emails'));
    if (!raw.length) {
      return this.exception.user('No emails provided.');
    }

    // v2 wizard sends [{email, role}]; v1 sent bare strings. Accept both.
    const VALID_ROLES = ['admin', 'write', 'read'];
    const invites = raw.map(e => {
      if (e && typeof e === 'object') {
        const role = VALID_ROLES.includes(e.role) ? e.role : 'read';
        return { email: String(e.email || '').trim(), role };
      }
      return { email: String(e).trim(), role: 'read' };
    });

    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const invalid = invites.filter(i => !EMAIL_RE.test(i.email)).map(i => i.email);
    if (invalid.length) {
      return this.exception.user(`Invalid email address(es): ${invalid.join(', ')}`);
    }

    const rewardConf = JSON.parse(Cache.getSysConf('reward_hub_conf') || '{}');
    const reward_db = rewardConf.db_name;
    if (!reward_db) {
      return this.exception.user('Reward hub not configured.');
    }

    // Get or generate inviter's referral code from C_reward
    const result = await this.db.await_proc(
      `${reward_db}.reward_get_referral_code`,
      this.uid
    );
    const rows = toArray(result);
    const row = rows[0] || {};

    if (!row.referral_code || row.status === 'failed') {
      return this.exception.user('Failed to get referral code.');
    }

    const homepath = this.input.homepath();
    const referral_url = `${homepath}#/welcome/signup?ref=${encodeURIComponent(row.referral_code)}`;
    const tpl = resolve(__dirname, './templates/onboarding-invite.html');
    let sent = 0;

    for (const { email, role } of invites) {
      const data = {
        heading: 'You have been invited to Drumee',
        hello: 'Hello,',
        message: 'Your colleague has invited you to join Drumee — a sovereign workspace for files, chat, and collaboration.',
        link: referral_url,
        role,
        workspace: 'Join Drumee',
        signature: 'The Drumee Team',
        reminder: `© ${new Date().getFullYear()} Drumee. All rights reserved.`,
      };

      const msg = new Messenger({
        subject: 'You have been invited to Drumee',
        recipient: email,
        handler: this.exception.email,
      });

      try {
        const html = msg.renderFrom(tpl, data);
        await msg.send({ html });
        sent++;
      } catch (e) {
        this.warn(`[send_onboarding_invites] Failed to send to ${email}:`, e && e.message);
      }
    }

    this.output.data({ success: true, sent });
  }

  /**
  * Get activation status for the current user.
  * Events tracked via yp.services_log for:
  *   - workspace_created  → desk.create_hub
  *   - teammate_invited   → onboarding.send_onboarding_invites
  * Events tracked via direct hub DB query for:
  *   - first_file_uploaded → media table (high-frequency, not suitable for services_log)
  *   - folder_chat_started → channel table (high-frequency, not suitable for services_log)
  */
  async get_activation_status() {
    if (!this._uid()) {
      return this.output.data({
        workspace_created: false,
        first_file_uploaded: false,
        teammate_invited: false,
        folder_chat_started: false
      });
    }

    // Query services_log for low-frequency logged events
    let logged = new Set();
    try {
      const raw = toArray(
        await this.yp.await_query(
          `SELECT DISTINCT name FROM services_log WHERE uid = ? AND name IN (?, ?)`,
          this.uid,
          'desk.create_hub',
          'onboarding.send_onboarding_invites'
        )
      );
      logged = new Set(raw.map(r => r.name));
    } catch (e) {
      this.warn('[get_activation_status] services_log query failed:', e && e.message);
    }

    // Query hub DB directly for high-frequency events
    let first_file_uploaded = false;
    let folder_chat_started = false;

    try {
      const hubRow = toArray(
        await this.yp.await_query(
          `SELECT db_name FROM entity WHERE owner_id = ? AND type = 'hub' AND area = 'private' LIMIT 1`,
          this.uid
        )
      )[0];

      if (hubRow && hubRow.db_name) {
        const db = hubRow.db_name;

        const fileRow = toArray(
          await this.yp.await_query(
            `SELECT 1 AS found FROM ${db}.media WHERE owner_id = ? AND category NOT IN ('folder', 'hub', 'root') LIMIT 1`,
            this.uid
          )
        )[0];
        first_file_uploaded = !!fileRow;

        const chatRow = toArray(
          await this.yp.await_query(
            `SELECT 1 AS found FROM ${db}.channel WHERE author_id = ? LIMIT 1`,
            this.uid
          )
        )[0];
        folder_chat_started = !!chatRow;
      }
    } catch (e) {
      this.warn('[get_activation_status] Hub DB query failed:', e && e.message);
    }

    this.output.data({
      workspace_created: logged.has('desk.create_hub'),
      first_file_uploaded,
      teammate_invited: logged.has('onboarding.send_onboarding_invites'),
      folder_chat_started
    });
  }
}

module.exports = Onboarding;