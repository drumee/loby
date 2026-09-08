// service/lib/apple-token.js
//
// Verification of an Apple identity token, as a pure function.
//
// Two flows hand Apple tokens to this plugin. The web flow exchanges an
// authorization code and receives a token audienced to the SERVICES ID; the
// native iOS flow (ASAuthorizationController) hands the app a token audienced
// to the APP BUNDLE ID, together with a nonce the app asked for beforehand.
// The checks are the same either way — signature against Apple's JWKS,
// issuer, audience, expiry, verified email — plus the nonce when one is
// expected. Keeping them here, away from the service class and the JWKS
// client, is what makes every rejection case testable with a locally signed
// token.

const { createHash } = require("crypto");
const jwt = require("jsonwebtoken");

const APPLE_ISSUER = "https://appleid.apple.com";
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const NONCE_SHAPE = /^[0-9a-f]{32}$/;

/**
 * Apple sends `email_verified` and `is_private_email` as the strings "true"
 * / "false" on most tokens and as booleans on some. Read both alike.
 * @param {*} v
 * @returns {boolean}
 */
function appleBool(v) {
  return v === true || v === "true";
}

/**
 * The nonce claim Apple embeds is the SHA-256 (hex) of the raw nonce the app
 * passed to the request — the RN library hashes before sending, so the server
 * compares against the digest of the value it minted.
 * @param {string} rawNonce
 */
function nonceDigest(rawNonce) {
  return createHash("sha256").update(String(rawNonce)).digest("hex");
}

/**
 * Verify an Apple identity token and return its normalised payload.
 *
 * @param {string} idToken
 * @param {{
 *   getSigningKey: (kid: string) => Promise<{getPublicKey(): string}>,
 *   audience: string,
 *   nonce?: string,
 *   now?: number,
 * }} opt  `audience` is exactly one client id (Services ID for the web flow,
 *         bundle id for the native flow); `nonce` is the RAW nonce the server
 *         minted, required for native tokens.
 * @returns {Promise<{sub:string, email:string|null, is_private_email:0|1, payload:Object}>}
 * @throws {Error} with `code` ∈ {invalid_token, email_unverified, invalid_nonce, credentials_missing, key_unavailable}
 */
async function verifyAppleIdentityToken(idToken, opt) {
  const { getSigningKey, audience, nonce } = opt || {};
  if (!audience) throw tokenError("credentials_missing", "no audience configured");
  if (typeof getSigningKey !== "function") throw tokenError("invalid_token", "no key resolver");
  if (!JWT_SHAPE.test(String(idToken || ""))) throw tokenError("invalid_token", "not a JWT");

  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded || !decoded.header || !decoded.header.kid) {
    throw tokenError("invalid_token", "no key id");
  }
  let key;
  try {
    key = await getSigningKey(decoded.header.kid);
  } catch (e) {
    // Not a property of the token: Apple's key set could not be fetched (or
    // has no such kid). Kept distinct so an Apple outage is not logged and
    // reported as a bad credential; the original message travels with it.
    throw tokenError("key_unavailable", e && e.message);
  }
  const publicKey = key && typeof key.getPublicKey === "function" ? key.getPublicKey() : key;

  let payload;
  try {
    payload = jwt.verify(idToken, publicKey, {
      algorithms: ["RS256"],
      audience,
      issuer: APPLE_ISSUER,
      ...(opt && opt.now ? { clockTimestamp: opt.now } : {}),
    });
  } catch (e) {
    throw tokenError("invalid_token", e && e.message);
  }

  // jsonwebtoken accepts an `aud` ARRAY that merely contains the audience, and
  // only checks `exp` when the claim is present. Both are required here to be
  // exactly what Apple mints: one audience, and an expiry.
  if (payload.aud !== audience) throw tokenError("invalid_token", "audience mismatch");
  if (!payload.exp) throw tokenError("invalid_token", "no expiry");

  if (nonce !== undefined) {
    if (!NONCE_SHAPE.test(String(nonce || "")) || payload.nonce !== nonceDigest(nonce)) {
      throw tokenError("invalid_nonce", "nonce mismatch");
    }
  }
  if (!payload.sub) throw tokenError("invalid_token", "no subject");
  if (!appleBool(payload.email_verified)) throw tokenError("email_unverified", "email not verified");

  return {
    sub: String(payload.sub),
    email: typeof payload.email === "string" && payload.email ? payload.email : null,
    is_private_email: appleBool(payload.is_private_email) ? 1 : 0,
    payload,
  };
}

function tokenError(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

module.exports = {
  APPLE_ISSUER,
  NONCE_SHAPE,
  appleBool,
  nonceDigest,
  verifyAppleIdentityToken,
};
