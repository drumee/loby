// service/signup.js

const { Cache, Attr, sysEnv, Messenger, uniqueId } = require('@drumee/server-essentials');
const { toArray } = require('@drumee/server-essentials').utils;
const { resolve } = require('path');
const { isEmpty, isArray } = require('lodash');
const Loby = require("./lib/loby")
const { uniqueNamesGenerator, colors, animals, adjectives } = require('unique-names-generator');

const folderNameConfig = {
  dictionaries: [colors, animals],
  length: 2,
  separator: ' ',
  style: 'capital'
}

const hubNameConfig = {
  dictionaries: [adjectives, animals],
  length: 2,
  separator: ' ',
  style: 'capital'
}

class Signup extends Loby {

  initialize(opt) {
    super.initialize(opt);
    this.conf = Cache.getSysConf('ob_conf');
    let { db_name } = JSON.parse(this.conf);
    this.app_db = db_name;
  }

  /**
   * 
   */
  async get_info() {
    const sessionId = this.input.sid();
    let sql = `SELECT email, otp FROM ${this.app_db}.signup_data WHERE session_id=?`
    let { email } = await this.db.await_query(sql, sessionId) || {};
    this.output.data({ email });
  }

  /**
   * 
   */
  async save_info() {
    const sessionId = this.input.sid();
    const email = this.input.need(Attr.email);
    let user = await this.yp.await_proc("drumate_exists", email);
    if (user && user.email) {
      return this.output.data({ status: "user_exists", email });
    }
    // Call SP
    let status = await this.db.await_proc(
      `${this.app_db}.save_signup_info`,
      sessionId, email
    );
    const ulang = this.input.ua_language();
    let lex = Cache.lex(ulang)
    const { main_domain } = sysEnv();
    let data = {
      heading: lex._your_account_is_all_set,
      message: lex._your_otp_is_x.format(status.otp),
      link: `https://${main_domain}/-/`,
      signature: lex._drumee_team,
      reminder: lex._copyright.format(`${new Date().getFullYear()}`),
      hello: lex._hello_x.format(email || ""),
    }
    const msg = new Messenger({
      subject: lex._welcome_on_drumee,
      recipient: email,
      handler: this.exception.email,
    });

    let sent = 0;
    try {
      let tpl = resolve(__dirname, "./templates/onboarding.js")
      let html = msg.renderFrom(tpl, data)
      await msg.send({ html });
      sent = 1;
    } catch (e) {
      this.warn(e)
    }
    this.output.data({ status: 'ok', sent, email });
  }

  /**
   * 
   */
  async send_signup_welcome(email) {
    let lex = Cache.lex("en");
    const { main_domain } = sysEnv();
    let data = {
      heading: lex._your_account_is_all_set,
      message: lex._mail_signup_drumee,
      workspace: lex._discover_drumee_desk,
      home: `https://${main_domain}/-/`,
      signature: lex._drumee_team,
      reminder: lex._copyright.format(`${new Date().getFullYear()}`),
      hello: email
    }
    let tpl = resolve(__dirname, "./templates/welcome.html");
    const msg = new Messenger({
      subject: lex._welcome_on_drumee,
      recipient: email,
      handler: this.exception.email,
      hello: email
    });

    let html = msg.renderFrom(tpl, data)
    await msg.send({ html });
  }
  /**
   * Mint a verification token and email the verify link.
   */
  async _send_verification_email(_uid, _email) {
    try {
      const { token } = await this.yp.await_proc("drumate_set_verification_token", _uid, _email) || {};
      if (!token) {
        this.warn("[_send_verification_email] no token minted for", _email);
        return 0;
      }
      const homepath = this.input.homepath();
      const verify_url = `${homepath}#/welcome/verify?token=${encodeURIComponent(token)}`;
      // NOTE: Cache.lex() returns the key name itself for keys missing from the
      // lexicon, so `lex._x || "fallback"` keeps the raw key. These verification
      // strings aren't in the lexicon, so use literal copy here.
      const data = {
        heading: "Verify Your Email Address",
        subheading: "Thank you for registering with Drumee",
        hello: `Hello ${_email},`,
        intro: "Welcome to Drumee! We're excited to have you onboard. To complete your registration and access our services, please verify your email address by clicking the button below.",
        button_label: "Verify Email Address",
        verify_url,
        fallback_label: "Or copy and paste this link into your browser:",
        security_title: "Security Note",
        security_note: "This verification link will expire in 24 hours. For your security, please do not share this email with anyone.",
      };
      const msg = new Messenger({
        subject: "Verify your Drumee email address",
        recipient: _email,
        handler: this.exception.email,
      });
      const tpl = resolve(__dirname, "./templates/verify-email.html");
      const html = msg.renderFrom(tpl, data);
      await msg.send({ html });
      return 1;
    } catch (e) {
      this.warn("[_send_verification_email] failed", e);
      return 0;
    }
  }

