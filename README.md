# leakfix

[![npm](https://img.shields.io/npm/v/leakfix)](https://www.npmjs.com/package/leakfix)
[![CI](https://github.com/safayet404/leakfix/actions/workflows/ci.yml/badge.svg)](https://github.com/safayet404/leakfix/actions/workflows/ci.yml)

**Leaked a secret? leakfix replaces it without taking your app down.**

![leakfix finds committed secrets, rolls back a failed rotation, then rotates them with zero downtime](docs/demo.gif)

<sub>Recorded against simulated MongoDB Atlas and Vercel APIs (<a href="scripts/demo.ts">scripts/demo.ts</a>); the first deploy fails on purpose to show the rollback.</sub>

Finding a leaked `.env` is the easy part. GitHub and others will tell you about
it, and some providers revoke the key on the spot, which takes your app down.
The hard part is the cleanup: mint a new credential, update the deployment,
redeploy, check the app still works, and only then kill the old one. leakfix does
that for you, and undoes everything if any step fails.

```
$ leakfix scan
Found 3 secret(s), 3 committed to git:
  ● .env:5   MONGODB_URI         mongodb+srv://app:••••••@cluster0.mongodb.net/app  ← committed to git
  ● .env:8   JWT_SECRET          k3J••••••Qa                                        ← committed to git
  ● .env:10  JWT_REFRESH_SECRET  p9X••••••7w                                        ← committed to git

$ leakfix rotate
Rotation plan: MONGODB_URI (MongoDB Atlas user app), JWT_SECRET, JWT_REFRESH_SECRET
  1. Create database user app-lf20261001 with the same roles as app
  2. Generate a new random JWT_SECRET
  3. Generate a new random JWT_REFRESH_SECRET
  4. Set MONGODB_URI on Vercel project api (production)
  5. Set JWT_SECRET on Vercel project api (production)
  6. Set JWT_REFRESH_SECRET on Vercel project api (production)
  7. Redeploy api to production and wait until it is ready
  8. Health check https://api.example.com/health
  9. Delete leaked database user app  (after everything above succeeded)
Dry run. Run again with --yes to execute.
```

## How a rotation stays safe

1. **New credential next to the old one.** For MongoDB, leakfix creates a new
   database user with the same roles, so both work for a moment.
2. **Switch.** It updates every affected environment variable, then does one redeploy.
3. **Verify.** It waits for the deployment to be ready and calls your health URL.
4. **Revoke.** Only then does it delete the leaked credential.

If anything fails before step 4, leakfix undoes the completed steps in reverse,
redeploys the previous configuration, and removes the credential it created.
Production never points at something that doesn't exist. If step 4 itself
fails, leakfix does **not** roll back to the leaked credential. It tells you what
to finish by hand.

Every step is written to `leakfix-audit.jsonl`. The log never contains secret values.

## How is this different from…

- **GitHub secret scanning, GitGuardian, TruffleHog, gitleaks** find leaks, and some
  providers revoke a leaked key on the spot. Neither replaces the credential in
  your deployment, so the app either stays exposed or goes down. leakfix is the
  step after the alert. (Its scanner is deliberately simple; keep using those tools
  to find leaks.)
- **Vault, Doppler, Infisical, AWS Secrets Manager** rotate secrets they manage, on a
  schedule. If you already use one, you probably don't need leakfix. It is for the
  common case where secrets live in `.env` files and Vercel or Render environment
  variables, and you need to rotate *now*, safely, without adopting a new platform.

## Supported

| Secret | Rotation |
|---|---|
| MongoDB Atlas connection string | ✅ new database user, same roles; old user deleted |
| JWT signing secrets | ✅ new random secret (users sign in again) |
| SMTP passwords, other API keys | 📝 detected, with instructions to rotate by hand |

| Deployment | |
|---|---|
| Vercel | ✅ env vars + production redeploy (used on a real production app) |
| Render | ✅ env vars + deploy (rotation and rollback tested on a live Render service) |

See the [roadmap](#roadmap) for what's next.

## Setup

Needs Node.js 22 or newer. Nothing to install:

```bash
npx leakfix scan          # in your repo: which secrets are committed?
```

Or install it: `npm i -g leakfix`.

Then let leakfix find the rest:

```bash
npx leakfix init
```

```
✓ Committed secrets to rotate: MONGODB_URI, JWT_SECRET, JWT_REFRESH_SECRET
✓ Vercel token works (signed in as you)
✓ Vercel project: my-api (deploys you/my-api)
✓ Set for production on Vercel: MONGODB_URI, JWT_SECRET, JWT_REFRESH_SECRET
✓ Health check: https://my-api.vercel.app/health → 200
✓ Atlas project: my-project (cluster Cluster0)
✓ Atlas service account can manage database user app
Wrote ./leakfix.config.json (no secrets in it; safe to commit)
Ready. Next: leakfix rotate shows the plan; leakfix rotate --yes runs it.
```

`init` only reads. It finds the Vercel project from `.vercel/project.json` or the
git remote, the Atlas project from the cluster in your connection string, and a
health route on the project's domain. Anything missing comes with the exact
fix: where to create the token, which Atlas role to pick, and which IP range to
allow (a `/24`, so a home ISP changing your IP doesn't break it).

The config it writes looks like this, if you'd rather write it yourself:

```json
{
  "vercel": { "project": "my-api", "teamId": "team_xxx" },
  "atlas": { "groupId": "<Atlas project id>" },
  "healthUrl": "https://my-api.vercel.app/api/health"
}
```

On Render, use `"render": { "serviceId": "srv-..." }` instead of `"vercel"`.

Credentials come only from the environment, never from the repo:

| Variable | Where to get it | Needs |
|---|---|---|
| `LEAKFIX_VERCEL_TOKEN` | vercel.com/account/tokens | access to the project's team |
| `LEAKFIX_RENDER_API_KEY` | dashboard.render.com → Account Settings → API Keys | the service (instead of the Vercel token) |
| `LEAKFIX_ATLAS_CLIENT_ID` / `LEAKFIX_ATLAS_CLIENT_SECRET` | Atlas → Organization → Access Manager → Service Accounts | permission to manage database users in the project |

Then:

```bash
leakfix init                # find projects, check access, write leakfix.config.json
leakfix rotate              # dry run: prints the plan
leakfix rotate --yes        # do it
leakfix fix-repo            # stop tracking .env files, add .gitignore entries and .env.example
```

To mark a fake value as intentional, put `leakfix:allow` in a comment on the same
line, or `leakfix:allow-file` in the first lines of a file full of test fixtures.

`fix-repo` doesn't rewrite history. The old file stays in past commits,
which is why rotating is what actually protects you.

## Roadmap

Ordered by how often each one leaks and how much damage it does. Want one sooner,
or want to build one? Open an issue, or read [CONTRIBUTING.md](CONTRIBUTING.md):
a new deployment platform is one file.

**Deployments**
- [x] Vercel
- [x] Render
- [ ] Railway
- [ ] Netlify
- [ ] Fly.io

**Secrets**
- [x] MongoDB Atlas users
- [x] JWT signing secrets
- [ ] Stripe secret keys (Stripe can roll a key with an expiry for the old one)
- [ ] Resend / SendGrid API keys
- [ ] Postgres users on Neon and Supabase
- [ ] AWS access keys (IAM)

**Workflow**
- [ ] GitHub App: notices a pushed secret, asks "rotate?", then opens the clean-up PR
- [ ] Approval mode for teams: plan in a PR comment, rotate on approval
- [ ] Rotate several deployments that share a secret (e.g. API on Render, web on Vercel)

## Block leaks in pull requests

Add leakfix to any repo's CI. The check fails when a secret is committed, before it
reaches `main`:

```yaml
# .github/workflows/leakfix.yml
name: leakfix
on: [push, pull_request]
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: safayet404/leakfix@main
```

Or run it in Docker, with nothing to install:

```bash
docker build -t leakfix https://github.com/safayet404/leakfix.git
docker run --rm -v "$PWD:/repo" leakfix scan /repo
```

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) explains how
to add a deployment platform or a secret type, and how to test it without real accounts.

## Development

```bash
pnpm install
pnpm dev scan ../my-api   # run from source
pnpm test        # runs whole rotations against an in-memory Atlas + Vercel, including failures
pnpm typecheck
```

CI runs the tests on Node 22 and 24, builds the Docker image, and scans this
repo with it on every push.

Releases: bump `version` in package.json, then push a matching tag (`git tag v0.2.0 && git push --tags`).
CI publishes to npm through Trusted Publishing (no stored token, signed provenance) and creates the GitHub release.
