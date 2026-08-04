// service/lib/mail-sender.js
// The address user-facing Drumee mail is sent FROM, and the RFC 5322 mailbox
// built from it. Mirrors server-team's service/lib/mail-sender.js — the two
// repos send from the same brand address and must not drift.
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
// DEPLOYMENT REQUIREMENT, not satisfied by this file. drumee.org is not the
// domain the relay's DKIM key signs (d=drumee.com), and its SPF record
// ("v=spf1 a mx ~all") lists only Firebase hosting and Google's MX — not the
// relay. Its DMARC is published twice (p=none and p=quarantine), which per
// RFC 7489 makes receivers discard the set entirely. Until drumee.org publishes
// an SPF entry for the relay and its own DKIM selector, everything sent from
// this address is unauthenticated mail — and these templates are 2FA codes and
// email verification, where landing in spam locks a user out of signing in.
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
 * @param {Messenger} msg configured Messenger (used only for its transport)
 * @param {{to:String, subject:String, html:String}} parts
 * @returns {Promise<Number>} 1 sent, 0 not sent (no MTA configured)
 */
async function sendAs(msg, { to, subject, html }) {
  const mta = await msg.getMTA(); // sync in 1.2.29, async in 1.3.x; await covers both
  if (!mta) return 0;
  try {
    await mta.sendMail({ from: butlerFrom(), to, subject, html });
    return 1;
  } finally {
    // What send() does at the end of its run; we replace send(), so we owe it.
    if (typeof msg.stop === "function") msg.stop();
  }
}

module.exports = { MAIL_SENDER_NAME, MAIL_SENDER_ADDRESS, mailbox, butlerFrom, sendAs };
