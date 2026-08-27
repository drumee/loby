#!/usr/bin/env node

/**
 * The OAuth destination — the value that survives the bounce to the provider.
 *
 * WHY THIS EXISTS. A campaign CTA names where the visitor is going:
 *
 *   #/desk/billing?plan=team&cycle=monthly&tab=checkout&promo=EMAILMKT270826_2
 *
 * ui-team parks that in sessionStorage before the signin plugin rewrites the
 * hash, which carries an email/password sign-in and not an OAuth one: this
 * callback is server-side, it rebuilds the landing URL from scratch, and a URL
 * fragment is never sent to a server in the first place. So the destination
 * rides on `oauth_state` beside `ref` and utm_*, and comes back out on `home`.
 *
 * TWO THINGS ARE PINNED HERE, and the second is why this file is not optional:
 *
 *   1. _sanitiseDest accepts exactly the destinations the campaign can name and
 *      refuses everything else. It REBUILDS rather than passes through, so a
 *      value can only ever be one this function could have written.
 *
 *   2. The landing templates do not interpolate that URL raw. lib/loby.js uses
 *      LODASH, whose equals-delimiter is the RAW one — the reverse of EJS — so
 *      `location.replace('<the url>')` put request-derived text straight into a
 *      JS string literal on the page that runs immediately after
 *      authentication. Both halves are asserted: the sanitiser refuses quotes,
 *      AND the template escapes. Either alone is one edit away from an XSS.
 *
 * Standalone runner (no test framework in this repo): `node <thisfile>`.
 */

const assert = require("assert");
const { readFileSync } = require("fs");
const { join } = require("path");
const { template } = require("lodash");

