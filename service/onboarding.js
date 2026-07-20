// service/onboarding.js

const { Entity } = require('@drumee/server-core');
const { toArray, Cache, Constants, Attr, Messenger } = require('@drumee/server-essentials');
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
    const sessionId = this.input.sid();
    const firstName = this.input.need(Attr.firstname);
    const lastName = this.input.get(Attr.lastname) || null;
    const email = this.input.get(Attr.email) || null;
    const countryCode = this.input.get('country_code') || null;

    if (!firstName) {
      return this.exception.user("firstname is required.");
    }

    await this.db.await_proc(
      `${this.app_db}.save_onboarding_user_info`,
      sessionId, firstName, lastName, email, countryCode
    );
    this.output.data({ success: true, message: 'User info saved.', data: {} });
  }

  /**
   * v2 Step 2: industry / kind of work.
   */
  async save_industry() {
    const sessionId = this.input.sid();
    const industry = this.input.need('industry');
    const industryOther = this.input.get('industry_other') || null;
    await this.db.await_proc(
      `${this.app_db}.save_onboarding_industry`,
      sessionId, industry, industryOther
    );
    this.output.data({ success: true, message: 'Industry saved.', data: {} });
  }

  /**
   * v2 Step 3: role.
   */
  async save_role() {
    const sessionId = this.input.sid();
    const role = this.input.need('role');
    const roleOther = this.input.get('role_other') || null;
    await this.db.await_proc(
      `${this.app_db}.save_onboarding_role`,
      sessionId, role, roleOther
    );
    this.output.data({ success: true, message: 'Role saved.', data: {} });
  }

  /**
   * v2 Step 4: team size. Replaces save_usage_plan in the new wizard.
   */
  async save_team_size() {
    const sessionId = this.input.sid();
    const teamSize = this.input.need('team_size');
    await this.db.await_proc(
      `${this.app_db}.save_onboarding_team_size`,
      sessionId, teamSize
    );
    this.output.data({ success: true, message: 'Team size saved.', data: {} });
  }

  /**
   * v2 Step 5: workspace intent ("What do you want to start with?"). Optional.
   */
  async save_intent() {
    const sessionId = this.input.sid();
    const intent = this.input.need('intent');
    await this.db.await_proc(
      `${this.app_db}.save_onboarding_intent`,
      sessionId, intent
    );
    this.output.data({ success: true, message: 'Intent saved.', data: {} });
  }

  /**
   * v2 Step 6 (tools page, second block): challenges + free-text note.
   * Both are optional from the UI's "Tell me later" path, but if called
   * the challenges array is required.
   */
  async save_challenges() {
    const sessionId = this.input.sid();
    const challenges = toArray(this.input.need('challenges'));
    const note = this.input.get('note') || null;
    // Pass array directly — Drumee db driver handles JSON serialization.
    // Do NOT JSON.stringify here (causes double-encoding at the driver layer).
    await this.db.await_proc(
      `${this.app_db}.save_onboarding_challenges`,
      sessionId, challenges, note
    );
    this.output.data({ success: true, message: 'Challenges saved.', data: {} });
  }

  /**
   * 
   */
  async reset() {
    this.output.clearAuthorization(this.input.authorization());
    this.output.data({});
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
    const sessionId = this.input.sid();
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
   * FE sends: { tools: ["notion", "slack"] }
   */
  async save_tools() {
    const sessionId = this.input.sid();
    const tools = toArray(this.input.need('tools'));
    if (!tools.length) {
      return this.exception.user('tools array is required and must not be empty.');
    }
    // Pass array directly — Drumee db driver handles JSON serialization.
    await this.db.await_proc(
      `${this.app_db}.save_onboarding_tools`,
      sessionId, tools
    );
    this.output.data({ success: true, message: 'Tools saved.', data: {} });
  }

  /**
   * 
   */
  async save_privacy() {
    const sessionId = this.input.sid();
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
    const sessionId = this.input.sid();
    let completionStatusRaw;

    try {
      completionStatusRaw = await this.db.await_proc(`${this.app_db}.check_onboarding_completion`, sessionId);
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
    const sessionId = this.input.sid();

    try {
      await this.db.await_proc(`${this.app_db}.mark_onboarding_complete`, sessionId);
    } catch (spError) {
      console.error(`[ONBOARDING ERROR] Error calling mark_complete SP for session ${sessionId}: ${spError.message}`);
      throw spError;
    }

    this.output.data({ success: true, message: 'Onboarding marked as complete (validated).', data: {} });
  }

  /**
   * 
   */
  async update_profile() {
    const { email } = this.user.get(Attr.profile);
    if (this.uid === ID_NOBODY) {
      return this.output.data({ status: "no-user" });
    }
    const sql = `SELECT * FROM ${this.app_db}.onboarding_responses WHERE email=? ORDER BY mtime DESC LIMIT 1`;
    const row = await this.yp.await_query(sql, email) || {};
    const { firstname, lastname, country_code, industry, role, team_size, intent } = row;
    const profile = { onboarded: 1 };
    if (firstname)    profile.firstname    = firstname;
    if (lastname)     profile.lastname     = lastname;
    if (country_code) profile.country_code = country_code;
    if (role)         profile.role         = role;
    if (industry)     profile.industry     = industry;
    if (team_size)    profile.team_size    = team_size;
    if (intent)       profile.intent       = intent;
    await this.yp.await_proc('drumate_update_profile', this.uid, profile);
    this.output.data(profile);
  }

  /**
   * 
   * @returns 
   */
  async get_response() {
    const sessionId = this.input.sid();
    let responseDataRaw;
    let { xlink } = JSON.parse(this.conf);
    try {
      responseDataRaw = await this.db.await_proc(`${this.app_db}.get_onboarding_response`, sessionId);
    } catch (spError) {
      console.error(`[ONBOARDING ERROR] Error calling get_response SP for session ${sessionId}: ${spError.message}`);
      throw spError;
    }

    let responseData = toArray(responseDataRaw)[0] || null;

    if (!responseData) {
      this.output.data({ xlink });
      return;
    }

    // Parse JSON tools
    if (responseData.current_tools && typeof responseData.current_tools === 'string') {
      try {
        responseData.current_tools = JSON.parse(responseData.current_tools);
      } catch (e) {
        this.warn("Failed to parse current_tools JSON for session:", sessionId);
        responseData.current_tools = [];
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
    if (!this.uid) {
      return this.exception.user('User not authenticated.');
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
    if (!this.uid) {
      return this.exception.user('User not authenticated.');
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
    if (!this.uid) {
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