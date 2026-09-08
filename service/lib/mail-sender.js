// service/lib/mail-sender.js
// The address user-facing Drumee mail is sent FROM, and the RFC 5322 mailbox
// built from it.
//
// RELATIONSHIP TO server-team's service/lib/mail-sender.js. The two files are
// NO LONGER identical, and an earlier version of this header said they were.
// What must not drift is the sender identity — MAIL_SENDER_NAME,
// MAIL_SENDER_ADDRESS and mailbox() are the shared part, and a change to any
// of them belongs in both repos. Everything below that is local to this one:
// sendAs(), supportText() and legalFooterText() have no counterpart there,
// because server-team has no sendAs() caller (it uses butlerFrom()/mailbox()
// with its own senders). Do not copy them across to "resynchronise" the files;
// they would be dead code there.
//
// Pinned here rather than read from credential/email.json — which is what the
// butlerSender() copy in lib/loby.js used to do. That file holds the transport's
// SMTP *login*: an unmonitored `butler@<domain>` mailbox. Deriving the public
// From from it meant the two could never differ, so a reprovisioned credential
// silently rewrote who user-facing mail appeared to come from. The login is
// unaffected — the transport still authenticates as whatever email.json says.
//
// It also gives verify-email and signup-completed a From at all: both called
// Messenger.send({ html }) with no `from`, falling through to the package's
// module-level FROM (also email.json's auth.user), so they arrived as a bare
// address with no display name while the OTP mail beside them showed "Drumee".
//
// DEPLOYMENT REQUIREMENT, not satisfied by this file. Verified against live
// DNS on 2026-08-11:
//
//   SPF     "v=spf1 a mx ~all" — resolves to Firebase hosting (199.36.158.100)
//           and Google's MX. The relay that actually connects to the receiving
//           MX is mail.drumee.com (135.125.104.154) and is in neither, so SPF
//           softfails. Needs `a:mail.drumee.com`.
//   DMARC   published TWICE at _dmarc.drumee.org (p=none and p=quarantine).
//           Per RFC 7489 6.6.3 a multi-record set makes receivers apply no
//           DMARC processing at all, so the policy is not merely weak, it is
//           absent. Exactly one record must remain.
//   DKIM    mail._domainkey.drumee.org now publishes a valid 2048-bit RSA key
//           (modulus SHA256 fdb42636c2c92cd9…), distinct from drumee.com's.
//           Whether the relay HOLDS the matching private key and signs
//           d=drumee.org s=mail is NOT verifiable from the application side —
//           mail.drumee.com refuses ssh here. Do not read the presence of the
//           DNS record as proof that signing happens.
//
// Signing is the relay's job in this architecture: the app hands a finished
// message to mail.drumee.com over SMTP submission and the milter signs it.
// Nothing in this file can fix the above. Until it is fixed, everything sent
// from this address is unauthenticated mail — and these templates are 2FA
// codes and email verification, where landing in spam locks a user out of
// signing in.
const MAIL_SENDER_NAME = "Drumee";
const MAIL_SENDER_ADDRESS = "contact@drumee.org";

/**
 * Build an RFC 5322 mailbox, accepting EITHER a bare address or a mailbox that
 * already carries its own angle brackets.
 *
 * This exists because of a real bug. Sending modules used to format their From
 * by hand as `"Drumee" <${sender}>`, which is correct only if `sender` is a bare
 * address. Hand it a full mailbox and the brackets nest:
 *
 *   `"Drumee" <"Drumee" <contact@drumee.org>>`
 *      -> parsers report { name: "Drumee>", address: "contact@drumee.org" }
 *
 * The address still resolves, so the mail is delivered and nothing is logged —
 * the closing bracket is silently absorbed into the display name and every
 * recipient sees "Drumee>". Since butlerFrom() returns a full mailbox while
 * credential-derived senders are bare addresses, the two shapes are one
 * keystroke apart at any call site, so the wrapping is centralised here where
 * it can only happen once.
 *
 * Kept identical to server-team's service/lib/mail-sender.js.
 *
 * @param {String} name    display name; quotes are escaped, never passed raw
 * @param {String} address bare address, or a mailbox like `X <a@b>`
 * @returns {String} e.g. `"Drumee" <contact@drumee.org>`
 * @throws {Error} if no address can be recovered — a broken From is worse than
 *                 a loud failure, because it delivers and looks fine in logs
 */