const ROOT = join(__dirname, "../..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const LOBY = read("service/lib/loby.js");

let failures = 0;
function test(name, fn) {
  try { fn(); console.log("  ok   " + name); }
  catch (e) { failures++; console.log("  FAIL " + name + "\n         " + e.message); }
}

/**
 * The real _sanitiseDest, lifted and compiled.
 *
 * Out of the source rather than restated here, so these cases cannot pass
 * against a rule the service does not actually apply.
 */
const sanitiseSrc = /_sanitiseDest\(raw\) \{([\s\S]*?)\n  \}/.exec(LOBY);
assert(sanitiseSrc, "_sanitiseDest not found in service/lib/loby.js");
const sanitise = new Function("raw", sanitiseSrc[1]);

const CAMPAIGN_DEST =
  "/desk/billing?plan=team&cycle=monthly&tab=checkout&promo=EMAILMKT270826_2";

// ── what it accepts ────────────────────────────────────────────────────
test("the campaign's own destination survives byte for byte", () => {
  assert.strictEqual(sanitise(CAMPAIGN_DEST), CAMPAIGN_DEST);
});

test("the bare billing path is a destination", () => {
  assert.strictEqual(sanitise("/desk/billing"), "/desk/billing");
});

test("params are rebuilt in a fixed order", () => {
  // Two links meaning the same thing must produce the same string: the value is
  // compared and stored, and an order-dependent one would look like two.
  assert.strictEqual(
    sanitise("/desk/billing?tab=checkout&plan=team"),
    "/desk/billing?plan=team&tab=checkout");
});

test("whitespace around the value is tolerated", () => {
  assert.strictEqual(sanitise(`  ${CAMPAIGN_DEST}  `), CAMPAIGN_DEST);
});

// ── what it refuses ────────────────────────────────────────────────────
const REFUSED = {
  "a foreign path": "/desk/wm/open/123",
  "a path outside the desk": "/welcome/signin",
  "a protocol-relative url": "//evil.example/",
  "an absolute url": "https://evil.example/desk/billing",
  "a quote (the XSS vector)": "/desk/billing?plan=team');alert(1);//",
  "a double quote": '/desk/billing?plan=team"x',
  "a backslash": "/desk/billing?plan=team\\x",
  "an angle bracket": "/desk/billing?plan=<script>",
  "whitespace inside": "/desk/billing?plan=te am",
  "an unknown param": "/desk/billing?plan=team&evil=1",
  "an unknown plan": "/desk/billing?plan=enterprise",
  "an unknown cycle": "/desk/billing?cycle=weekly",
  "a tab that is not checkout": "/desk/billing?tab=admin",
  "a promo with punctuation": "/desk/billing?promo=A.B",
  "an over-long promo": "/desk/billing?promo=" + "A".repeat(80),
  "an over-long value": "/desk/billing?promo=" + "A".repeat(400),
  "the empty string": "",
  "null": null,
  "undefined": undefined,
};
for (const [why, value] of Object.entries(REFUSED)) {
  test(`refuses ${why}`, () => {
    assert.strictEqual(sanitise(value), null);
  });
}

test("an unknown param is refused, not silently dropped", () => {
  // Dropping it would honour half a link written against a contract this code
  // does not have — and guessing which half is how a destination becomes a
  // wrong one rather than an absent one.
  assert.strictEqual(sanitise("/desk/billing?plan=team&seats=5"), null);
});

// ── the outer guards are redundant, and that is the point ──────────────
// Two guards in _sanitiseDest cannot currently decide anything: the
// character check (no quote/backslash/angle/whitespace) and the 255 cap.
// With the path fixed to one literal and every param matched against a
// bounded, alphanumeric regex, nothing that reaches them can fail them —
// removing either changes no verdict, verified by mutation.
//
// They are kept because that redundancy is a property of the CURRENT param
// list, not of the function. The day someone adds a free-text param they
// become the only thing standing between a request and the landing page's
// location.replace(). So what is pinned here is the premise rather than the
// guards: every accepted value is quote-free and bounded by its own regex.
// Add a looser one and this fails, which is the moment to notice the outer
// guards just started doing real work.
test("every accepted param is bounded and quote-free by its own regex", () => {
  const body = /_sanitiseDest\(raw\) \{([\s\S]*?)\n  \}/.exec(LOBY)[1];
  const allow = /const ALLOWED = \{([\s\S]*?)\n    \};/.exec(body);
  assert.ok(allow, "the ALLOWED map is gone — the destination is no longer an allowlist");
  const regexes = [...allow[1].matchAll(/^\s*(\w+):\s*(\/.*\/),?\s*$/gm)];
  assert.ok(regexes.length >= 4, `only ${regexes.length} params are shape-checked`);
  for (const [, key, src] of regexes) {
    assert.ok(/^\/\^/.test(src) && /\$\/$/.test(src),
      `${key} is not anchored — it would match a substring of a hostile value`);
    assert.ok(!/[.*+]\)?\$?\/$|\\w|\\S|\[\^/.test(src.replace(/\{1,\d+\}/, "")),
      `${key} accepts an open-ended or negated class — the outer character and `
      + "length guards in _sanitiseDest are now load-bearing, and untested");
  }
  // And the longest thing the function can emit is far under the column width.
  const longest = sanitise(
    "/desk/billing?plan=business&cycle=monthly&tab=checkout&promo=" + "A".repeat(64));
  assert.ok(longest && longest.length < 255,
    "an accepted destination can now approach the column width — the cap has "
    + "stopped being belt-and-braces and needs its own case");
});

// ── the ladder that keeps sign-in working ──────────────────────────────
test("initiate degrades one column-group at a time", () => {
  // A database without `dest` must still keep the campaign, and one without
  // utm_* must still keep the referral. Falling straight to the bare row would
  // discard attribution the instance can perfectly well store.
  for (const f of ["service/google.js", "service/apple.js"]) {
    const src = read(f);
    const tiers = (src.match(/INSERT IGNORE INTO oauth_state/g) || []).length;
    assert.strictEqual(tiers, 4,
      `${f} no longer has four INSERT tiers — a missing column would cost more `
      + "than the column, or would stop a visitor signing in");
    assert.ok(/oauth_state \(state, session_id, ref, utm_source, utm_medium, utm_campaign, utm_content, dest, ctime\)/.test(src),
      `${f} does not write dest on its top tier`);
    assert.ok(src.includes("this._destFromInput()"),
      `${f} never reads the destination from the request`);
  }
});

// ── both ends validate ─────────────────────────────────────────────────
test("the destination is validated on the way in AND on the way out", () => {
  // The row is data. The code that builds the template's input is the code that
  // has to have checked it.
  assert.ok(/_destFromInput\(\) \{\s*return this\._sanitiseDest\(this\.input\.get\("dest"\)\);/.test(LOBY),
    "_destFromInput no longer sanitises at capture");
  assert.ok(/dest = this\._sanitiseDest\(dest\)/.test(LOBY),
    "handleOAuthCallback returns the row's dest unvalidated");
  for (const f of ["service/google.js", "service/apple.js"]) {
    assert.ok(/const dest = this\._sanitiseDest\(res\.dest\)/.test(read(f)),
      `${f} puts the destination on the landing URL without re-validating it`);
  }
});

test("all three successful callback exits carry it", () => {
  // signin, signup and 2FA. Missing one means the feature works for some users
  // and silently not for others — the hardest kind of bug to be told about.
  const exits = (LOBY.match(/dest: this\._sanitiseDest\(dest\)|\.dest = this\._sanitiseDest\(dest\)/g) || []);
  assert.strictEqual(exits.length, 3,
    `${exits.length} of 3 callback exits carry a destination`);
  for (const f of ["service/google.js", "service/apple.js"]) {
    assert.ok(read(f).includes("&dest=${encodeURIComponent(res.dest)}"),
      `${f} drops the destination on the 2FA path`);
  }
});

test("home gains a fragment only when a destination survived", () => {
  for (const f of ["service/google.js", "service/apple.js"]) {
    assert.ok(/home = `https:\/\/\$\{res\.domain\}\$\{endpoint_path\}\/\$\{dest \? `#\$\{dest\}` : ''\}`/.test(read(f)),
      `${f}'s landing URL is not conditional on a surviving destination`);
  }
});

// ── the templates cannot be broken out of ──────────────────────────────
const HOSTILE = "https://x/-/#/desk/billing?promo=A');alert(1);//";

test("account-created does not interpolate the landing URL raw", () => {
  const html = template(read("service/templates/account-created.html"))(
    { home: HOSTILE, auto_redirect: 1, is_new: 0, email: "a@b.c" });
  const line = html.split("\n").find((l) => l.includes("location.replace"));
  assert.ok(line, "the redirect is gone");
  assert.ok(!line.includes("replace('"),
    "the URL is back inside a single-quoted literal — one apostrophe reaches script context");
  assert.ok(line.includes('replace("https://x/-/#/desk/billing?promo=A\');alert(1);//")'),
    "the hostile URL is not contained by the quoting");
});

test("the new-account CTA escapes its href", () => {
  const html = template(read("service/templates/account-created.html"))(
    { home: HOSTILE, auto_redirect: 0, is_new: 1, email: "a@b.c" });
  const line = html.split("\n").find((l) => l.includes("goto-desk"));
  assert.ok(line.includes("&#39;") || !line.includes("');"),
    "the CTA href is unescaped — an attribute is as escapable as a string literal");
});

test("otp-challenge does not interpolate its redirect raw", () => {
  const html = template(read("service/templates/otp-challenge.html"))({ redirect: HOSTILE });
  const line = html.split("\n").find((l) => l.includes("location.replace"));
  assert.ok(!line.includes("replace('"),
    "the 2FA redirect is back inside a single-quoted literal");
});

console.log(failures ? `\n${failures} failed\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
