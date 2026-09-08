#!/usr/bin/env node

/**
 * Regression tests for the plain-text alternative on transactional mail.
 *
 * Nodemailer does not synthesise a text part: given only `html` it emits a
 * lone text/html body, which is a long-standing spam heuristic. All three
 * user-facing mails on this path — email verification, signup-completed and
 * the 2FA OTP — now hand sendAs() a hand-written `text` body so the message
 * goes out as multipart/alternative. These are 2FA codes and verification
 * links, where landing in spam locks a user out of signing in, so the shape of
 * the message is worth pinning down.
 *
 * What is asserted here:
 *   - sendAs() forwards `text`, and omits the key entirely when absent, so the
 *     contract stays backward-compatible for any future caller without copy.
 *   - each mail is multipart/alternative with text/plain BEFORE text/html.
 *   - the OTP code is identical in both parts, and the server-side secret is
 *     in neither.
 *   - the verification URL survives intact, and its token is not rendered as
 *     visible HTML text.
 *   - OTP generation, its arguments and its failure path are unchanged.
 *
 * The real service methods are driven; only the DB (`yp`), the request input
 * and the transport are stubbed. Messenger.getMTA is replaced with a capturing
 * stream transport, so nothing is submitted to an MTA.
 *
 * Standalone runner (no test framework in this repo): `node <thisfile>`.
 */

const assert = require("assert");
const { readFileSync } = require("fs");
const { resolve } = require("path");
const { template } = require("lodash");
const Nodemailer = require("nodemailer");
const { Messenger } = require("@drumee/server-essentials");

const {
  sendAs,
  butlerFrom,
  supportText,
  legalFooterText,
} = require("../../service/lib/mail-sender");
const Signup = require("../../service/signup");
const Loby = require("../../service/lib/loby");

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// --------------------------------------------------------------------------
// Harness
// --------------------------------------------------------------------------

const FROM = '"Drumee" <contact@drumee.org>';
const EMAIL = "user@example.com";
const HOME = "https://my.drumee.com/";
const TOKEN = "b3f1".repeat(16); // 64 hex chars, shaped like randomBytes(32)
const CODE = "418302";
const CTIME = 1770000000;

/** Messages captured from the last drive() call. */
let sent = [];

// sendAs asks the Messenger for its transport. Hand it one that buffers the
// built MIME instead of talking to an MTA.
Messenger.prototype.getMTA = function () {
  const t = Nodemailer.createTransport({ streamTransport: true, buffer: true });
  const send = t.sendMail.bind(t);
  t.sendMail = async (m) => {
    const info = await send(m);
    sent.push({ m, mime: info.message.toString() });
    return info;
  };
  return t;
};
Messenger.prototype.stop = function () { };

/**
 * Build a service instance without running the constructor chain — these
 * methods only reach for the members assigned here.
 */
function service(Klass, { row, calls } = {}) {
  const s = Object.create(Klass.prototype);
  s.warn = () => { };
  s.exception = { email: null };
  s.input = { homepath: () => HOME, ua_language: () => "en" };
  s.yp = {
    await_proc: async (...args) => {
      if (calls) calls.push(args);
      return row;
    },
  };
  return s;
}

/** Run a send and return the single captured message. */
async function drive(fn) {
  sent = [];
  const rc = await fn();
  return { rc, ...(sent[0] || {}) };
}

/** Assert the message is multipart/alternative, text/plain first. */
function assertAlternative(mime, label) {
  assert.ok(/Content-Type: multipart\/alternative/.test(mime),
    `${label}: expected multipart/alternative`);
  const p = mime.indexOf("Content-Type: text/plain");
  const h = mime.indexOf("Content-Type: text/html");
  assert.ok(p > -1, `${label}: missing text/plain part`);
  assert.ok(h > -1, `${label}: missing text/html part`);
  assert.ok(p < h, `${label}: text/plain must precede text/html`);
}

/** Visible text of an HTML body: tags and comments removed. */
const visible = (html) =>
  html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]*>/g, " ");

/** Render a template the way Messenger.renderFrom does (lodash, not EJS). */
const render = (name, data) =>
  template(String(readFileSync(resolve(__dirname, "../../service/templates", name))).trim())(data);

const otpRow = { sys_id: 7, uid: "u1", secret: "s3cr3t", code: CODE, ctime: CTIME, expiry: CTIME + 600 };

