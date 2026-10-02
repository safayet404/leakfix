// Turns findings into one rotation plan per deployment target.
//
// Zero-downtime order, the core idea of leakfix:
//   1. prepare    mint a NEW credential next to the leaked one (both work)
//   2. switch     point the app's environment at the new credential
//   3. redeploy   one production redeploy for all switched variables
//   4. verify     health check against the new deployment
//   5. revoke     delete the leaked credential (point of no return)
// If anything before step 5 fails, every completed step is undone and the app
// keeps running on the old credential.

import { randomBytes } from "node:crypto";

import type { Finding } from "../detect/scan.js";
import { mask } from "../detect/scan.js";
import { AtlasClient, buildMongoUri, parseMongoUri } from "../providers/atlas.js";
import { renderTarget, vercelTarget, type DeployTarget, type EnvEntry } from "../providers/deploy.js";
import { request, type Fetch } from "../providers/http.js";
import type { Plan, Step } from "./plan.js";

export interface Config {
  /** The deployment to update: exactly one of vercel or render. */
  vercel?: { project: string; teamId?: string };
  render?: { serviceId: string };
  atlas?: { groupId: string };
  /** Optional URL that returns 2xx only when the app (and its database) works. */
  healthUrl?: string;
}

export interface Credentials {
  vercelToken?: string;
  renderApiKey?: string;
  atlasClientId?: string;
  atlasClientSecret?: string;
}

/** A secret leakfix can rotate on its own. */
interface Rotation {
  envKey: string;
  /** The leaked value as found in the repo: the fallback for rollback when the
   *  platform won't reveal the current value (e.g. Vercel "sensitive" variables). */
  oldValue: string;
  label: string;
  prepare: Step;          // mints the new value
  newValue: () => string; // available after prepare ran
  revoke?: Step;          // removes the leaked credential
}

/** Something leakfix found but cannot rotate for you, with what to do instead. */
export interface ManualAction {
  finding: Finding;
  reason: string;
  howTo: string;
}

export interface Built {
  plans: Plan[];
  manual: ManualAction[];
}

const MANUAL_HOWTO: Record<string, string> = {
  "smtp-password": "Create a new app password with your email provider, delete the old one, and update the variable.",
  "vercel-token": "Delete the token at vercel.com/account/tokens and create a new one.",
  generic: "Revoke this credential where it was issued, create a new one, and update the variable.",
  "mongodb-uri": "Change the database user's password in MongoDB Atlas → Database Access, then update the variable.",
  "jwt-secret": "Generate a new random secret (e.g. `openssl rand -hex 32`) and update the variable; users will need to sign in again.",
};

function today() {
  return new Date().toISOString().slice(0, 10).replaceAll("-", "");
}

function mongoRotation(f: Finding, cfg: Config, atlas: AtlasClient): Rotation {
  const old = parseMongoUri(f.value);
  const newUser = `${old.username.replace(/-lf\d{8}(?:-\d+)?$/, "")}-lf${today()}`;
  const newPassword = randomBytes(24).toString("base64url");
  const groupId = cfg.atlas!.groupId;
  return {
    envKey: f.key!,
    oldValue: f.value,
    label: `${f.key} (MongoDB Atlas user ${old.username})`,
    newValue: () => buildMongoUri(old, newUser, newPassword),
    prepare: {
      title: `Create database user ${newUser} with the same roles as ${old.username}`,
      async run() {
        const current = await atlas.getUser(groupId, old.username);
        await atlas.createUser({
          groupId, databaseName: current.databaseName, username: newUser, password: newPassword,
          roles: current.roles, ...(current.scopes?.length ? { scopes: current.scopes } : {}),
          description: `Created by leakfix to replace leaked user ${old.username}`,
        });
      },
      undo: () => atlas.deleteUser(groupId, newUser),
    },
    revoke: {
      title: `Delete leaked database user ${old.username}`,
      run: () => atlas.deleteUser(groupId, old.username),
      final: true,
    },
  };
}

function jwtRotation(f: Finding): Rotation {
  const value = randomBytes(48).toString("base64url");
  return {
    envKey: f.key!,
    oldValue: f.value,
    label: `${f.key} (JWT signing secret)`,
    newValue: () => value,
    prepare: { title: `Generate a new random ${f.key}`, run: async () => {} },
    // Nothing to revoke: once the app runs with the new secret, tokens signed
    // with the leaked one stop verifying. Users sign in again.
  };
}

