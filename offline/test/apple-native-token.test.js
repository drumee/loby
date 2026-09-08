#!/usr/bin/env node

/**
 * Verification of a native Sign in with Apple identity token.
 *
 * WHY THIS EXISTS. iOS hands the app a token audienced to the APP BUNDLE ID,
 * with a nonce the server minted beforehand; the web flow's token is audienced
 * to the Services ID and carries no nonce. lib/apple-token.js checks both the
 * same way, so every rejection the plan names is pinned here against tokens
 * signed with a local RSA key standing in for Apple's JWKS.
 *
 * Standalone runner (no test framework in this repo): `node <thisfile>`.
 */

const assert = require("assert");
const { generateKeyPairSync, createHash } = require("crypto");
const { readFileSync } = require("fs");
const { join } = require("path");
const jwt = require("jsonwebtoken");

const ROOT = join(__dirname, "../..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const {
  APPLE_ISSUER, NONCE_SHAPE, appleBool, nonceDigest, verifyAppleIdentityToken,
} = require("../../service/lib/apple-token");

let failures = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log("  ok   " + name))
    .catch((e) => { failures++; console.log("  FAIL " + name + "\n         " + e.message); });
}

// ── a stand-in for Apple's JWKS ────────────────────────────────────────
const apple = generateKeyPairSync("rsa", { modulusLength: 2048 });
const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-kid";
const getSigningKey = async (kid) => {
  if (kid !== KID) throw new Error("unknown kid");
  return { getPublicKey: () => apple.publicKey.export({ type: "spki", format: "pem" }) };
};

const BUNDLE = "com.drumee.app.stage";
const SERVICE = "com.drumee.web";
const NONCE = "0123456789abcdef0123456789abcdef";
const NOW = 1_800_000_000;

function sign(claims, { key = apple.privateKey, kid = KID } = {}) {
  const payload = {
    iss: APPLE_ISSUER, aud: BUNDLE, sub: "001234.abcdef", iat: NOW - 10, exp: NOW + 600,
    email: "relay@privaterelay.appleid.com", email_verified: "true", is_private_email: "true",
    nonce: nonceDigest(NONCE), ...claims,
  };
  // `claim: undefined` means "omit the claim", which jsonwebtoken refuses to
  // sign for exp; strip those so the token really lacks it.
  for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];
  return jwt.sign(payload, key.export({ type: "pkcs8", format: "pem" }), {
    algorithm: "RS256", keyid: kid, noTimestamp: true,
  });
}

const verify = (token, over = {}) =>
  verifyAppleIdentityToken(token, { getSigningKey, audience: BUNDLE, nonce: NONCE, now: NOW, ...over });

async function rejects(promise, code) {
  try { await promise; } catch (e) { assert.strictEqual(e.code, code, `got ${e.code}: ${e.message}`); return; }
  assert.fail(`accepted; expected ${code}`);
}