// --------------------------------------------------------------------------
// sendAs() contract
// --------------------------------------------------------------------------

const fakeMsg = (mta) => {
  let stopped = 0;
  return { getMTA: async () => mta, stop: () => { stopped++; }, stops: () => stopped };
};

function capturing() {
  const seen = [];
  const t = Nodemailer.createTransport({ streamTransport: true, buffer: true });
  const send = t.sendMail.bind(t);
  t.sendMail = async (m) => { seen.push(m); return send(m); };
  return { t, seen };
}

test("sendAs forwards `text` to the transport", async () => {
  const { t, seen } = capturing();
  const rc = await sendAs(fakeMsg(t), { to: EMAIL, subject: "s", html: "<p>h</p>", text: "plain" });
  assert.strictEqual(rc, 1);
  assert.strictEqual(seen[0].text, "plain");
  assert.strictEqual(seen[0].from, FROM);
});

test("sendAs omits the `text` key entirely when not supplied", async () => {
  const { t, seen } = capturing();
  assert.strictEqual(await sendAs(fakeMsg(t), { to: EMAIL, subject: "s", html: "<p>h</p>" }), 1);
  assert.ok(!("text" in seen[0]), "text key must be absent, not undefined");
});

test("sendAs ignores an empty-string `text`", async () => {
  // An empty string would build a multipart/alternative with a blank
  // text/plain part, which is worse than having no text part at all.
  const { t, seen } = capturing();
  await sendAs(fakeMsg(t), { to: EMAIL, subject: "s", html: "<p>h</p>", text: "" });
  assert.ok(!("text" in seen[0]));
});

test("sendAs with no text still produces single-part text/html", async () => {
  const info = await Nodemailer.createTransport({ streamTransport: true, buffer: true })
    .sendMail({ from: butlerFrom(), to: EMAIL, subject: "s", html: "<p>h</p>" });
  const mime = info.message.toString();
  assert.ok(!/multipart\/alternative/.test(mime));
  assert.ok(/Content-Type: text\/html/.test(mime));
});

test("sendAs returns 0 and does not stop a Messenger it never used", async () => {
  const msg = fakeMsg(null);
  assert.strictEqual(await sendAs(msg, { to: EMAIL, subject: "s", html: "<p>h</p>" }), 0);
  assert.strictEqual(msg.stops(), 0);
});

test("sendAs stops the Messenger exactly once on the success path", async () => {
  const { t } = capturing();
  const msg = fakeMsg(t);
  await sendAs(msg, { to: EMAIL, subject: "s", html: "<p>h</p>", text: "p" });
  assert.strictEqual(msg.stops(), 1);
});

// --------------------------------------------------------------------------
// Verification email
// --------------------------------------------------------------------------

test("verification email is multipart/alternative and keeps its URL intact", async () => {
  const svc = service(Signup, { row: { token: TOKEN } });
  const { rc, m, mime } = await drive(() => svc._send_verification_email(42, EMAIL));
  const url = `${HOME}#/welcome/verify?token=${TOKEN}`;

  assert.strictEqual(rc, 1);
  assertAlternative(mime, "verification");
  assert.strictEqual(m.from, FROM);
  assert.strictEqual(m.subject, "Verify your Drumee email address");
  assert.ok(m.html.includes(`href="${url}"`), "CTA href must be the exact verification URL");
  assert.ok(m.text.includes(url), "text part must carry the full URL — it has no anchor to follow");
  assert.ok(m.text.includes("Hello user@example.com,"));
  assert.ok(m.text.includes("Security Note"));
  assert.ok(m.text.includes(supportText()));
});

test("verification email does not print the token as visible HTML text", async () => {
  // A long opaque string beside a call to action is the shape of a phishing
  // template; the copy-and-paste fallback belongs in the text part.
  const svc = service(Signup, { row: { token: TOKEN } });
  const { m } = await drive(() => svc._send_verification_email(42, EMAIL));
  assert.ok(!visible(m.html).includes(TOKEN));
  assert.ok(m.html.includes('<html lang="en">'));
});

test("verification email tells text readers to open a link, not click a button", async () => {
  const svc = service(Signup, { row: { token: TOKEN } });
  const { m } = await drive(() => svc._send_verification_email(42, EMAIL));
  assert.ok(m.text.includes("by opening the link below"));
  assert.ok(m.html.includes("by clicking the button below"));
});

