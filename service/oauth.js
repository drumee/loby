// service/oauth.js
//
// Completion services shared by both OAuth providers (Google/Apple).
//
// `claim` finishes the MOBILE browser flow: the provider callback parked the
// verified profile behind a one-time code (lib/loby.js stashOauthHandoff) and
// sent the auth sheet back to the app; the app redeems the code here over its
// own header session, which must be the session that called initiate.
//
// The 2FA trio finishes a sign-in that session_login_with_oauth left in the
// 'otp_pending' cookie status (web callback or mobile claim alike). The OTP
// secret never leaves the server: the client submits only the code, and
// verify_otp resolves the secret from the pending session before finalizing it
// via session_login_otp.

const { Attr, toArray } = require('@drumee/server-essentials');
const Loby = require('./lib/loby');
const { claimDecision, HANDOFF_TTL } = require('./lib/oauth-mobile');

// Wrong codes tolerated per pending session. cookie.failed already exists and
// is reset to 0 by session_login_otp on success, so it is the counter. A
// resend does not reset it: the limit is per pending sign-in, not per code.
const OTP_MAX_ATTEMPTS = 5;

class OAuth extends Loby {

  /**
   * Resolve the pending OAuth sign-in for the current session.
   * @returns {Promise<{uid:string, email:string, failed:number}|null>}
   */
  async _pendingUser() {
    const sid = this.input.sid();
    const row = await this.yp.await_query(
      "SELECT c.uid AS uid, d.email AS email, c.failed AS failed FROM cookie c JOIN drumate d ON d.id = c.uid WHERE c.id = ? AND c.status = 'otp_pending' LIMIT 1",
      sid
    ) || {};
    if (!row.uid) return null;
    return { uid: row.uid, email: row.email, failed: Number(row.failed) || 0 };
  }

  /**
   * Redeem a mobile hand-off code and sign the caller's session in.
   *
   * Two secrets are required: the code (delivered by the provider redirect to
   * the device that completed consent) and the session id this request
   * carries, which has to be the one that called initiate. A code presented
   * from any other session is refused and left in place for its owner; a code
   * is deleted before use so it can be redeemed once.
   *
   * Answers JSON only: {status:'ok', method} | {status:'otp_required', email}
   * | {status:'error', error}.
   */
  async claim() {
    const sid = this.input.sid();
    const code = String(this.input.get(Attr.code) || '');
    if (!sid || !/^[0-9a-f]{32}$/.test(code)) {
      return this.output.data({ status: 'error', error: 'invalid_code' });
    }
    // No sweep on this read path: the ctime window below already makes an
    // expired row unreadable, and this is an anonymous endpoint.
    const row = await this.yp.await_query(
      "SELECT code, session_id, provider, profile, ctime FROM oauth_handoff WHERE code = ? AND ctime > UNIX_TIMESTAMP() - ? LIMIT 1",
      code, HANDOFF_TTL
    ) || {};
    const decision = claimDecision({ code, sid, row, now: Math.floor(Date.now() / 1000) });
    if (decision.error) {
      if (decision.error === 'session_mismatch') {
        this.warn('[Auth] Hand-off claimed from a session other than the initiator');
      }
      return this.output.data({ status: 'error', error: decision.error });
    }
    const del = await this.yp.await_query("DELETE FROM oauth_handoff WHERE code = ?", code);
    if (!del || del.affectedRows !== 1) {
      return this.output.data({ status: 'error', error: 'invalid_code' });
    }
    const { profile } = decision;
    let res;
    try {
      res = await this.completeOAuthSignin(profile, {
        session_id: sid, ref: profile.ref || '', utm: profile.utm || {}, dest: null,
      });
    } catch (e) {
      this.warn('[Auth] Hand-off completion failed:', e && e.message);
      return this.output.data({ status: 'error', error: 'unexpected_error' });
    }
    if (res && res.status === 'ok') {
      return this.output.data({ status: 'ok', method: res.method || 'signin' });
    }
    if (res && res.status === 'otp_required') {
      return this.output.data({ status: 'otp_required', email: res.email || '' });
    }
    return this.output.data({ status: 'error', error: (res && res.error) || 'unexpected_error' });
  }

