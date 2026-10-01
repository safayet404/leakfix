// Stop tracking leaked env files: untrack them, ignore them, and leave an
// .env.example with the variable names only (never the values).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

import type { Finding } from "../detect/scan.js";

const ENV_FILE = /(?:^|\/)\.env(?:\.[\w.-]+)?$/;

export interface RepoFix {
  untracked: string[];
  gitignoreAdded: string[];
  example?: string;
}

function git(root: string, args: string[]) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function fixRepo(root: string, findings: Finding[]): RepoFix {
  const files = [...new Set(findings.filter((f) => f.tracked && ENV_FILE.test(f.file)).map((f) => f.file))];
  const result: RepoFix = { untracked: [], gitignoreAdded: [] };
  if (!files.length) return result;

  for (const file of files) {
    git(root, ["rm", "--cached", "--quiet", "--", file]);
    result.untracked.push(file);
  }

  const gi = join(root, ".gitignore");
  const current = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  const want = [".env", ".env.*", "!.env.example"].filter((p) => !current.split(/\r?\n/).includes(p));
  if (want.length) {
    appendFileSync(gi, `${current && !current.endsWith("\n") ? "\n" : ""}# secrets (added by leakfix)\n${want.join("\n")}\n`);
    result.gitignoreAdded = want;
  }

  const example = join(root, ".env.example");
  if (!existsSync(example)) {
    const keys = new Set<string>();
    for (const file of files) {
      for (const line of readFileSync(join(root, file), "utf8").split(/\r?\n/)) {
        const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
        if (m) keys.add(m[1]!);
      }
    }
    writeFileSync(example, [...keys].map((k) => `${k}=`).join("\n") + "\n");
    result.example = ".env.example";
  }
  git(root, ["add", "--", ".gitignore", ...(result.example ? [".env.example"] : [])]);
  return result;
}