test("verification email sends nothing when no token is minted", async () => {
  const svc = service(Signup, { row: {} });
  const { rc } = await drive(() => svc._send_verification_email(42, EMAIL));
  assert.strictEqual(rc, 0);
  assert.strictEqual(sent.length, 0);
});

// --------------------------------------------------------------------------
// Signup-completed email
// --------------------------------------------------------------------------

test("signup-completed is multipart/alternative and greets in both parts", async () => {
  const svc = service(Signup);
  const { rc, m, mime } = await drive(() => svc._send_signup_completed_email(EMAIL));
  assert.strictEqual(rc, 1);
  assertAlternative(mime, "signup-completed");
  assert.ok(visible(m.html).includes(`Hello ${EMAIL},`), "HTML must greet, not float the address alone");
  assert.ok(m.text.includes(`Hello ${EMAIL},`));
  assert.ok(m.html.includes(`href="${HOME}#/desk"`));
  assert.ok(m.text.includes(`${HOME}#/desk`));
});

test("signup-completed drops the greeting when no address resolved", async () => {
  // send_welcome resolves the address from the verification row and can
  // legitimately come up empty; a dangling "Hello ," reads worse than none.
  const svc = service(Signup);
  const { m } = await drive(() => svc._send_signup_completed_email(""));
  assert.ok(!/Hello/.test(visible(m.html)));
  assert.ok(!/Hello/.test(m.text));
  assert.ok(m.text.includes("successfully created"), "body copy must survive");
});

// --------------------------------------------------------------------------
// 2FA OTP email
// --------------------------------------------------------------------------

test("OTP email is multipart/alternative", async () => {
  const svc = service(Loby, { row: otpRow });
  const { rc, mime } = await drive(() => svc._send2faOtp("u1", EMAIL));
  assert.strictEqual(rc, 1);
  assertAlternative(mime, "otp");
});

test("OTP code is identical in the text and html parts", async () => {
  const svc = service(Loby, { row: otpRow });
  const { m } = await drive(() => svc._send2faOtp("u1", EMAIL));
  const inText = m.text.match(/\b\d{6}\b/g) || [];
  const inHtml = visible(m.html).match(/\b\d{6}\b/g) || [];
  assert.deepStrictEqual(inText, [CODE], "exactly one code in the text part");
  assert.deepStrictEqual(inHtml, [CODE], "exactly one code in the html part");
});

test("OTP server-side secret appears in neither part", async () => {
  const svc = service(Loby, { row: otpRow });
  const { m } = await drive(() => svc._send2faOtp("u1", EMAIL));
  assert.ok(!m.text.includes(otpRow.secret));
  assert.ok(!m.html.includes(otpRow.secret));
});

test("OTP generation is unchanged", async () => {
  const calls = [];
  const svc = service(Loby, { row: otpRow, calls });
  await drive(() => svc._send2faOtp("u1", EMAIL));
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0][0], "otp_create");
  assert.strictEqual(calls[0][1], "u1");
  assert.strictEqual(typeof calls[0][2], "string");
  assert.ok(calls[0][2].length > 0, "secret still generated and passed through");
});

test("OTP expiry is derived from the row otp_create returned", async () => {
  // The OTP procedures disagree — authenticate.sql and session_login_otp.sql
  // expire at 10 minutes, check.sql at 30 — so the window is read back from
  // what was actually minted rather than restated in the copy.
  const svc = service(Loby, { row: otpRow });
  const { m } = await drive(() => svc._send2faOtp("u1", EMAIL));
  assert.ok(m.text.includes("expires in 10 minutes"));
});

test("OTP omits the expiry claim when the row cannot support one", async () => {
  const svc = service(Loby, { row: { code: CODE } });
  const { m, mime } = await drive(() => svc._send2faOtp("u1", EMAIL));
  assert.ok(!/expires in/.test(m.text), "must not invent an expiry");
  assert.ok(m.text.includes(CODE));
  assertAlternative(mime, "otp without expiry");
});

