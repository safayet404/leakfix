#!/usr/bin/env node
// leakfix: rotate leaked secrets without downtime.
//
//   leakfix scan [dir]                  find secrets and whether git tracks them
//   leakfix rotate [dir]                show the rotation plan (dry run)
//   leakfix rotate [dir] --yes          run it
//   leakfix fix-repo [dir]              untrack .env files, ignore them, add .env.example
//
// Credentials come from the environment, never from the repo:
//   LEAKFIX_VERCEL_TOKEN, LEAKFIX_ATLAS_CLIENT_ID, LEAKFIX_ATLAS_CLIENT_SECRET
// Project settings live in leakfix.config.json (see README).

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { scanRepo } from "./detect/scan.js";
import { execute } from "./engine/plan.js";
import { fixRepo } from "./engine/repo.js";
import { buildPlans, describeFinding, type Config } from "./engine/rotations.js";

const c = {
  red: (s: string) => `\x1b[31m${s}\x1b[0m`, green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`, dim: (s: string) => `\x1b[2m${s}\x1b[0m`, bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

function loadConfig(root: string, path?: string): Config {
  const file = path ? resolve(path) : join(root, "leakfix.config.json");
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, "utf8")) as Config;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      yes: { type: "boolean", short: "y", default: false },
      config: { type: "string", short: "c" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command = "scan", dir = "."] = positionals;
  const root = resolve(dir);

  if (values.help || !["scan", "rotate", "fix-repo"].includes(command)) {
    console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 13).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    return;
  }

  const findings = scanRepo(root);
  const leaked = findings.filter((f) => f.tracked);

  if (command === "scan") {
    if (!findings.length) return console.log(c.green("No secrets found."));
    console.log(c.bold(`Found ${findings.length} secret(s), ${leaked.length} committed to git:\n`));
    for (const f of findings) console.log(`  ${f.tracked ? c.red("●") : c.dim("○")} ${describeFinding(f)}  ${c.dim(f.kind)}`);
    if (leaked.length) {
      console.log(`\n${c.red("Committed secrets must be treated as leaked, even after you delete the file.")}`);
      console.log(`Next: ${c.bold("leakfix rotate")} to replace them, then ${c.bold("leakfix fix-repo")} to stop tracking .env files.`);
    }
    process.exitCode = leaked.length ? 1 : 0;
    return;
  }

  if (command === "fix-repo") {
    const fix = fixRepo(root, findings);
    if (!fix.untracked.length) return console.log(c.green("No tracked .env files."));
    console.log(`Stopped tracking: ${fix.untracked.join(", ")}`);
    if (fix.gitignoreAdded.length) console.log(`Added to .gitignore: ${fix.gitignoreAdded.join(" ")}`);
    if (fix.example) console.log(`Created ${fix.example} (variable names only)`);
    console.log(c.yellow("\nThe files stay in your git history. Rotating the secrets (leakfix rotate) is what actually protects you."));
    console.log(`Review with ${c.bold("git status")}, then commit and push.`);
    return;
  }

  // rotate
  const cfg = loadConfig(root, values.config);
  const { plans, manual } = buildPlans(leaked, cfg, {
    vercelToken: process.env.LEAKFIX_VERCEL_TOKEN,
    atlasClientId: process.env.LEAKFIX_ATLAS_CLIENT_ID,
    atlasClientSecret: process.env.LEAKFIX_ATLAS_CLIENT_SECRET,
  });

  if (!leaked.length) return console.log(c.green("No committed secrets to rotate."));
  for (const plan of plans) {
    console.log(c.bold(`\nRotation plan: ${plan.target}`));
    plan.steps.forEach((s, i) => console.log(`  ${i + 1}. ${s.title}${s.final ? c.dim("  (after everything above succeeded)") : ""}`));
  }
  if (manual.length) {
    console.log(c.bold(`\nNeeds you (${manual.length}):`));
    for (const m of manual) console.log(`  ${c.yellow("!")} ${describeFinding(m.finding)}\n    ${c.dim(m.reason)}\n    → ${m.howTo}`);
  }
  if (!plans.length) return;
  if (!values.yes) {
    console.log(c.dim(`\nDry run. Run again with --yes to execute.`));
    return;
  }

  const auditFile = join(root, "leakfix-audit.jsonl");
  let failed = false;
  for (const plan of plans) {
    console.log(c.bold(`\nRotating: ${plan.target}`));
    const result = await execute(plan, (e) => {
      appendFileSync(auditFile, JSON.stringify(e) + "\n");
      const mark = { ok: c.green("✓"), failed: c.red("✗"), undone: c.yellow("↺"), "undo-failed": c.red("‼"), skipped: c.dim("–") }[e.status];
      console.log(`  ${mark} ${e.step}${e.error ? c.dim(`  (${e.error})`) : ""}`);
    });
    if (!result.ok && result.rolledBack) {
      failed = true;
      console.log(c.red(`  Rotation rolled back. Production is still on the previous credentials.`));
    } else if (!result.ok) {
      failed = true;
      console.log(c.yellow(`  Production now uses the new credentials, but: ${result.error}`));
    } else {
      console.log(c.green(`  Done. The leaked credentials no longer work.`));
    }
  }
  console.log(c.dim(`\nAudit log: ${auditFile} (contains no secret values)`));
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error(c.red(err instanceof Error ? err.message : String(err)));
  process.exitCode = 2;
});
