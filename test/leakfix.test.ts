// leakfix:allow-file: every secret in this file is a fake test fixture.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { mask, scanRepo, scanText, type Finding } from "../src/detect/scan.js";
import { execute } from "../src/engine/plan.js";
import { fixRepo } from "../src/engine/repo.js";
import { buildPlans } from "../src/engine/rotations.js";
import { fakeCloud } from "./fake-cloud.js";

// Fake credentials, assembled at runtime so secret scanners (GitHub, gitleaks)
// don't flag the fixture as a real leaked connection string.
const LEAKED_URI = ["mongodb+srv://", "collabify", ":", "S3cretPass", "@cluster0.ab12c.mongodb.net/collabify?retryWrites=true"].join("");
const ENV = `PORT=5000
MONGODB_URI=${LEAKED_URI}
JWT_SECRET=leakedjwtsecret123
JWT_REFRESH_SECRET="leakedrefresh456"
SMTP_PASS=gmailapppass
CLIENT_URL=http://localhost:3000
API_KEY=changeme
`;

const leaked = (): Finding[] => scanText(ENV, ".env", true);

describe("detection", () => {
  it("finds the secrets in a leaked .env and ignores ordinary values and placeholders", () => {
    const kinds = leaked().map((f) => `${f.key}:${f.kind}`);
    expect(kinds).toEqual([
      "MONGODB_URI:mongodb-uri",
      "JWT_SECRET:jwt-secret",
      "JWT_REFRESH_SECRET:jwt-secret",
      "SMTP_PASS:smtp-password",
    ]);
  });

  it("finds connection strings written directly in code", () => {
    const f = scanText(`mongoose.connect("${LEAKED_URI}")`, "src/db.js", true);
    expect(f).toHaveLength(1);
    expect(f[0]!.key).toBeUndefined();
  });

  it("skips lines marked leakfix:allow", () => {
    expect(scanText(`JWT_SECRET=fake_but_long_value # leakfix:allow`, ".env", true)).toHaveLength(0);
  });

  it("never shows the password when masking", () => {
    expect(mask(LEAKED_URI)).not.toContain("S3cretPass");
    expect(mask("leakedjwtsecret123")).not.toContain("jwtsecret");
  });
});

const cfg = { vercel: { project: "collabify-backend" }, atlas: { groupId: "g1" }, healthUrl: "https://app.example.com/api/health" };
const creds = { vercelToken: "v", atlasClientId: "id", atlasClientSecret: "secret" };

function setup() {
  return fakeCloud({
    users: { collabify: "S3cretPass" },
    env: { MONGODB_URI: LEAKED_URI, JWT_SECRET: "leakedjwtsecret123", JWT_REFRESH_SECRET: "leakedrefresh456", SMTP_PASS: "gmailapppass" },
  });
}

