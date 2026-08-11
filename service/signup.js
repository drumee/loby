// service/signup.js

const { Cache, Attr, sysEnv, Messenger, uniqueId } = require('@drumee/server-essentials');
const { toArray } = require('@drumee/server-essentials').utils;
const { resolve } = require('path');
const { isEmpty, isArray } = require('lodash');
const Loby = require("./lib/loby")
const { sendAs, supportText } = require("./lib/mail-sender");
const { uniqueNamesGenerator, colors, animals, adjectives } = require('unique-names-generator');
const { randomBytes } = require('crypto');

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
      // 256 bits from a CSPRNG. v1 minted the token in SQL as sha2(uuid(),224),
      // but MariaDB's UUID() is version 1 -- timestamp + clock_seq + MAC -- and
      // sha2 adds no entropy, so a single token disclosed every field except a
      // narrow time_low (measured on prod: two consecutive tokens 164 ticks
      // apart, everything else identical). resend_verification even let the
      // caller choose when that timestamp happened. Must be unguessable before
      // this link is ever allowed to establish a session.
      const secret = randomBytes(32).toString("hex");
      const { token } = await this.yp.await_proc("drumate_set_verification_token_v2", _uid, _email, secret) || {};
      if (!token) {
        this.warn("[_send_verification_email] no token minted for", _email);
        return 0;
      }
      const homepath = this.input.homepath();
      const verify_url = `${homepath}#/welcome/verify?token=${encodeURIComponent(token)}`;
      // NOTE: Cache.lex() returns the key name itself for keys missing from the
      // lexicon, so `lex._x || "fallback"` keeps the raw key. These verification
      // strings aren't in the lexicon, so use literal copy here.
      //
      // One sentence with two endings: the HTML part has a button to click, the
      // plain-text part has a URL to open, and telling a text reader to click a
      // button that isn't there is how a mechanically-derived text body reads.
      const intro_lead = "Welcome to Drumee! We're excited to have you onboard. To complete your registration and access our services, please verify your email address";
      const data = {
        heading: "Verify Your Email Address",
        subheading: "Thank you for registering with Drumee",
        hello: `Hello ${_email},`,
        intro: `${intro_lead} by clicking the button below.`,
        button_label: "Verify Email Address",
        verify_url,
        // Anchor text now, not a label above a printed URL — the template
        // stopped rendering the tokenised link as visible body copy.
        fallback_label: "Trouble with the button? Use this verification link instead.",
        security_title: "Security Note",
        security_note: "This verification link will expire in 24 hours. For your security, please do not share this email with anyone.",
      };
      const subject = "Verify your Drumee email address";
      const msg = new Messenger({
        subject,
        recipient: _email,
        handler: this.exception.email,
      });
      const tpl = resolve(__dirname, "./templates/verify-email.html");
      const html = msg.renderFrom(tpl, data);
      // Written from `data`, not stripped out of the rendered HTML, so the two
      // parts say the same thing without the layout tables' spacer cells and
      // icon alt text landing in the plain-text body. This is also the ONE
      // place the full tokenised URL is shown as text: a plain-text reader has
      // no anchor to follow, so the link has to be copyable here.
      const text = [
        data.heading,
        "",
        data.hello,
        "",
        `${intro_lead} by opening the link below.`,
        "",
        `${data.button_label}: ${verify_url}`,
        "",
        `${data.security_title}: ${data.security_note}`,
        "",
        supportText(),
      ].join("\n");
      // sendAs, not msg.send: the pinned Messenger re-wraps the From and turns
      // a full mailbox into a "Drumee>" display name. See lib/mail-sender.
      return await sendAs(msg, { to: _email, subject, html, text });
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
    // Capture the account email BEFORE the proc consumes the verification row
    // (drumate_verify_email_token deletes the token on success, so it can't be
    // resolved afterwards). The client carries this email to send_welcome.
    let row = await this.yp.await_query(
      "SELECT IFNULL(d.unverified_email, JSON_VALUE(d.profile, '$.email')) AS email " +
      "FROM verification v INNER JOIN drumate d ON d.id = v.drumate_id WHERE v.token = ? LIMIT 1",
      token
    );
    if (isArray(row)) row = row[0];
    row = row || {};
    // v2 also binds THIS session to the account, so clicking the link in the
    // signup mail lands the user inside the app instead of bouncing them to a
    // second sign-in. The token check and the entity.status check both live
    // inside the procedure, so this call cannot be used to log in as an
    // arbitrary account, and a frozen/archived/locked account is verified but
    // never signed in. Verification is unconditional and happens first: if the
    // bind does not happen, signed_in comes back 0 and the client falls back to
    // exactly today's behaviour (confirmation screen, then sign in).
    const res = await this.yp.await_proc(
      "drumate_verify_email_token_v2", token, this.input.sid()
    ) || {};
    const verified = res.verified === 1 ? 1 : 0;
    // Prefer the procedure's post-update address (authoritative); keep the
    // pre-captured one as a fallback so the welcome mail can never lose its
    // recipient.
    this.output.data({
      verified,
      signed_in: verified && res.signed_in === 1 ? 1 : 0,
      email: verified ? (res.email || row.email || "") : "",
    });
  }

  /**
   * Render + send the "account all set" welcome email (signup-completed.html).
   */
  async _send_signup_completed_email(_email) {
    try {
      const homepath = this.input.homepath();
      const home = `${homepath}#/desk`;
      const subject = "Your Drumee account is all set";
      const msg = new Messenger({
        subject,
        recipient: _email,
        handler: this.exception.email,
      });
      const tpl = resolve(__dirname, "./templates/signup-completed.html");
      const html = msg.renderFrom(tpl, { home, email: _email });
      // Mirrors the template's own order, greeting included, and drops the
      // greeting line on the same condition the template does — send_welcome
      // can reach here with no address resolved.
      const text = [
        "Your Drumee account is all set! Thanks for joining us.",
        "",
        ...(_email ? [`Hello ${_email},`, ""] : []),
        "A quick note to confirm your account has been successfully created.",
        "",
        "Thank you so much for your interest in Drumee - we're excited to let you discover it.",
        "",
        "We're glad to have you!",
        "",
        `Discover your Drumee desk here: ${home}`,
        "",
        "The Drumee team",
        "",
        supportText(),
      ].join("\n");
      return await sendAs(msg, { to: _email, subject, html, text });
    } catch (e) {
      this.warn("[_send_signup_completed_email] failed", e);
      return 0;
    }
  }

  /**
   * Send the welcome ("all set") email. Public/anonymous — fired by the
   * "Back to Drumee" button on the email-confirmed screen.
   */
  async send_welcome() {
    const email = this.input.get(Attr.email);
    if (!email) {
      return this.output.data({ status: "no_email" });
    }
    const sent = await this._send_signup_completed_email(email);
    this.output.data({ status: sent ? "ok" : "send_failed", sent });
  }

  /**
   * Report whether the account for an email has verified its address.
   * Public/anonymous — polled by the "Check your inbox" screen so it can move
   * the user on to sign-in once they click the link (often on another device).
   */
  async check_verification() {
    const email = this.input.get(Attr.email);
    if (!email) {
      return this.output.data({ verified: 0 });
    }
    const user = await this.yp.await_proc("drumate_exists", email);
    if (!user || !user.id) {
      return this.output.data({ verified: 0 });
    }
    let row = await this.yp.await_query(
      "SELECT registration_verified AS rv FROM drumate WHERE id=? LIMIT 1", user.id
    );
    if (isArray(row)) row = row[0];
    row = row || {};
    this.output.data({ verified: row.rv == 1 ? 1 : 0 });
  }

  /**
   * Re-mint the verification token and re-send the link. Public/anonymous.
   */
  async resend_verification() {
    // Resolve the target account using the strongest signal available:
    //   1. an explicit email — the "Check your inbox" screen carries it.
    //   2. a verify token (even an expired one) — the failed-verify screen has
    //      it but not the email. The verification row survives until the link
    //      is successfully used, so token -> drumate_id -> staged
    //      unverified_email still resolves.
    //   3. the pre-signup signup_data row keyed by session (best-effort; there
    //      is no session once we stopped auto-login, so this rarely hits).
    let email = this.input.get(Attr.email);
    let uid = null;

    if (!email) {
      const token = this.input.get(Attr.token);
      if (token) {
        let row = await this.yp.await_query(
          "SELECT d.id AS id, d.unverified_email AS email " +
          "FROM verification v INNER JOIN drumate d ON d.id = v.drumate_id " +
          "WHERE v.token = ? LIMIT 1", token
        );
        if (isArray(row)) row = row[0];
        row = row || {};
        uid = row.id || null;
        email = row.email;
      }
    }

    if (!email) {
      const sessionId = this.input.sid();
      const sql = `SELECT email FROM ${this.app_db}.signup_data WHERE session_id=?`;
      let row = await this.db.await_query(sql, sessionId) || {};
      if (isArray(row)) row = row[0] || {};
      email = row.email;
    }

    if (!email) {
      return this.output.data({ status: "no_pending_signup" });
    }

    if (!uid) {
      const user = await this.yp.await_proc("drumate_exists", email);
      if (!user || !user.id) {
        return this.output.data({ status: "no_account", email });
      }
      uid = user.id;
    }

    // Only an account that is ACTUALLY awaiting verification may be re-sent.
    // This endpoint is anonymous and takes an arbitrary address, and
    // _send_verification_email stages unverified_email on whatever account it
    // resolves -- while yp.login refuses any account whose unverified_email is
    // set. Without this guard a stranger could lock ANY user out of password
    // login with a single unauthenticated call, and (before the token was
    // strengthened above) then predict the token that unlocks it.
    //
    // Keyed on the pending column, NOT registration_verified: on production
    // 2342 of 2405 accounts are legacy rv=0 with no pending email and sign in
    // perfectly well, so an rv-based guard would have left almost everyone
    // exploitable. Both legitimate resend paths -- the "check your inbox"
    // screen right after create_account, and the failed-verify screen -- have
    // unverified_email set, so neither is affected.
    let pending = await this.yp.await_query(
      "SELECT unverified_email FROM drumate WHERE id=? LIMIT 1", uid
    );
    if (isArray(pending)) pending = pending[0];
    if (!pending || !pending.unverified_email) {
      // Deliberately the same neutral answer as "nothing to resend", so this
      // cannot be used to probe which addresses have a signup in flight.
      return this.output.data({ status: "no_pending_signup" });
    }

    const sent = await this._send_verification_email(uid, email);
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
    // Referral attribution — the signup UI forwards ?ref=<member> (also from
    // localStorage['drumee_ref']). Thread it into args so super.create_account
    // persists it as profile.$.ref (read by the analytics referrals /
    // signup_sources / users_list procs). Without this, email signups drop ref.
    const ref = (this.input.get("ref") || "").toString().trim().toLowerCase().slice(0, 64);
    // UTM campaign params — the signup UI forwards utm_source/utm_medium/
    // utm_campaign as flat keys. Thread them into args so super.create_account
    // persists profile.utm. Without this, email signups drop UTM attribution.
    const utm = {};
    for (const k of ["utm_source", "utm_medium", "utm_campaign"]) {
      const v = (this.input.get(k) || "").toString().trim().slice(0, 64);
      if (v) utm[k] = v;
    }
    let args = { email, password };
    if (data.user && data.user.email && data.firstname) {
      args = { ...data.user, password }
    }
    if (ref) args.ref = ref;
    if (Object.keys(utm).length) args.utm = utm;
    // Create the account WITHOUT establishing a session (autosignin = 0).
    // The user stays unauthenticated (registration_verified = 0) until they
    // click the email-verification link. Auto-logging in here would let a page
    // refresh escape the signup flow into the authenticated desk/onboarding
    // before the email is ever verified.
    const drumate = await super.create_account(args, 0);
    if (!drumate || drumate.error) {
      return this.output.data({ status: (drumate && drumate.status) || "internal_error", email });
    }
    // drumate carries db_name/home_id; resolve the canonical id for the
    // procs that need it (drumate_create's return may omit it).
    const acct = await this.yp.await_proc("drumate_exists", email) || {};
    const uid = acct.id || drumate.id;

    await this.make_default_folers(drumate)
    await this.setWallpaper(uid)
    await this._send_verification_email(uid, email)

    // Resolve pending hub invitations (from hub.add_contributors before account existed)
    try {
      await this._resolve_pending_invitation(email);
    } catch (e) {
      this.warn('[create_account] Failed to resolve pending_invitation for', email, e && e.message);
    }

    // No session payload — the client shows "Check your inbox" on status: ok.
    this.output.data({ status: "ok", email });
  }

}

module.exports = Signup;