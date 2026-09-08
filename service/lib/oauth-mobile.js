// service/lib/oauth-mobile.js
//
// The mobile hand-off for the browser OAuth flow, as pure functions.
//
// A mobile client cannot receive the web landing page: the provider redirect
// ends inside a system auth sheet that only closes when it is sent to the
// app's own URL scheme. Three things have to be decided without a database
// row, because the row may already be gone (expired, replayed) exactly when an
// error has to be reported: WHICH client started the flow, WHERE it returns
// to, and WHAT the return URL may carry. All three live here, and only here.
//
// The client rides inside the OAuth `state` value as a whitelisted suffix
// (`g_<uuid>~mobile-stage`). `state` already round-trips through the provider
// untouched and is compared only by equality, so the suffix costs nothing and
// needs no column.

const { randomUUID } = require("crypto");

/** Whitelist of mobile clients and the URL scheme each returns to. */
const MOBILE_CLIENTS = Object.freeze({
  "mobile-stage": "drumee-stage",
  "mobile-test": "drumee-test",
  "mobile-prelive": "drumee-prelive",
});

const PROVIDERS = Object.freeze(["google", "apple"]);

/**
 * Every error the return URL may name. A value outside this list is replaced
 * by `oauth_failed`, so the URL is built only from constants the app knows.
 */
const RETURN_ERRORS = Object.freeze([
  "access_denied",
  "oauth_failed",
  "invalid_state",
  "missing_state",
  "invalid_code",
  "credentials_missing",
  "oauth_init_failed",
  "oauth_not_linked",
  "user_exists",
  "account_creation_failed",
  "session_fetch_failed",
  "unexpected_error",
]);

const STATE_RE = /^([ga])_([0-9a-f-]{36})(?:~([a-z-]{1,16}))?$/;

/**
 * Normalise a `client` request param: a whitelisted value or null.
 * @param {*} raw
 * @returns {string|null}
 */
function normaliseClient(raw) {
  const s = raw == null ? "" : String(raw).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(MOBILE_CLIENTS, s) ? s : null;
}

/**
 * Mint an OAuth state for a provider, carrying the client when there is one.
 * @param {"g"|"a"} prefix
 * @param {string|null} client a value normaliseClient accepted
 * @returns {string} at most 53 characters; oauth_state.state is VARCHAR(64)
 */
function oauthStateFor(prefix, client) {
  const base = `${prefix}_${randomUUID()}`;
  return client ? `${base}~${client}` : base;
}

/**
 * Read the client back out of a state value. Syntactic only: no row needed,
 * so it works on the error paths where the row is already gone. A malformed
 * state or an unknown suffix reads as "no mobile client" (web behaviour).
 * @param {*} state
 * @returns {string|null}
 */
function clientFromState(state) {
  const m = STATE_RE.exec(state == null ? "" : String(state));
  if (!m) return null;
  return normaliseClient(m[3]);
}

/**
 * The prefix a provider's states carry, so a nonce or another provider's
 * state cannot be consumed as this one.
 * @param {string} provider
 * @returns {"g_"|"a_"|null}
 */
function statePrefixFor(provider) {
  if (provider === "google") return "g_";
  if (provider === "apple") return "a_";
  return null;
}

/**
 * Build the URL the auth sheet is sent to. Every part comes from a constant
 * or a value this module validated; nothing request-derived is interpolated.
 *
 * Success: `<scheme>://oauth/return?provider=<p>&code=<32 hex>`
 * Failure: `<scheme>://oauth/return?provider=<p>&status=error&error=<enum>`
 *
 * @param {string} client   a whitelisted client
 * @param {string} provider "google" | "apple"
 * @param {{code?: string, error?: string}} params exactly one of the two
 * @returns {string}
 * @throws when the client or provider is not one this module knows
 */
function mobileReturnUrl(client, provider, params = {}) {
  const scheme = normaliseClient(client) ? MOBILE_CLIENTS[client] : null;
  if (!scheme) throw new Error("unknown mobile client");
  if (!PROVIDERS.includes(provider)) throw new Error("unknown provider");
  const q = new URLSearchParams({ provider });
  if (params.code != null) {
    if (!/^[0-9a-f]{32}$/.test(String(params.code))) throw new Error("malformed hand-off code");
    q.set("code", String(params.code));
  } else {
    const error = RETURN_ERRORS.includes(params.error) ? params.error : "oauth_failed";
    q.set("status", "error");
    q.set("error", error);
  }
  return `${scheme}://oauth/return?${q.toString()}`;
}

/** A hand-off code: 32 hex characters from the platform CSPRNG. */
function mintHandoffCode() {
  return randomUUID().replace(/-/g, "");
}

const HANDOFF_CODE_RE = /^[0-9a-f]{32}$/;
/** Seconds a parked hand-off may wait for the app to redeem it. */
const HANDOFF_TTL = 120;

/**
 * Decide whether a claim may proceed. Pure, so the rules that protect the
 * login can be tested without a database:
 *   - the code must be well-formed and the caller must have a session;
 *   - a row must exist and be younger than HANDOFF_TTL;
 *   - the caller's session must be the one that called initiate;
 *   - the parked profile must name a provider and a provider id.
 * The caller still has to DELETE the row and check affectedRows === 1 for
 * single use — that part is the database's decision, not this function's.
 *
 * @param {{code:*, sid:*, row:Object|null, now:number}} input
 * @returns {{error:string}|{ok:true, profile:Object}}
 */
function claimDecision({ code, sid, row, now }) {
  if (!sid || !HANDOFF_CODE_RE.test(String(code || ""))) return { error: "invalid_code" };
  if (!row || !row.code) return { error: "invalid_code" };
  if (!(Number(row.ctime) > now - HANDOFF_TTL)) return { error: "invalid_code" };
  if (row.session_id !== sid) return { error: "session_mismatch" };
  let profile = row.profile;
  if (typeof profile === "string") {
    try { profile = JSON.parse(profile); } catch (e) { profile = null; }
  }
  if (!profile || typeof profile !== "object" || !profile.provider || !profile.provider_id) {
    return { error: "unexpected_error" };
  }
  return { ok: true, profile };
}

module.exports = {
  MOBILE_CLIENTS,
  PROVIDERS,
  RETURN_ERRORS,
  HANDOFF_TTL,
  normaliseClient,
  oauthStateFor,
  clientFromState,
  statePrefixFor,
  mobileReturnUrl,
  mintHandoffCode,
  claimDecision,
};
