#!/usr/bin/env node

/**
 * The mobile hand-off for the browser OAuth flow.
 *
 * WHY THIS EXISTS. A mobile client cannot receive the web landing page: the
 * provider redirect ends inside a system auth sheet that only closes when it
 * is sent to the app's own URL scheme. So the callback has to know WHICH
 * client started the flow without a database row (the row may be gone exactly
 * when an error must be reported), WHERE to send it, and WHAT the URL may
 * carry. lib/oauth-mobile.js decides all three; these cases pin them.
 *
 * Also pinned: the shape of the callback code in google.js / apple.js that
 * makes the decision reachable from every exit, and the escaping of the web
 * error template, which is the only template sendOauthError renders.
 *
 * Standalone runner (no test framework in this repo): `node <thisfile>`.
 */

const assert = require("assert");
const { readFileSync } = require("fs");
const { join } = require("path");
const { template } = require("lodash");

const ROOT = join(__dirname, "../..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const {
  MOBILE_CLIENTS, RETURN_ERRORS, HANDOFF_TTL,
  normaliseClient, oauthStateFor, clientFromState, statePrefixFor,
  mobileReturnUrl, mintHandoffCode, claimDecision,
} = require("../../service/lib/oauth-mobile");

let failures = 0;
function test(name, fn) {
  try { fn(); console.log("  ok   " + name); }
  catch (e) { failures++; console.log("  FAIL " + name + "\n         " + e.message); }
}

// ── which client ───────────────────────────────────────────────────────
test("every whitelisted client maps to a drumee-<env> scheme", () => {
  for (const [client, scheme] of Object.entries(MOBILE_CLIENTS)) {
    assert.ok(/^mobile-[a-z]+$/.test(client), `${client} is not mobile-<env>`);
    assert.strictEqual(scheme, `drumee-${client.slice("mobile-".length)}`);
  }
});

test("normaliseClient accepts the whitelist and nothing else", () => {
  assert.strictEqual(normaliseClient("mobile-stage"), "mobile-stage");
  assert.strictEqual(normaliseClient(" Mobile-Test "), "mobile-test");
  for (const bad of ["mobile", "mobile-prod", "web", "", null, undefined, 1, "drumee-stage"]) {
    assert.strictEqual(normaliseClient(bad), null, `accepted ${JSON.stringify(bad)}`);
  }
});

test("a mobile state carries the client as a suffix and stays under the column", () => {
  const s = oauthStateFor("g", "mobile-prelive");
  assert.ok(/^g_[0-9a-f-]{36}~mobile-prelive$/.test(s), s);
  assert.ok(s.length <= 64, "oauth_state.state is VARCHAR(64)");
  assert.strictEqual(clientFromState(s), "mobile-prelive");
});

test("a web state has no suffix and reads as no client", () => {
  const s = oauthStateFor("a", null);
  assert.ok(/^a_[0-9a-f-]{36}$/.test(s), s);
  assert.strictEqual(clientFromState(s), null);
});

test("clientFromState refuses what it did not write", () => {
  for (const bad of [
    "g_not-a-uuid~mobile-stage",
    "g_" + "0".repeat(36) + "~mobile-prod",
    "g_" + "0".repeat(36) + "~mobile-stage~mobile-test",
    "n_" + "0".repeat(32),
    "", null, undefined,
  ]) {
    assert.strictEqual(clientFromState(bad), null, `accepted ${JSON.stringify(bad)}`);
  }
});

test("each provider owns one state prefix", () => {
  assert.strictEqual(statePrefixFor("google"), "g_");
  assert.strictEqual(statePrefixFor("apple"), "a_");
  assert.strictEqual(statePrefixFor("nonce"), null);
});

// ── where it returns to, and what it may carry ─────────────────────────
const CODE = "0123456789abcdef0123456789abcdef";

test("a success URL carries provider and code only", () => {
  assert.strictEqual(
    mobileReturnUrl("mobile-stage", "google", { code: CODE }),
    `drumee-stage://oauth/return?provider=google&code=${CODE}`);
});

test("an error URL carries provider, status and a known error", () => {
  assert.strictEqual(
    mobileReturnUrl("mobile-test", "apple", { error: "access_denied" }),
    "drumee-test://oauth/return?provider=apple&status=error&error=access_denied");
});

test("an unknown error is replaced, never interpolated", () => {
  const url = mobileReturnUrl("mobile-stage", "google", { error: "x');alert(1)//" });
  assert.strictEqual(url, "drumee-stage://oauth/return?provider=google&status=error&error=oauth_failed");
  for (const e of RETURN_ERRORS) {
    assert.ok(/^[a-z_]+$/.test(e), `${e} is not a bare identifier`);
  }
});

