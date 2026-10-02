# Contributing to leakfix

Thanks for helping. leakfix changes production credentials, so the bar is: every
change is tested, including what happens when it fails halfway.

## Setup

```bash
git clone https://github.com/safayet404/leakfix && cd leakfix
pnpm install
pnpm test        # whole rotations against a simulated Atlas, Vercel and Render
pnpm typecheck
pnpm dev scan .  # run the CLI from source
```

Node.js 22 or newer. No cloud accounts are needed: the tests run against
`test/fake-cloud.ts`, an in-memory imitation of each API leakfix calls.

## How a rotation is built

```
src/detect/        find secrets in a repo (rules.ts: what a secret looks like)
src/engine/
  rotations.ts     turns findings into a plan of steps
  plan.ts          runs the steps; on failure, undoes completed steps in reverse
  init.ts          `leakfix init`: finds projects, checks access
src/providers/     one file per service API (Atlas, Vercel, Render)
  deploy.ts        the DeployTarget interface every deployment platform implements
```

Every plan has the same shape: **prepare** a new credential next to the leaked
one, **set** it on the deployment, **redeploy once**, **health-check**, and only
then **revoke** the leaked one. Each step except the last has an `undo`. Once the
revoke step starts there is no rollback: going back would mean going back to a
leaked credential.

## Adding a deployment platform (Railway, Netlify, Fly.io…)

A platform only has to do three things. Look at `renderTarget` in
`src/providers/deploy.ts` for a complete example.

1. **API client**: `src/providers/<platform>.ts`. Use `request()` from `http.ts`;
   it turns API errors into readable messages that never include secret values.
2. **DeployTarget**: in `deploy.ts`, implement
   - `findEnv(key)`: the production entries of a variable, with the current value if the API returns it
   - `setEnv(key, entry, value)`
   - `redeploy()`: start one deploy and resolve only when it serves traffic; throw if it fails
3. **Config and credentials**: add the platform to `Config` and `Credentials` in
   `rotations.ts`, to `deployTarget()` there, and its environment variable to
   `credentials()` in `cli.ts` (named `LEAKFIX_<PLATFORM>_...`).
4. **Fake API**: add the endpoints you call to `test/fake-cloud.ts`, including a
   way to make a deploy fail (`state.failDeploys`).
5. **Tests**, at least: a successful rotation with exactly one deploy; a failed
   deploy that restores every variable; a failed health check that restores the
   variables and redeploys them. Copy the `describe("Render")` block.
6. **`leakfix init`** (nice to have): find the service from the git remote and
   check that the variables exist. See `checkRender` in `init.ts`.
7. **README**: add a row to the deployment table and tick the roadmap.

Things to check in the platform's API docs before you start:
- Does updating a variable deploy on its own? leakfix wants one deploy for all variables.
- Does reading a variable return its value? If not, leakfix falls back to the
  leaked value from the repo when it has to restore it.
- How do you tell that a deploy is live, and that it failed?

## Adding a secret type (Stripe, Resend, Postgres…)

1. **Detection**: a rule in `src/detect/rules.ts`, with a test showing it finds
   the real format and ignores placeholders.
2. **Rotation**: a function like `mongoRotation` in `rotations.ts` that returns
   - `prepare`: creates the new credential (and `undo` deletes it)
   - `newValue()`: the value to put in the environment
   - `revoke`: deletes or expires the leaked credential, with `final: true`
3. **Fake API and tests**, as above. The test that matters most: when a deploy or
   health check fails, the new credential is deleted and the leaked one still works.

## Rules for pull requests

- Never print, log or put a secret value in an error message. Use `mask()` for display.
- Test fixtures that look like secrets: build them at run time (see
  `LEAKED_URI` in the tests) and mark the file with `leakfix:allow-file`, so
  secret scanners don't flag them.
- Keep the zero-downtime order. Anything that revokes before the health check
  passes will not be merged.
- `pnpm typecheck && pnpm test` must pass; CI runs both on Node 22 and 24.

## Reporting a security problem

Please don't open a public issue for a vulnerability in leakfix. Use GitHub's
**Report a vulnerability** button on the Security tab instead.
