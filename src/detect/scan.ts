import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";

import { PLACEHOLDER, RULES, type SecretKind } from "./rules.js";

export interface Finding {
  kind: SecretKind;
  file: string;
  line: number;
  /** Variable name for KEY=value findings; undefined for bare connection strings. */
  key?: string;
  value: string;
  /** Whether git tracks the file (i.e. the secret is or will be pushed). */
  tracked: boolean;
}

/** Put this in a comment on a line to tell leakfix the value is intentional (test fixtures, docs). */
export const ALLOW = "leakfix:allow";
/** In the first lines of a file: skip the whole file (test fixtures full of fake secrets). */
export const ALLOW_FILE = "leakfix:allow-file";

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

function unquote(raw: string): string {
  let v = raw.trim();
  const hash = v.search(/\s+#/);              // trailing comment on unquoted values
  if (!/^["']/.test(v) && hash >= 0) v = v.slice(0, hash);
  if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
  return v.trim();
}

/** Scan text (one file) for secrets. */
export function scanText(text: string, file: string, tracked = false): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((lineText, i) => {
    if (lineText.includes(ALLOW)) return;   // explicitly marked as a fake / intended value
    const env = ENV_LINE.exec(lineText);
    if (env) {
      const key = env[1]!;
      const value = unquote(env[2]!);
      if (!value || PLACEHOLDER.test(value)) return;
      const byValue = RULES.find((r) => r.value?.test(value));
      const byKey = RULES.find((r) => r.key?.test(key));
      const rule = byValue ?? byKey;
      if (rule) findings.push({ kind: rule.kind, file, line: i + 1, key, value, tracked });
      return;
    }
    // Connection strings can also sit in code or config files.
    for (const rule of RULES) {
      const m = rule.value?.exec(lineText);
      if (m) findings.push({ kind: rule.kind, file, line: i + 1, value: m[0], tracked });
    }
  });
  return findings;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

const SKIP = /(?:^|\/)(?:node_modules|\.git|dist|build|\.next|vendor)\//;
const LIKELY = /(?:^|\/)\.env(?:\.[\w.-]+)?$|\.(?:js|ts|mjs|cjs|json|ya?ml|toml|php|py|env)$/;

/**
 * Scan a git repository's tracked files plus any .env files lying around.
 * Untracked .env files are reported too (tracked=false) because they show
 * which secrets exist, but only tracked ones count as leaked.
 */
export function scanRepo(root: string): Finding[] {
  try {
    git(root, ["rev-parse", "--git-dir"]);
  } catch {
    throw new Error(`${root} is not a git repository. leakfix checks what git tracks; run it inside a repo (or \`git init\` first).`);
  }
  const tracked = new Set(git(root, ["ls-files"]).split("\n").filter(Boolean));
  // Untracked .env files, whether git-ignored or not.
  const untrackedEnv = [
    ...git(root, ["ls-files", "--others", "--exclude-standard"]).split("\n"),
    ...git(root, ["ls-files", "--others", "--ignored", "--exclude-standard"]).split("\n"),
  ].filter((f) => f && /(?:^|\/)\.env(?:\.[\w.-]+)?$/.test(f));

  const findings: Finding[] = [];
  for (const file of [...tracked, ...untrackedEnv]) {
    if (SKIP.test(file) || !LIKELY.test(file) || basename(file) === ".env.example") continue;
    const path = join(root, file);
    try {
      if (statSync(path).size > 1_000_000) continue;
      const text = readFileSync(path, "utf8");
      // A whole file of intentional fakes (test fixtures) can opt out near its top.
      if (text.split("\n", 5).some((l) => l.includes(ALLOW_FILE))) continue;
      findings.push(...scanText(text, file, tracked.has(file)));
    } catch { /* deleted or unreadable */ }
  }
  return findings;
}

/** Mask a secret for display: keep a hint of the start and end only. */
export function mask(value: string): string {
  const uri = /^(mongodb(?:\+srv)?:\/\/)([^:]+):[^@]+@(.+)$/.exec(value);
  if (uri) return `${uri[1]}${uri[2]}:••••••@${uri[3]}`;
  if (value.length <= 8) return "••••••";
  return `${value.slice(0, 3)}••••••${value.slice(-2)}`;
}