function mailbox(name, address) {
  const raw = String(address == null ? "" : address).trim();
  // The innermost <...> pair is the address; a value with no pair is already
  // bare, and any loose bracket on it is stripped rather than re-emitted.
  const angled = raw.match(/<([^<>]*)>/);
  const addr = (angled ? angled[1] : raw.replace(/[<>]/g, "")).trim();
  if (!addr) {
    throw new Error(`mail-sender: cannot build a From, no address in ${JSON.stringify(address)}`);
  }
  // A bare quote in the phrase would terminate it early and turn the rest of
  // the header into stray tokens — the same class of break as the nested `>`.
  const phrase = String(name == null ? "" : name).replace(/[\\"]/g, "\\$&");
  return `"${phrase}" <${addr}>`;
}

/**
 * The From header for user-facing mail, display name included.
 *
 * The name is what an inbox actually shows; without it the mail arrives as a
 * bare address no recipient recognises.
 *
 * @returns {String} RFC 5322 mailbox, e.g. `"Drumee" <contact@drumee.org>`
 */
function butlerFrom() {
  return mailbox(MAIL_SENDER_NAME, MAIL_SENDER_ADDRESS);
}

/**
 * Send an already-rendered message with OUR From header, bypassing
 * Messenger.send().
 *
 * Messenger.send() cannot be trusted with a From. This package is pinned at
 * `^1.2.29`, and 1.2.29's send() does:
 *
 *   let from = args.from || `butler@${domain}`;
 *   try { from = configs.auth.user; } catch (e) {}   // `configs` is not in
 *                                                    // scope here, so this
 *                                                    // always throws and the
 *                                                    // caller's value stands
 *   ...
 *   from: `Drumee <${from}>`                         // wraps it a SECOND time
 *
 * Given a full mailbox that yields `Drumee <"Drumee" <contact@drumee.org>>`,
 * which parsers read as { name: "Drumee>", address: "contact@drumee.org" } and
 * every inbox renders as "Drumee>". The address still resolves, so the mail is
 * delivered and nothing is logged. That is the 2026-08-04 bug.
 *
 * Passing a bare address instead would paper over it only while 1.2.x is
 * installed: the caret range also admits 1.3.x, whose send() passes `from`
 * through untouched, and there the bare address would arrive with no display
 * name at all. Driving the transport directly is correct under both, and is the
 * same approach analytics-server's _deliver() already takes.
 *
 * The transport is module-cached inside the package, so it is deliberately NOT
 * closed here — closing it would break every later send in the process.
 *
 * `text` is OPTIONAL and additive. Supplied, nodemailer emits
 * `multipart/alternative` with a `text/plain` part ahead of the `text/html`
 * one; omitted, the message is byte-for-byte what it was before, so the
 * callers that have not been given plain-text copy yet are unaffected.
 *
 * It is worth supplying. Nodemailer does NOT synthesise a text part — with
 * `html` alone the message goes out as a lone `text/html` body, which is a
 * long-standing spam heuristic. The key is `text`, not `html`, because
 * receivers score the message, not the markup.
 *
 * The plain-text body is deliberately NOT derived by stripping tags here.
 * These templates are nested layout tables whose text nodes are spacer
 * `&nbsp;` and icon alt text as often as they are prose; a mechanical strip
 * yields something no recipient would read. Call sites hand-write the text
 * from the same data they hand the template.
 *
 * @param {Messenger} msg configured Messenger (used only for its transport)
 * @param {{to:String, subject:String, html:String, text:String=}} parts
 * @returns {Promise<Number>} 1 sent, 0 not sent (no MTA configured)
 */
async function sendAs(msg, { to, subject, html, text }) {
  const mta = await msg.getMTA(); // sync in 1.2.29, async in 1.3.x; await covers both
  if (!mta) return 0;
  try {
    const message = { from: butlerFrom(), to, subject, html };
    // Only set the key when there is copy to put in it. `text: undefined` is
    // harmless in current nodemailer, but an empty string is not — it would
    // build a multipart/alternative whose text/plain part is blank, which is
    // worse than having no text part at all.
    if (text) message.text = text;
    await mta.sendMail(message);
    return 1;
  } finally {
    // What send() does at the end of its run; we replace send(), so we owe it.
    if (typeof msg.stop === "function") msg.stop();
  }
}

/**
 * The "Need Help?" block and footer every user-facing template ends with,
 * rendered for the `text/plain` part.
 *
 * Lives here so the two halves of one message cannot drift: the support
 * address in the HTML footer is the same brand mailbox this module already
 * pins as the From, so it is built from that constant rather than retyped.
 *
 * @returns {String} trailing block, no leading blank line
 */
function supportText() {
  return [
    "Need help?",
    "Our customer support team is available to assist you:",
    `  Email: ${MAIL_SENDER_ADDRESS}`,
    "  Hours: Monday - Friday, 9:00 AM - 6:00 PM EST",
    "",
    `(c) ${new Date().getFullYear()} Drumee. All rights reserved.`,
    "https://drumee.org  |  Privacy Policy: https://drumee.com/privacy/",
  ].join("\n");
}

/**
 * The footer otp.html ends with, rendered for the `text/plain` part.
 *
 * Separate from supportText() because the OTP template's footer genuinely is
 * a different one — Privacy / Terms / Support links under a "DRUMEE WORKSPACE"
 * rule, with no "Need Help?" block. Reusing supportText() there would put a
 * support address and opening hours in the text part of a message whose HTML
 * part shows neither, and the two alternatives of one message should say the
 * same thing.
 *
 * @returns {String} trailing block, no leading blank line
 */
function legalFooterText() {
  return [
    "Privacy Policy: https://drumee.com/privacy/",
    "Terms of Service: https://drumee.com/terms/",
    "Support: https://drumee.com/about",
    "",
    "DRUMEE WORKSPACE",
    `(c) ${new Date().getFullYear()} Drumee. All rights reserved.`,
  ].join("\n");
}

module.exports = {
  MAIL_SENDER_NAME,
  MAIL_SENDER_ADDRESS,
  mailbox,
  butlerFrom,
  sendAs,
  supportText,
  legalFooterText,
};