/** The configured deployment, or why there is none. */
export function deployTarget(cfg: Config, creds: Credentials, fetchImpl: Fetch = fetch): DeployTarget | string {
  if (cfg.vercel && cfg.render) return "both vercel and render are configured; leakfix updates one deployment at a time";
  if (cfg.vercel) {
    if (!creds.vercelToken) return "LEAKFIX_VERCEL_TOKEN is not set";
    return vercelTarget(creds.vercelToken, cfg.vercel.project, cfg.vercel.teamId, fetchImpl);
  }
  if (cfg.render) {
    if (!creds.renderApiKey) return "LEAKFIX_RENDER_API_KEY is not set";
    return renderTarget(creds.renderApiKey, cfg.render.serviceId, fetchImpl);
  }
  return "no deployment configured (set vercel or render in leakfix.config.json; `leakfix init` can find it)";
}

export function buildPlans(findings: Finding[], cfg: Config, creds: Credentials, fetchImpl: Fetch = fetch): Built {
  const manual: ManualAction[] = [];
  const target = deployTarget(cfg, creds, fetchImpl);
  const rotations: Rotation[] = [];
  const atlas = creds.atlasClientId && creds.atlasClientSecret
    ? new AtlasClient(creds.atlasClientId, creds.atlasClientSecret, fetchImpl) : undefined;

  // One finding per variable name (the same key often appears in .env and .env.local).
  const seen = new Set<string>();
  for (const f of findings) {
    const id = f.key ?? f.value;
    if (seen.has(id)) continue;
    seen.add(id);
    const howTo = MANUAL_HOWTO[f.kind] ?? MANUAL_HOWTO.generic!;

    if (!f.key) {
      manual.push({ finding: f, reason: "secret is written directly in code, not in an environment variable", howTo: `Move it to an environment variable, then: ${howTo}` });
    } else if (typeof target === "string") {
      manual.push({ finding: f, reason: target, howTo });
    } else if (f.kind === "mongodb-uri") {
      if (!atlas || !cfg.atlas) manual.push({ finding: f, reason: "no MongoDB Atlas access configured", howTo });
      else rotations.push(mongoRotation(f, cfg, atlas));
    } else if (f.kind === "jwt-secret") {
      rotations.push(jwtRotation(f));
    } else {
      manual.push({ finding: f, reason: `leakfix cannot rotate ${f.kind} credentials automatically yet`, howTo });
    }
  }

  if (!rotations.length || typeof target === "string") return { plans: [], manual };

  const steps: Step[] = [];

  for (const r of rotations) steps.push(r.prepare);

  for (const r of rotations) {
    const previous: { entry: EnvEntry; value: string }[] = [];
    steps.push({
      title: `Set ${r.envKey} on ${target.name} (production)`,
      async run() {
        const entries = await target.findEnv(r.envKey);
        if (!entries.length) throw new Error(`${r.envKey} is not set for production on ${target.name}`);
        // Remember what to restore on rollback. Never restore an empty value:
        // if the platform hides the current one, use the leaked value from the repo.
        for (const e of entries) {
          const value = e.value || r.oldValue;
          if (!value) throw new Error(`Cannot read the current value of ${r.envKey}; refusing to change it without a way back`);
          previous.push({ entry: e, value });
        }
        for (const e of entries) await target.setEnv(r.envKey, e, r.newValue());
      },
      async undo() {
        for (const p of previous) await target.setEnv(r.envKey, p.entry, p.value);
      },
    });
  }

  let rolledBack = false;
  steps.push({
    title: `Redeploy ${target.name} to production and wait until it is ready`,
    run: () => target.redeploy(),
    // The env was restored by the previous steps' undo, which run after this
    // one; a fresh redeploy is triggered once at the end of the rollback.
    async undo() {
      rolledBack = true;
    },
  });

  if (cfg.healthUrl) {
    const url = cfg.healthUrl;
    steps.push({
      title: `Health check ${url}`,
      async run() {
        await request(fetchImpl, "Health check", url, { method: "GET" });
      },
    });
  }

  for (const r of rotations) if (r.revoke) steps.push(r.revoke);

  // Rollback tail. The first step's undo runs last, after every env variable is
  // restored: redeploy first (so production is back on the old credential),
  // and only then delete the credential minted in step 1.
  const first = steps[0]!;
  const originalUndo = first.undo;
  first.undo = async () => {
    if (rolledBack) await target.redeploy();
    await originalUndo?.();
  };

  const label = rotations.map((r) => r.label).join(", ");
  return { plans: [{ target: label, steps }], manual };
}

export function describeFinding(f: Finding): string {
  return `${f.file}:${f.line}  ${f.key ?? "(inline)"}  ${mask(f.value)}${f.tracked ? "  ← committed to git" : ""}`;
}