(async () => {
  await test("a valid native token verifies and is normalised", async () => {
    const v = await verify(sign({}));
    assert.strictEqual(v.sub, "001234.abcdef");
    assert.strictEqual(v.email, "relay@privaterelay.appleid.com");
    assert.strictEqual(v.is_private_email, 1);
  });

  await test("booleans and their string forms read alike", async () => {
    const v = await verify(sign({ email_verified: true, is_private_email: false }));
    assert.strictEqual(v.is_private_email, 0);
    assert.strictEqual(appleBool("false"), false);
    assert.strictEqual(appleBool(undefined), false);
  });

  await test("a token without email still verifies (the caller falls back by sub)", async () => {
    const v = await verify(sign({ email: undefined }));
    assert.strictEqual(v.email, null);
  });

  await test("the web audience (Services ID) is refused on the native path, and vice versa", async () => {
    await rejects(verify(sign({ aud: SERVICE })), "invalid_token");
    await rejects(verifyAppleIdentityToken(sign({}), { getSigningKey, audience: SERVICE, now: NOW }), "invalid_token");
  });

  await test("another deployment's bundle id is refused", async () => {
    await rejects(verify(sign({ aud: "com.drumee.app.prelive" })), "invalid_token");
  });

  await test("an audience LIST that merely contains ours is refused", async () => {
    // jsonwebtoken would accept this; Apple mints one audience and so do we.
    await rejects(verify(sign({ aud: [BUNDLE, "com.evil.app"] })), "invalid_token");
  });

  await test("wrong issuer, expiry (present or absent) and a stranger's key are refused", async () => {
    await rejects(verify(sign({ iss: "https://accounts.google.com" })), "invalid_token");
    await rejects(verify(sign({ exp: NOW - 1 })), "invalid_token");
    await rejects(verify(sign({ exp: undefined })), "invalid_token");
    await rejects(verify(sign({}, { key: stranger.privateKey })), "invalid_token");
  });

  await test("an unknown key id or an unreachable key set is key_unavailable, not a bad token", async () => {
    await rejects(verify(sign({}, { kid: "other" })), "key_unavailable");
    await rejects(verify(sign({}), { getSigningKey: async () => { throw new Error("Apple JWKS timeout"); } }),
      "key_unavailable");
  });

  await test("a non-string email claim reads as absent", async () => {
    const v = await verify(sign({ email: { evil: 1 } }));
    assert.strictEqual(v.email, null);
  });

  await test("a nonce mismatch is its own rejection", async () => {
    await rejects(verify(sign({ nonce: nonceDigest("f".repeat(32)) })), "invalid_nonce");
    // The raw nonce in the claim is not the digest.
    await rejects(verify(sign({ nonce: NONCE })), "invalid_nonce");
    await rejects(verify(sign({}), { nonce: "short" }), "invalid_nonce");
  });

  await test("the web flow passes no nonce and is not asked for one", async () => {
    const v = await verifyAppleIdentityToken(sign({ aud: SERVICE, nonce: undefined }), {
      getSigningKey, audience: SERVICE, now: NOW,
    });
    assert.strictEqual(v.sub, "001234.abcdef");
  });

  await test("an unverified email and a missing subject are refused", async () => {
    await rejects(verify(sign({ email_verified: "false" })), "email_unverified");
    await rejects(verify(sign({ sub: undefined })), "invalid_token");
  });

  await test("no audience configured reads as credentials_missing; garbage is not a JWT", async () => {
    await rejects(verifyAppleIdentityToken(sign({}), { getSigningKey, audience: "" }), "credentials_missing");
    await rejects(verify("not.a.jwt.at.all"), "invalid_token");
    await rejects(verify(""), "invalid_token");
  });

  await test("the nonce digest is SHA-256 hex of the raw value", () => {
    assert.strictEqual(nonceDigest(NONCE), createHash("sha256").update(NONCE).digest("hex"));
    assert.ok(NONCE_SHAPE.test(NONCE));
  });

  // ── the service wires it the way the plan says ──────────────────────
  await test("native_signin verifies against ONE bundle id and spends the nonce after verifying", () => {
    const src = read("service/apple.js");
    assert.ok(/audience: APPLECREDS\.bundle_id,\s*nonce,/.test(src), "native path does not pin the bundle id + nonce");
    assert.ok(!/bundle_ids/.test(src), "an audience LIST is back — one deployment, one audience");
    const verifyAt = src.indexOf("await verifyAppleIdentityToken(identityToken");
    const consumeAt = src.indexOf("await this._consumeNonce(nonce, sid)");
    assert.ok(verifyAt > 0 && consumeAt > verifyAt, "the nonce is spent before the token verified");
    assert.ok(/state = \? AND session_id = \? AND ctime > UNIX_TIMESTAMP\(\) - \?/.test(src),
      "the nonce row is not bound to the caller's session");
    assert.ok(/DELETE FROM oauth_state WHERE state = \? AND session_id = \?/.test(src),
      "the nonce delete is not scoped to the session");
    assert.ok(/ins\.affectedRows !== 1/.test(src), "native_nonce does not check that the row was stored");
    const nonceFn = /async native_nonce\(\) \{([\s\S]*?)\n  \}/.exec(src)[1];
    assert.ok(!/sweepOauthTables/.test(nonceFn), "native_nonce sweeps on an anonymous mint path");
  });

  await test("the web verifier delegates to the same function with the Services ID", () => {
    const src = read("service/apple.js");
    assert.ok(/_verifyAppleIdToken\(id_token, audience = APPLECREDS\.service_id\)/.test(src));
    assert.ok(!/jwt\.verify\(/.test(src), "apple.js verifies tokens inline again — two verifiers to keep in sync");
  });

  await test("initiate guards on a field, not on the frozen object", () => {
    assert.ok(/if \(!APPLECREDS\.service_id\) \{\s*return this\.output\.data\(\{ status: 'error', error: 'credentials_missing' \}\)/.test(read("service/apple.js")));
  });

  await test("the two native services are exposed anonymously like their siblings", () => {
    const acl = JSON.parse(read("acl/apple.json"));
    for (const svc of ["native_nonce", "native_signin"]) {
      assert.deepStrictEqual(acl.services[svc].permission, { src: "anonymous", fast_check: "public-api" }, svc);
      assert.strictEqual(acl.services[svc].scope, "hub");
    }
  });

  console.log(failures ? `\n${failures} failed\n` : "\nall passed\n");
  process.exit(failures ? 1 : 0);
})();