test("a malformed code, unknown client or unknown provider throws", () => {
  assert.throws(() => mobileReturnUrl("mobile-stage", "google", { code: "short" }));
  assert.throws(() => mobileReturnUrl("mobile-stage", "google", { code: CODE.toUpperCase() }));
  assert.throws(() => mobileReturnUrl("web", "google", { code: CODE }));
  assert.throws(() => mobileReturnUrl("mobile-stage", "facebook", { code: CODE }));
  // Object.prototype keys are not clients.
  assert.throws(() => mobileReturnUrl("constructor", "google", { code: CODE }));
});

// ── the claim rules, executed ──────────────────────────────────────────
const NOW = 1_800_000_000;
const SID = "s".repeat(32);
const PROFILE = { provider: "google", provider_id: "sub-1", email: "a@b.c" };
const freshRow = (over = {}) => ({
  code: CODE, session_id: SID, provider: "google", profile: PROFILE, ctime: NOW - 5, ...over,
});

test("a fresh row claimed by the initiating session is accepted", () => {
  const d = claimDecision({ code: CODE, sid: SID, row: freshRow(), now: NOW });
  assert.deepStrictEqual(d, { ok: true, profile: PROFILE });
});

test("the parked profile may arrive as a JSON string", () => {
  const d = claimDecision({ code: CODE, sid: SID, row: freshRow({ profile: JSON.stringify(PROFILE) }), now: NOW });
  assert.deepStrictEqual(d, { ok: true, profile: PROFILE });
});

test("another session cannot redeem the code", () => {
  const d = claimDecision({ code: CODE, sid: "t".repeat(32), row: freshRow(), now: NOW });
  assert.deepStrictEqual(d, { error: "session_mismatch" });
});

test("an expired hand-off reads as no code", () => {
  const d = claimDecision({ code: CODE, sid: SID, row: freshRow({ ctime: NOW - HANDOFF_TTL - 1 }), now: NOW });
  assert.deepStrictEqual(d, { error: "invalid_code" });
});

test("no row, no session or a malformed code all read as no code", () => {
  assert.deepStrictEqual(claimDecision({ code: CODE, sid: SID, row: null, now: NOW }), { error: "invalid_code" });
  assert.deepStrictEqual(claimDecision({ code: CODE, sid: SID, row: {}, now: NOW }), { error: "invalid_code" });
  assert.deepStrictEqual(claimDecision({ code: CODE, sid: "", row: freshRow(), now: NOW }), { error: "invalid_code" });
  assert.deepStrictEqual(claimDecision({ code: "nope", sid: SID, row: freshRow(), now: NOW }), { error: "invalid_code" });
  // Session check happens before profile parsing, so a wrong session never
  // learns whether the parked profile is well-formed.
  assert.deepStrictEqual(
    claimDecision({ code: CODE, sid: "t".repeat(32), row: freshRow({ profile: "{" }), now: NOW }),
    { error: "session_mismatch" });
});

test("a parked profile without provider identity is refused", () => {
  for (const profile of ["{", "null", JSON.stringify({ email: "a@b.c" }), JSON.stringify({ provider: "google" })]) {
    const d = claimDecision({ code: CODE, sid: SID, row: freshRow({ profile }), now: NOW });
    assert.deepStrictEqual(d, { error: "unexpected_error" }, `accepted ${profile}`);
  }
});

test("hand-off codes are 32 hex and distinct", () => {
  const a = mintHandoffCode(), b = mintHandoffCode();
  assert.ok(/^[0-9a-f]{32}$/.test(a) && /^[0-9a-f]{32}$/.test(b));
  assert.notStrictEqual(a, b);
});

