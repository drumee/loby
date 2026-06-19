# Sign in with Apple — email handling & relay deliverability

## TL;DR

When a user picks **"Hide My Email"** at the Apple consent screen, Apple gives us a
relay address like `fjv6h2n7rf@privaterelay.appleid.com` instead of their real
address. **There is no way to recover the real address** — the relay address *is*
the deliverable one, and Apple forwards it to the user's real inbox.

Mail to a relay address is delivered **only if the sending address is registered
with Apple**. If it isn't, Apple **silently drops** the message. That is why mail
"sometimes works" (users who chose *Share My Email* → real address, delivers
normally) and "sometimes doesn't" (users who chose *Hide My Email* → relay, dropped
when the sender isn't registered).

## What the user chooses, and what we receive

| User's choice at Apple consent | `payload.email` we get | `is_private_email` |
|---|---|---|
| **Share My Email** | real address (e.g. `name@gmail.com`) | `false` |
| **Hide My Email** | `<random>@privaterelay.appleid.com` | `true` |

The choice is made **per Apple ID + per app (Service ID)** and persists. It only
changes if the user revokes the app under **Settings → Apple ID → Sign-In &
Security → Apps Using Apple ID** and signs in again. Doing so keeps the same `sub`
(provider_user_id) but may issue a **new** relay address — the old one stops
forwarding.

## Required Apple configuration to make relay mail deliver

This is the actual fix for "OTP / notification email never arrives" for hidden-email
users. Do it once in the Apple Developer portal:

1. Go to **Certificates, Identifiers & Profiles → Identifiers**.
2. Open the **Services ID** used for Sign in with Apple (matches
   `apple/info.json → service_id`, used as `client_id` in
   [apple.js](apple.js)).
3. Open **Sign in with Apple → Configure** (or the **"Sign in with Apple for Email
   Communication"** section, depending on portal layout).
4. Under **Email Sources**, register:
   - **Domain(s)** — the sending domain of the envelope `From` (the domain of
     `email.json → auth.user`). Complete Apple's SPF/domain verification.
   - **Individual email address(es)** — the exact `From` address we send with.
     Our outbound `From` is built in [lib/loby.js](lib/loby.js) `butlerSender()`
     as `"Drumee" <auth.user>` (from `credential_dir/email.json`). The
     `auth.user` address (and the `2FA OTP` sender) must be listed here.
5. Save and wait for Apple to verify the domain (SPF). Until verified, relay
   forwarding stays blocked.

> Make sure SPF for the sending domain authorizes Apple's relay to forward on its
> behalf, per Apple's instructions shown during domain registration.

## What the code does (for reference)

- [apple.js](apple.js) `_getAppleProfile()` reads `payload.is_private_email`
  (Apple sends it as the string `"true"`/`"false"`), normalizes it to `1`/`0`, and
  passes it on the profile.
- [lib/loby.js](lib/loby.js) stores it in `oauth_accounts.is_private_email` on
  signup.
- `session_login_with_oauth` (yellow_page schema) keys sign-in by the Apple `sub`
  (`provider_user_id`), so repeat logins always resolve the same account
  regardless of the email. It derives the relay flag from the address suffix
  (`@privaterelay.appleid.com`) rather than a parameter, so its signature is
  unchanged. On each sign-in it refreshes `oauth_accounts.email`, and
  — **only for relay accounts whose stored login email is itself a
  `@privaterelay.appleid.com` address** — migrates the login email to Apple's
  current relay so OTP keeps delivering after a revoke + re-grant rotation.

## What this does NOT (and cannot) fix

- Converting a relay address back to the user's real address. Impossible by design;
  Apple never discloses it for hidden-email users.
- Auto-merging a hidden-email Apple sign-in with a pre-existing account created
  under a *different* (real) email. We have no shared identifier to link them
  (the Apple `sub` is new, the relay email matches nothing), so a new account is
  created — this is expected, not a bug.