  /**
   * Verify a signup email from the link token. Public/anonymous.
   */
  async verify_email() {
    const token = this.input.need(Attr.token);
    const res = await this.yp.await_proc("drumate_verify_email_token", token) || {};
    this.output.data({ verified: res.verified === 1 ? 1 : 0 });
  }

  /**
   * Re-mint the verification token and re-send the link. Public/anonymous.
   */
  async resend_verification() {
    // Prefer the email passed by the client (the "Check your inbox" screen
    // knows it); fall back to the pre-signup signup_data row by session.
    // The session lookup can miss once create_account has signed the user in,
    // so the explicit email is the reliable source.
    let email = this.input.get(Attr.email);
    if (!email) {
      const sessionId = this.input.sid();
      const sql = `SELECT email FROM ${this.app_db}.signup_data WHERE session_id=?`;
      const row = await this.db.await_query(sql, sessionId) || {};
      email = row.email;
    }
    if (!email) {
      return this.output.data({ status: "no_pending_signup" });
    }
    const user = await this.yp.await_proc("drumate_exists", email);
    if (!user || !user.id) {
      return this.output.data({ status: "no_account", email });
    }
    const sent = await this._send_verification_email(user.id, email);
    this.output.data({ status: sent ? "ok" : "send_failed", sent, email });
  }

  /**
   *
   */
  async create_account() {
    const email = this.input.need(Attr.email);
    const password = this.input.need(Attr.password);
    let user = await this.yp.await_proc("drumate_exists", email);
    if (user && user.email) {
      return this.output.data({ status: "user_exists", email });
    }
    let data = await this.db.await_proc(`${this.app_db}.get_signup_info`, { email }) || {};
    let args = { email, password };
    if (data.user && data.user.email && data.firstname) {
      args = { ...data.user, password }
    }
    let status = await super.create_account(args)
    let res = await this.session.signin({ uid: email, email, password });
    res.status = "ok";
    if (res.user && res.user.firstname) {
      status.completed = 1
    } else {
      status.completed = 0
    }
    this.user.set(res.user);
    this.uid = res.user.id;
    await this.make_default_folers(res.user)
    // let hub = await this.createHub({
    //   filename: uniqueNamesGenerator(hubNameConfig),
    //   owner_id: res.user.id,
    //   domain: res.user.domain,
    //   area: Attr.private,
    //   user_db: res.user.db_name
    // });
    // await this.make_default_folers(hub)
    // hub = await this.createHub({
    //   filename: uniqueNamesGenerator(hubNameConfig),
    //   owner_id: res.user.id,
    //   domain: res.user.domain,
    //   area: Attr.share,
    //   user_db: res.user.db_name
    // });
    // await this.make_default_folers(hub)
    await this.setWallpaper(this.uid)
    await this._send_verification_email(this.uid, email)

    // Resolve pending hub invitations (from hub.add_contributors before account existed)
    try {
      await this._resolve_pending_invitation(email);
    } catch (e) {
      this.warn('[create_account] Failed to resolve pending_invitation for', email, e && e.message);
    }

    this.output.data(res);
  }

  /**
   * Resolve pending hub invitations từ hub.add_contributors (email được invite trước khi đăng ký).
   * Add user vào các hub và xóa khỏi pending_invitation.
   * Logic tham khảo adminpanel.js: join_hub + permission_grant (user db) + permission_grant (hub db).
   * @param {string} email - email user vừa đăng ký
   */
  async _resolve_pending_invitation(email) {
    let newUser = await this.yp.await_proc("drumate_exists", email);
    if (isArray(newUser)) newUser = newUser[0];
    if (isEmpty(newUser) || !newUser.id) {
      this.warn("[_resolve_pending_invitation] Cannot find user for", email);
      return;
    }

    const userEntity = await this.yp.await_proc("get_entity", newUser.id);
    const userDbName = userEntity && userEntity.db_name;
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
}

module.exports = Signup;