describe("rotation", () => {
  it("rotates MongoDB and JWT secrets with a single redeploy and revokes the leaked user", async () => {
    const { state, fetchImpl } = setup();
    const { plans, manual } = buildPlans(leaked(), cfg, creds, fetchImpl);

    expect(plans).toHaveLength(1);
    expect(manual.map((m) => m.finding.key)).toEqual(["SMTP_PASS"]);

    const result = await execute(plans[0]!);
    expect(result.ok).toBe(true);

    expect(state.atlasUsers.has("collabify")).toBe(false);                       // leaked user gone
    const newUser = [...state.atlasUsers.keys()][0]!;
    expect(newUser).toMatch(/^collabify-lf\d{8}$/);
    expect(state.atlasUsers.get(newUser)!.roles).toEqual([{ roleName: "readWrite", databaseName: "app" }]);

    const uri = state.env.get("MONGODB_URI")!.value;
    expect(uri).toContain(`${newUser}:`);
    expect(uri).toContain("@cluster0.ab12c.mongodb.net/collabify?retryWrites=true");
    expect(uri).not.toContain("S3cretPass");
    expect(state.env.get("JWT_SECRET")!.value).not.toBe("leakedjwtsecret123");
    expect(state.env.get("JWT_SECRET")!.value.length).toBeGreaterThanOrEqual(64);
    expect(state.env.get("SMTP_PASS")!.value).toBe("gmailapppass");             // left for the human

    expect(state.calls.filter((c) => c === "POST api.vercel.com/v13/deployments")).toHaveLength(1);
    // The leaked user is deleted only after the redeploy and the health check.
    const order = state.calls.map((c, i) => [c, i] as const);
    const deploy = order.find(([c]) => c === "POST api.vercel.com/v13/deployments")![1];
    const health = order.find(([c]) => c.includes("app.example.com"))![1];
    const revoke = order.find(([c]) => c.endsWith("/databaseUsers/admin/collabify") && c.startsWith("DELETE"))![1];
    expect(deploy).toBeLessThan(health);
    expect(health).toBeLessThan(revoke);
  });

  it("rolls everything back when the new deployment fails, and production stays on the old credentials", async () => {
    const { state, fetchImpl } = setup();
    state.failDeploys = 1;
    const result = await execute(buildPlans(leaked(), cfg, creds, fetchImpl).plans[0]!);

    expect(result.ok).toBe(false);
    expect(state.atlasUsers.has("collabify")).toBe(true);                        // leaked user untouched
    expect([...state.atlasUsers.keys()]).toEqual(["collabify"]);                 // new user cleaned up
    expect(state.env.get("MONGODB_URI")!.value).toBe(LEAKED_URI);                // env restored
    expect(state.env.get("JWT_SECRET")!.value).toBe("leakedjwtsecret123");
    expect(result.events.some((e) => e.status === "skipped" && e.step.startsWith("Delete leaked"))).toBe(true);
  });

  it("rolls back and redeploys the old config when the health check fails", async () => {
    const { state, fetchImpl } = setup();
    state.healthy = false;
    const result = await execute(buildPlans(leaked(), cfg, creds, fetchImpl).plans[0]!);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Health check 503/);
    expect(state.atlasUsers.has("collabify")).toBe(true);
    expect(state.atlasUsers.size).toBe(1);
    expect(state.env.get("MONGODB_URI")!.value).toBe(LEAKED_URI);
    // one redeploy for the rotation, one to return production to the old env
    expect(state.calls.filter((c) => c === "POST api.vercel.com/v13/deployments")).toHaveLength(2);
    // ...and that rollback redeploy happened before the new user was deleted
    const redeploys = state.calls.flatMap((c, i) => (c === "POST api.vercel.com/v13/deployments" ? [i] : []));
    const cleanup = state.calls.findIndex((c) => c.startsWith("DELETE") && c.includes("collabify-lf"));
    expect(redeploys[1]!).toBeLessThan(cleanup);
  });

  it("never rolls back to the leaked credential once the new one is live", async () => {
    const { state, fetchImpl } = setup();
    const plan = buildPlans(leaked(), cfg, creds, fetchImpl).plans[0]!;
    // Simulate Atlas refusing to delete the leaked user (e.g. a permission problem).
    const revoke = plan.steps.find((s) => s.title.startsWith("Delete leaked"))!;
    revoke.run = async () => { throw new Error("Atlas 403: not allowed"); };

    const result = await execute(plan);
    expect(result.ok).toBe(false);
    expect(result.rolledBack).toBe(false);
    expect(result.error).toMatch(/finish these by hand.*Delete leaked database user collabify/);
    expect(state.env.get("MONGODB_URI")!.value).not.toBe(LEAKED_URI);          // still on the new credential
    expect(result.events.some((e) => e.status === "undone")).toBe(false);
  });

  it("explains what it cannot do instead of guessing", () => {
    const { manual, plans } = buildPlans(leaked(), {}, {}, fetch);
    expect(plans).toHaveLength(0);
    expect(manual).toHaveLength(4);
    expect(manual[0]!.reason).toMatch(/no deployment configured/);
  });
});

describe("repository clean-up", () => {
  it("untracks .env, ignores it, and writes an .env.example with names only", () => {
    const dir = mkdtempSync(join(tmpdir(), "leakfix-"));
    const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore" });
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(dir, ".env"), ENV);
    writeFileSync(join(dir, "index.js"), "console.log(1)\n");
    git("add", ".");
    git("commit", "-qm", "init");

    const findings = scanRepo(dir);
    expect(findings.filter((f) => f.tracked)).toHaveLength(4);

    const fix = fixRepo(dir, findings);
    expect(fix.untracked).toEqual([".env"]);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain(".env");
    const example = readFileSync(join(dir, ".env.example"), "utf8");
    expect(example).toContain("MONGODB_URI=\n");
    expect(example).not.toContain("S3cretPass");
    expect(existsSync(join(dir, ".env"))).toBe(true);                            // file kept on disk
    expect(scanRepo(dir).filter((f) => f.tracked)).toHaveLength(0);
  });
});
