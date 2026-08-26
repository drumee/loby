# Drumee Loby

The entry-door services for [Drumee](https://drumee.com): everything that
happens before a user reaches their workspace — sign-up, sign-in, OAuth,
invitations and plan selection.

## What it provides

| Service | ACL | Handles |
|---|---|---|
| `signup` | `acl/signup.json` | Account creation |
| `oauth` | `acl/oauth.json` | The OAuth flow |
| `google` | `acl/google.json` | Sign in with Google |
| `apple` | `acl/apple.json` | Sign in with Apple |
| `invite` | `acl/invite.json` | Invitations |
| `onboarding` | `acl/onboarding.json` | The onboarding sequence |
| `plan` | `acl/plan.json` | Plan selection |

Transactional email templates live in `service/templates/` and `emailing/`.
Database objects this plugin owns are under `schemas/` — `tables/`,
`procedures/`, `patches/` and `migrations/`.

## Running it

This is a Drumee server plugin: it runs inside a Drumee server runtime.

```console
npm install
npm run register-plugin
npm run dev
npm run deploy
npm run remove-plugin
```

To get a runtime to develop against, use the
[Starter Kit](https://github.com/drumee/starter-kit).

## Built on

[`@drumee/server-core`](https://github.com/drumee/server-core) and
[`@drumee/server-essentials`](https://github.com/drumee/server-essentials).

## Contributing

See the org [CONTRIBUTING guide](https://github.com/drumee/.github/blob/main/CONTRIBUTING.md).
Questions: [Discussions](https://github.com/orgs/drumee/discussions).

## License

Apache-2.0 — see [LICENSE](LICENSE).
