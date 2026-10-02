// leakfix:allow-file: every secret in this file is a fake demo value.
//
// Runs the real leakfix CLI against the simulated Atlas + Vercel from the tests,
// so the README demo can show a full rotation (and a rollback) without touching
// any real account. Used by docs/demo.tape.
//
//   node --import tsx scripts/demo.ts setup     # fresh demo repo in $LEAKFIX_DEMO_DIR
//   node --import tsx scripts/demo.ts <leakfix arguments>
//
// The simulated cloud is saved between runs, and the first redeploy fails on purpose.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeCloud, type FakeState } from "../test/fake-cloud.js";

const DIR = process.env.LEAKFIX_DEMO_DIR ?? join(tmpdir(), "leakfix-demo", "my-api");
const STATE = join(DIR, "..", "cloud.json");

// Assembled at run time so secret scanners don't flag the demo values.
const URI = ["mongodb+srv://", "app", ":", "hunter2-from-2023", "@cluster0.ab12c.mongodb.net/app"].join("");
const ENV = {
  PORT: "3000",
  MONGODB_URI: URI,
  JWT_SECRET: "k3JqTz81mWQa0vLpXr5uNs2Qa",
  JWT_REFRESH_SECRET: "p9XbVh4cRt7LmEw2KyZd6Fg7w",
};

const { state, fetchImpl } = fakeCloud({ users: { app: "hunter2-from-2023" }, env: ENV });

if (process.argv[2] === "setup") {
  rmSync(join(DIR, ".."), { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", DIR, ...args], { stdio: "ignore" });
  git("init", "-q");
  writeFileSync(join(DIR, ".env"), Object.entries(ENV).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  writeFileSync(join(DIR, "index.js"), "require('dotenv').config();\n");
  writeFileSync(join(DIR, "leakfix.config.json"), JSON.stringify({
    vercel: { project: "my-api" }, atlas: { groupId: "g1" }, healthUrl: "https://app.example.com/api/health",
  }, null, 2) + "\n");
  git("add", ".");
  git("-c", "user.name=demo", "-c", "user.email=demo@example.com", "commit", "-qm", "first commit");
  state.failDeploys = 1;
  save();
  process.exit(0);
}

load();
process.on("exit", save);
process.env.LEAKFIX_VERCEL_TOKEN = "demo";
process.env.LEAKFIX_ATLAS_CLIENT_ID = "demo";
process.env.LEAKFIX_ATLAS_CLIENT_SECRET = "demo";

// Real APIs take a moment; a deploy takes a few seconds.
const pause = (url: string, method: string) =>
  url.includes("/v13/deployments") && method === "POST" ? 2500
    : url.includes("/databaseUsers") && method !== "GET" ? 700
    : 120;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  await new Promise((r) => setTimeout(r, pause(String(input), (init?.method ?? "GET").toUpperCase())));
  return fetchImpl(input, init);
}) as typeof fetch;

await import("../src/cli.js");

function save() {
  writeFileSync(STATE, JSON.stringify({
    ...state,
    atlasUsers: [...state.atlasUsers],
    env: [...state.env],
    sensitive: [...state.sensitive],
  }));
}

function load() {
  if (!existsSync(STATE)) throw new Error("Run `scripts/demo.ts setup` first");
  const s = JSON.parse(readFileSync(STATE, "utf8"));
  Object.assign(state, s, {
    atlasUsers: new Map(s.atlasUsers),
    env: new Map(s.env),
    sensitive: new Set(s.sensitive),
  } satisfies Partial<FakeState>);
}