// ── the callbacks can reach the decision from every exit ───────────────
test("both callbacks resolve the client before the try and use it in the catch", () => {
  for (const f of ["service/google.js", "service/apple.js"]) {
    const src = read(f);
    const cb = /async callback\(\) \{([\s\S]*?)\n  \}\n/.exec(src);
    assert.ok(cb, `${f}: callback not found`);
    const body = cb[1];
    const tryAt = body.indexOf("try {");
    const clientAt = body.indexOf("const client = this.clientFromState(stateParam)");
    assert.ok(clientAt !== -1 && clientAt < tryAt, `${f}: client is not resolved before the try`);
    const catchAt = body.lastIndexOf("} catch (e) {");
    const afterCatch = body.slice(catchAt);
    assert.ok(/sendOauthError\('oauth_failed', client, '(google|apple)'\)/.test(afterCatch),
      `${f}: the catch cannot send a mobile client back to its app`);
    assert.ok(/sendOauthError\('access_denied', client, '(google|apple)'\)/.test(body),
      `${f}: a cancelled consent does not return to the app`);
    assert.ok(/await this\.resolveOAuthState\(stateParam, '(google|apple)'\);\s*return this\.sendOauthError\('access_denied'/.test(body),
      `${f}: a cancelled consent leaves its state row replayable`);
    assert.ok(/await this\.resolveOAuthState\(stateParam, '(google|apple)'\)\.catch\(\(\) => null\);\s*this\.sendOauthError\('oauth_failed'/.test(afterCatch),
      `${f}: a failed exchange leaves its state row replayable`);
  }
});

test("the web initiate path never touches the hand-off table", () => {
  for (const f of ["service/google.js", "service/apple.js"]) {
    assert.ok(/if \(client\) await this\.sweepOauthTables\(\);/.test(read(f)),
      `${f}: the sweep runs for web callers too — a web sign-in now depends on oauth_handoff existing`);
  }
  const oauth = read("service/oauth.js");
  assert.ok(!/sweepOauthTables/.test(oauth), "claim sweeps on an anonymous read path");
});

test("the mobile branch parks and redirects, never signs in", () => {
  for (const f of ["service/google.js", "service/apple.js"]) {
    const src = read(f);
    const branch = /if \(client\) \{([\s\S]*?)\n      \}/.exec(src);
    assert.ok(branch, `${f}: no mobile branch`);
    assert.ok(branch[1].includes("stashOauthHandoff"), `${f}: mobile branch does not park the profile`);
    assert.ok(branch[1].includes("sendMobileReturn"), `${f}: mobile branch does not redirect to the app`);
    assert.ok(!branch[1].includes("handleOAuthCallback") && !branch[1].includes("sendHtml"),
      `${f}: the mobile branch signs in or sets a cookie`);
  }
});

test("the state row is read and deleted in exactly one place", () => {
  const loby = read("service/lib/loby.js");
  assert.strictEqual((loby.match(/FROM oauth_state s WHERE state = \?/g) || []).length, 1);
  assert.strictEqual((loby.match(/DELETE FROM oauth_state WHERE state = \?/g) || []).length, 1);
  assert.ok(/del\.affectedRows !== 1/.test(loby), "the delete is not checked — two callbacks could both win");
});

test("the claim decides through claimDecision and spends the code once", () => {
  const src = read("service/oauth.js");
  assert.ok(/claimDecision\(\{ code, sid, row, now/.test(src), "claim does not use the tested decision");
  assert.ok(/DELETE FROM oauth_handoff WHERE code = \?/.test(src), "claim does not consume the code");
  assert.ok(/del\.affectedRows !== 1/.test(src), "claim does not check the delete");
  assert.ok(/completeOAuthSignin\(profile, \{\s*session_id: sid/.test(src),
    "claim signs in a session other than the caller's");
});

test("resend mints before it prunes, and prunes the right side", () => {
  const src = read("service/oauth.js");
  const mintAt = src.indexOf("await this._send2faOtp(pending.uid, pending.email)");
  const pruneOld = src.indexOf("DELETE FROM otp WHERE uid = ? AND sys_id <= ?");
  const pruneNew = src.indexOf("DELETE FROM otp WHERE uid = ? AND sys_id > ?");
  assert.ok(mintAt > 0 && pruneOld > mintAt && pruneNew > mintAt,
    "a failed send would destroy the code already in the inbox");
});

test("verify_otp counts attempts and drops the sign-in at the limit", () => {
  const src = read("service/oauth.js");
  assert.ok(/pending\.failed >= OTP_MAX_ATTEMPTS/.test(src));
  assert.ok(/too_many_attempts/.test(src));
  assert.ok(/UPDATE cookie SET failed = failed \+ 1 WHERE id = \? AND status = 'otp_pending'/.test(src));
});

// ── the web error template cannot be broken out of ─────────────────────
test("oauth-error does not interpolate its redirect raw", () => {
  const HOSTILE = "https://x/-/#/welcome/signin?oauth_error=a');alert(1);//";
  const html = template(read("service/templates/oauth-error.html"))({ redirect: HOSTILE });
  const line = html.split("\n").find((l) => l.includes("location.replace"));
  assert.ok(line, "the redirect is gone");
  assert.ok(!line.includes("replace('"),
    "the URL is inside a single-quoted literal — one apostrophe reaches script context");
  assert.ok(line.includes('replace("https://x/-/#/welcome/signin?oauth_error=a\');alert(1);//")'));
});

console.log(failures ? `\n${failures} failed\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