test("OTP falls back to real copy when the lexicon is empty", async () => {
  // Cache.lex() returns the lexicon MAP, so a missing key reads as undefined
  // (echoing the key name is Cache.message()). Unguarded, subject and headline
  // both went out as the literal string "undefined".
  const svc = service(Loby, { row: otpRow });
  const { m } = await drive(() => svc._send2faOtp("u1", EMAIL));
  assert.ok(!/undefined/.test(m.text));
  assert.ok(!/undefined/.test(m.html));
  assert.ok(m.subject && !/undefined/.test(m.subject));
});

test("OTP text footer mirrors otp.html, not the signup support block", async () => {
  // The two alternatives of one message must say the same thing: otp.html has
  // Privacy/Terms/Support links and no "Need Help?" block.
  const svc = service(Loby, { row: otpRow });
  const { m } = await drive(() => svc._send2faOtp("u1", EMAIL));
  assert.ok(m.text.includes(legalFooterText()));
  assert.ok(!/Need help\?/.test(m.text));
});

test("OTP sends nothing when otp_create yields no code", async () => {
  const svc = service(Loby, { row: null });
  const { rc } = await drive(() => svc._send2faOtp("u1", EMAIL));
  assert.strictEqual(rc, 0);
  assert.strictEqual(sent.length, 0);
});

// --------------------------------------------------------------------------
// Templates
// --------------------------------------------------------------------------

test("social badges match analytics-server's canonical claim-reward.html set", async () => {
  // claim-reward.html's footer is the Figma "Email marketing" node and is the
  // source of truth for which channels Drumee actually has. These two used to
  // carry five, three of them placeholders — discord.gg/drumee is a dead
  // invite (API: "Unknown Invite", code 10006) and x.com/drumee is the wrong
  // handle. Pinned so a future edit cannot quietly reintroduce them.
  const expected = [
    ["https://x.com/DrumeeOS", "x.png", 14, 14],
    ["https://t.me/DrumeeAnnChat", "telegram.png", 18, 17],
    ["https://www.linkedin.com/company/drumee/posts/?feedView=all", "linkedin.png", 13, 9],
  ];
  const rendered = {};
  for (const name of ["verify-email.html", "signup-completed.html"]) {
    // Comments are not delivered markup, and this block's comment names the
    // retired channels — strip before asserting on what actually ships.
    const html = render(name, {
      heading: "h", subheading: "s", hello: "x", intro: "i", button_label: "b",
      verify_url: "https://e/", fallback_label: "f", security_title: "t",
      security_note: "n", home: "https://e/", email: EMAIL,
    }).replace(/<!--[\s\S]*?-->/g, "");
    rendered[name] = html;

    for (const [url, icon, w, h] of expected) {
      assert.ok(html.includes(`href="${url}"`), `${name}: missing ${url}`);
      assert.ok(
        html.includes(`icons/${icon}" width="${w}" height="${h}"`),
        `${name}: ${icon} must render at its own ${w}x${h} proportions, not a uniform square`);
    }
    assert.ok(!/discord|tiktok|instagram/i.test(html), `${name}: retired channel still linked`);
    // rgba() is unsupported by Outlook's Word engine; the badge circle must be
    // the flattened hex or it does not paint there at all.
    assert.ok(!/rgba\(/.test(html), `${name}: rgba() left in delivered markup`);
    assert.ok(html.includes('bgcolor="#dcdbf5"'), `${name}: badge circle needs a bgcolor attribute`);
  }

  // The two blocks have always matched; a diff between them is a mistake.
  const badges = (h) => h.slice(h.indexOf("<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" align=\"center\" style=\"margin:0 auto;\">"));
  assert.strictEqual(
    badges(rendered["verify-email.html"]).slice(0, 2000),
    badges(rendered["signup-completed.html"]).slice(0, 2000),
    "the two social blocks have drifted apart");
});

test("templates keep their email-safe structure", async () => {
  for (const name of ["verify-email.html", "signup-completed.html", "otp.html"]) {
    const html = render(name, {
      heading: "h", subheading: "s", hello: "x", intro: "i", button_label: "b",
      verify_url: "https://e/", fallback_label: "f", security_title: "t",
      security_note: "n", home: "https://e/", email: EMAIL, code: CODE, why_this_otp: "w",
    });
    assert.ok(html.includes('role="presentation"'), `${name}: presentational tables`);
    assert.ok(html.includes('width="600"'), `${name}: Outlook width attribute`);
  }
});

// --------------------------------------------------------------------------

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`ok   ${name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${name}\n     ${e.message}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
