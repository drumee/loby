// service/oauth.js
//
// 2FA verification for OAuth (Google/Apple) sign-in.
//
// The provider callback (google.callback / apple.callback) leaves the session
// in an 'otp_pending' cookie status and emails a code (see lib/loby.js
// _send2faOtp). The signin app then renders dtk_otp pointed at these services.
// The OTP secret never leaves the server: the client submits only the code, and
// verify_otp resolves the secret from the pending session before finalizing it
// via session_login_otp.

const { Attr, toArray } = require('@drumee/server-essentials');
const Loby = require('./lib/loby');

class OAuth extends Loby {

  /**
   * Resolve the pending OAuth sign-in for the current session.
   * @returns {Promise<{uid:string, email:string}|null>}
   */
  async _pendingUser() {
    const sid = this.input.sid();
    const row = await this.yp.await_query(
      "SELECT c.uid AS uid, d.email AS email FROM cookie c JOIN drumate d ON d.id = c.uid WHERE c.id = ? AND c.status = 'otp_pending' LIMIT 1",
      sid
    ) || {};
    if (!row.uid) return null;
    return { uid: row.uid, email: row.email };
  }

  /**
   * Verify the submitted code against the OTP minted at callback time and, on
   * success, promote the pending cookie to 'ok' (session_login_otp). Returns
   * { status: 'success' } or { status: 'error' } — the shape dtk_otp expects.
   */
  async verify_otp() {
    const sid = this.input.sid();
    const code = this.input.get(Attr.code);
    const pending = await this._pendingUser();
    if (!pending || !code) {
      return this.output.data({ status: 'error' });
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
    this.output.data(r || { status: 'error' });
  }

  /**
   * Re-mint and re-email the OTP for the current pending OAuth sign-in.
   */
  async resend_otp() {
    const pending = await this._pendingUser();
    if (!pending) {
      return this.output.data({ status: 'error' });
    }
    await this._send2faOtp(pending.uid, pending.email);
    this.output.data({ status: 'ok' });
  }

  /**
   * Abandon the pending OAuth 2FA for the current session — the "Back to sign
   * in" action on the signin app's OTP screen. session_logout can't clear this
   * state (it deletes the cookie by uid, which a not-yet-authenticated
   * otp_pending session doesn't have), so the otp_pending cookie would survive
   * and the signin page would keep bouncing to the OTP screen. We therefore
   * delete the pending cookie directly by session id. Best-effort and
   * idempotent: a session with no pending cookie is a no-op.
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