  /**
   * Verify the submitted code against the OTP minted at callback time and, on
   * success, promote the pending cookie to 'ok' (session_login_otp). Returns
   * { status: 'success' } or { status: 'error' } — the shape dtk_otp expects.
   *
   * A six-digit code needs an attempt limit: after OTP_MAX_ATTEMPTS wrong
   * codes the pending sign-in is dropped and the user starts over.
   */
  async verify_otp() {
    const sid = this.input.sid();
    const code = this.input.get(Attr.code);
    const pending = await this._pendingUser();
    if (!pending || !code) {
      return this.output.data({ status: 'error' });
    }
    if (pending.failed >= OTP_MAX_ATTEMPTS) {
      await this.yp.await_query(
        "DELETE FROM cookie WHERE id = ? AND status = 'otp_pending'", sid
      );
      return this.output.data({ status: 'error', error: 'too_many_attempts' });
    }
    const { secret } = await this.yp.await_query(
      "SELECT secret FROM otp WHERE uid = ? ORDER BY sys_id DESC LIMIT 1",
      pending.uid
    ) || {};
    if (!secret) {
      return this.output.data({ status: 'error' });
    }
    const r = toArray(
      await this.yp.await_proc('session_login_otp', pending.uid, code, secret, sid)
    )[0];
    // This COMPLETES the OAuth sign-in that the provider callback started. The
    // callback returned at CASE D without logging, correctly -- the cookie was
    // only otp_pending, nobody was signed in yet -- and session_login_otp is a
    // plain proc that writes no services_log row. So unless we log here, an
    // OAuth account with 2FA signs in perfectly and never registers at all.
    if (r && r.status === 'success') {
      await this._logConnection(pending.uid);
    } else {
      await this.yp.await_query(
        "UPDATE cookie SET failed = failed + 1 WHERE id = ? AND status = 'otp_pending'", sid
      );
    }
    this.output.data(r || { status: 'error' });
  }

  /**
   * Re-mint and re-email the OTP for the current pending OAuth sign-in.
   *
   * verify_otp only ever checks the NEWEST otp row for the user, so exactly
   * one code must be live afterwards — but WHICH one depends on whether the
   * mail went out. Mint first; when it was sent, drop the older rows so a
   * late-arriving previous code cannot read as "incorrect"; when it was not,
   * drop the row just minted so the code already in the inbox keeps working.
   * The result is honest: 'error' when nothing was mailed.
   */
  async resend_otp() {
    const pending = await this._pendingUser();
    if (!pending) {
      return this.output.data({ status: 'error' });
    }
    const { latest } = await this.yp.await_query(
      "SELECT IFNULL(MAX(sys_id), 0) AS latest FROM otp WHERE uid = ?", pending.uid
    ) || {};
    const before = Number(latest) || 0;
    const sent = await this._send2faOtp(pending.uid, pending.email);
    if (sent) {
      await this.yp.await_query("DELETE FROM otp WHERE uid = ? AND sys_id <= ?", pending.uid, before);
    } else {
      await this.yp.await_query("DELETE FROM otp WHERE uid = ? AND sys_id > ?", pending.uid, before);
    }
    this.output.data({ status: sent ? 'ok' : 'error' });
  }

  /**
   * Abandon the pending OAuth 2FA for the current session — the "Back to sign
   * in" action on the signin app's OTP screen. session_logout can't clear this
   * state (it deletes the cookie by uid, which a not-yet-authenticated
   * otp_pending session doesn't have), so the otp_pending cookie would survive
   * and the signin page would keep bouncing to the OTP screen. We therefore
   * delete the pending cookie directly by session id. Best-effort and
   * idempotent: a session with no pending cookie is a no-op. The next request
   * on the same session id recreates the row as anonymous (session_check_cookie).
   */
  async cancel_otp() {
    const sid = this.input.sid();
    if (sid) {
      await this.yp.await_query(
        "DELETE FROM cookie WHERE id = ? AND status = 'otp_pending'",
        sid
      );
    }
    this.output.data({ status: 'ok' });
  }
}

module.exports = OAuth;
