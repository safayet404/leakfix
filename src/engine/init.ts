// `leakfix init`: find everything a rotation needs, check that it works, and say
// exactly what to do about anything missing. Nothing here changes any service.

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import type { Finding } from "../detect/scan.js";
import { AtlasClient, parseMongoUri } from "../providers/atlas.js";
import { HttpError, request, type Fetch } from "../providers/http.js";
import { RenderClient } from "../providers/render.js";
import { VercelClient, type VercelProject } from "../providers/vercel.js";
import type { Config, Credentials } from "./rotations.js";

export interface Check {
  /** ok: works; warn: rotation can run, but read this; todo: must be fixed first. */
  status: "ok" | "warn" | "todo";
  label: string;
  fix?: string[];
}

export interface InitResult {
  checks: Check[];
  config: Config;
  ready: boolean;
}

export interface InitInput {
  root: string;
  /** Committed findings (the ones a rotation would act on). */
  leaked: Finding[];
  existing: Config;
  creds: Credentials;
  /** "owner/repo" of the git remote, used to find the Vercel project. */
  gitRepo?: string;
  fetchImpl?: Fetch;
}

const HEALTH_PATHS = ["/health", "/api/health", "/healthz", "/api/healthz"];

export async function init(input: InitInput): Promise<InitResult> {
  const { leaked, existing, creds, fetchImpl = fetch } = input;
  const checks: Check[] = [];
  const config: Config = structuredClone(existing);
  const done = () => ({ checks, config, ready: !checks.some((c) => c.status === "todo") });

  const keys = [...new Set(leaked.filter((f) => f.key && (f.kind === "mongodb-uri" || f.kind === "jwt-secret")).map((f) => f.key!))];
  const mongo = leaked.find((f) => f.key && f.kind === "mongodb-uri");
  if (!keys.length) {
    checks.push({ status: "ok", label: "No committed secrets that leakfix rotates automatically. `leakfix scan` lists everything it found." });
    return done();
  }
  checks.push({ status: "ok", label: `Committed secrets to rotate: ${keys.join(", ")}` });

  // Render when it's configured, or when only a Render key is available; Vercel otherwise.
  const render = config.render || (!config.vercel && creds.renderApiKey && !creds.vercelToken);
  if (render) await checkRender(checks, config, keys, input, fetchImpl);
  else await checkVercel(checks, config, keys, input, fetchImpl);
  if (mongo) await checkAtlas(checks, config, mongo, creds, fetchImpl);
  return done();
}

async function checkVercel(checks: Check[], config: Config, keys: string[], input: InitInput, fetchImpl: Fetch) {
  const { root, creds, gitRepo } = input;
  if (!creds.vercelToken) {
    checks.push({
      status: "todo", label: "No Vercel token (LEAKFIX_VERCEL_TOKEN)",
      fix: [
        "Create one at https://vercel.com/account/settings/tokens (an expiry of 1 day is enough).",
        `Then, in this terminal: ${hiddenExport("LEAKFIX_VERCEL_TOKEN")}`,
        `Deployed on Render instead? Create an API key at https://dashboard.render.com/u/settings#api-keys, then: ${hiddenExport("LEAKFIX_RENDER_API_KEY")}`,
      ],
    });
    return;
  }

  try {
    const me = await new VercelClient(creds.vercelToken, undefined, fetchImpl).user();
    checks.push({ status: "ok", label: `Vercel token works (signed in as ${me.username})` });
  } catch (err) {
    checks.push({ status: "todo", label: `Vercel rejected the token (${errText(err)})`, fix: ["Create a new one at https://vercel.com/account/settings/tokens"] });
    return;
  }

  // Which project? Config first, then the folder's `vercel link`, then the git remote.
  if (!config.vercel) {
    const found = linkedProject(root) ?? await projectForRepo(creds.vercelToken, gitRepo, basename(root), fetchImpl);
    if ("project" in found) {
      config.vercel = { project: found.project, ...(found.teamId ? { teamId: found.teamId } : {}) };
      checks.push({ status: "ok", label: `Vercel project: ${found.project}${found.via ? ` (${found.via})` : ""}` });
    } else {
      checks.push({
        status: "todo", label: "Could not tell which Vercel project deploys this repo",
        fix: [
          `Set "vercel": { "project": "<name>" } in leakfix.config.json${found.names.length ? `. Your projects: ${found.names.join(", ")}` : ""}`,
          "For a team project, add its \"teamId\" too.",
        ],
      });
      return;
    }
  } else {
    checks.push({ status: "ok", label: `Vercel project: ${config.vercel.project} (from leakfix.config.json)` });
  }

  const vercel = new VercelClient(creds.vercelToken, config.vercel.teamId, fetchImpl);
  const project = config.vercel.project;
  try {
    const missing = [];
    for (const key of keys) if (!(await vercel.findEnv(project, key)).length) missing.push(key);
    if (missing.length) {
      checks.push({
        status: "todo", label: `Not set for production on Vercel: ${missing.join(", ")}`,
        fix: [`leakfix replaces existing values. Add them under Project → Settings → Environment Variables (Production), or remove them from the rotation.`],
      });
    } else {
      checks.push({ status: "ok", label: `Set for production on Vercel: ${keys.join(", ")}` });
    }
  } catch (err) {
    checks.push({ status: "todo", label: `Cannot read ${project}'s environment variables (${errText(err)})`, fix: ["Check the project name and that the token can access its team."] });
    return;
  }

  let domains: string[] = [];
  if (!config.healthUrl) try { domains = await vercel.domains(project); } catch { /* fall through to the warning */ }
  await checkHealth(checks, config, domains, fetchImpl);
}

async function checkRender(checks: Check[], config: Config, keys: string[], input: InitInput, fetchImpl: Fetch) {
  const { creds, gitRepo } = input;
  if (!creds.renderApiKey) {
    checks.push({
      status: "todo", label: "No Render API key (LEAKFIX_RENDER_API_KEY)",
      fix: [
        "Create one at https://dashboard.render.com/u/settings#api-keys",
        `Then, in this terminal: ${hiddenExport("LEAKFIX_RENDER_API_KEY")}`,
      ],
    });
    return;
  }
  const render = new RenderClient(creds.renderApiKey, fetchImpl);

  // Which service? Config first, then the one that deploys this repo.
  let services;
  try {
    services = await render.services();
    checks.push({ status: "ok", label: "Render API key works" });
  } catch (err) {
    checks.push({ status: "todo", label: `Render rejected the API key (${errText(err)})`, fix: ["Create a new one at https://dashboard.render.com/u/settings#api-keys"] });
    return;
  }
  let service = config.render ? services.find((s) => s.id === config.render!.serviceId) : undefined;
  if (config.render) {
    checks.push(service
      ? { status: "ok", label: `Render service: ${service.name} (from leakfix.config.json)` }
      : { status: "todo", label: `The API key can't see Render service ${config.render.serviceId}`, fix: ["Check render.serviceId in leakfix.config.json (it starts with srv-)."] });
    if (!service) return;
  } else {
    const repo = (gitRepo ?? "").toLowerCase();
    const matches = repo ? services.filter((s) => s.repo?.toLowerCase().replace(/\.git$/, "").endsWith(`/${repo}`)) : [];
    if (matches.length !== 1) {
      checks.push({
        status: "todo", label: matches.length ? `Several Render services deploy ${gitRepo}` : "Could not tell which Render service deploys this repo",
        fix: [`Set "render": { "serviceId": "srv-..." } in leakfix.config.json. Your services: ${(matches.length ? matches : services).map((s) => `${s.name} (${s.id})`).slice(0, 15).join(", ")}`],
      });
      return;
    }
    service = matches[0]!;
    config.render = { serviceId: service.id };
    checks.push({ status: "ok", label: `Render service: ${service.name} (deploys ${gitRepo})` });
  }

  try {
    const env = await render.listEnv(service.id);
    const missing = keys.filter((k) => !env.some((e) => e.key === k));
    checks.push(missing.length
      ? { status: "todo", label: `Not set on the Render service: ${missing.join(", ")}`, fix: ["leakfix updates the service's own variables. Variables from an environment group must be rotated by hand for now."] }
      : { status: "ok", label: `Set on the Render service: ${keys.join(", ")}` });
  } catch (err) {
    checks.push({ status: "todo", label: `Cannot read the service's environment variables (${errText(err)})` });
    return;
  }

  const host = service.serviceDetails?.url?.replace(/^https?:\/\//, "").replace(/\/$/, "");
  await checkHealth(checks, config, host ? [host] : [], fetchImpl);
}

/** A health URL lets leakfix notice a broken deploy before revoking the old credential. */
async function checkHealth(checks: Check[], config: Config, domains: string[], fetchImpl: Fetch) {
  if (config.healthUrl) {
    const status = await probe(config.healthUrl, fetchImpl);
    checks.push(status && status < 300
      ? { status: "ok", label: `Health check: ${config.healthUrl} → ${status}` }
      : { status: "todo", label: `Health check ${config.healthUrl} answered ${status ?? "nothing"}`, fix: ["Fix the URL in leakfix.config.json, or remove healthUrl."] });
    return;
  }
  for (const domain of domains) {
    for (const path of HEALTH_PATHS) {
      const url = `https://${domain}${path}`;
      const status = await probe(url, fetchImpl);
      if (status && status < 300) {
        config.healthUrl = url;
        checks.push({
          status: "ok", label: `Health check: ${url} → ${status}`,
          fix: ["Make sure this route fails when the database is unreachable; otherwise it can't catch a bad credential."],
        });
        return;
      }
    }
  }
  checks.push({
    status: "warn", label: `No health URL found${domains.length ? ` on ${domains.join(", ")}` : ""}`,
    fix: [
      "Without one, leakfix only knows the deploy built, not that the app can reach its database.",
      "Add a route that pings the database, then set \"healthUrl\" in leakfix.config.json.",
    ],
  });
}

async function checkAtlas(checks: Check[], config: Config, mongo: Finding, creds: Credentials, fetchImpl: Fetch) {
  let parts: ReturnType<typeof parseMongoUri>;
  try { parts = parseMongoUri(mongo.value); } catch {
    checks.push({ status: "warn", label: `${mongo.key} has no username/password: nothing to rotate on Atlas` });
    return;
  }
  const host = parts.rest.split(/[/?]/)[0]!;
  if (!host.endsWith(".mongodb.net")) {
    checks.push({ status: "warn", label: `${mongo.key} points at ${host}, not MongoDB Atlas: rotate this one by hand` });
    return;
  }

  if (!creds.atlasClientId || !creds.atlasClientSecret) {
    const ip = await publicIp(fetchImpl);
    checks.push({
      status: "todo", label: "No MongoDB Atlas service account (LEAKFIX_ATLAS_CLIENT_ID / LEAKFIX_ATLAS_CLIENT_SECRET)",
      fix: [
        "Atlas → your organization → Applications → Service Accounts → Create service account.",
        `Give it the role "Project Database Access Admin" on the project that has the cluster ${host}.`,
        `Add this computer to its API Access List: ${ip ? `${range(ip)}  (your IP is ${ip}; the range survives it changing)` : "your public IP"}.`,
        `Then, in this terminal: export LEAKFIX_ATLAS_CLIENT_ID=<client id>; ${hiddenExport("LEAKFIX_ATLAS_CLIENT_SECRET")}`,
      ],
    });
    return;
  }

  const atlas = new AtlasClient(creds.atlasClientId, creds.atlasClientSecret, fetchImpl);
  let groupId = config.atlas?.groupId;
  try {
    if (!groupId) {
      for (const project of await atlas.listProjects()) {
        const clusters = await atlas.listClusters(project.id);
        const cluster = clusters.find((c) => [c.connectionStrings?.standardSrv, c.connectionStrings?.standard].some((s) => s?.includes(host)));
        if (cluster) {
          groupId = project.id;
          config.atlas = { groupId };
          checks.push({ status: "ok", label: `Atlas project: ${project.name} (cluster ${cluster.name})` });
          break;
        }
      }
      if (!groupId) {
        checks.push({
          status: "todo", label: `The service account can't see a project with the cluster ${host}`,
          fix: [`Give it the role "Project Database Access Admin" on that project (Atlas → Project → Project Settings → Applications).`],
        });
        return;
      }
    }
    await atlas.getUser(groupId, parts.username);
    checks.push({ status: "ok", label: `Atlas service account can manage database user ${parts.username}` });
  } catch (err) {
    checks.push(atlasProblem(err, parts.username));
  }
}

function atlasProblem(err: unknown, username: string): Check {
  const text = errText(err);
  const ip = /IP address ([\d.]+) is not allowed/.exec(text)?.[1];
  if (ip) {
    return {
      status: "todo", label: `Atlas blocks this computer's IP (${ip})`,
      fix: [`Add ${range(ip)} to the service account's API Access List (Organization → Applications → Service Accounts → your account). The range keeps working when your ISP changes your IP.`],
    };
  }
  if (err instanceof HttpError && err.status === 401) {
    return { status: "todo", label: "Atlas rejected the service account credentials", fix: ["Check LEAKFIX_ATLAS_CLIENT_ID / LEAKFIX_ATLAS_CLIENT_SECRET, or create a new secret for the service account."] };
  }
  if (err instanceof HttpError && err.status === 404) {
    return { status: "warn", label: `Atlas has no database user ${username}: it may already be deleted (then the leaked password is dead already)` };
  }
  if (err instanceof HttpError && err.status === 403) {
    return { status: "todo", label: `The service account may not manage database users (${text})`, fix: [`Give it "Project Database Access Admin" on the project (not "Project Data Access Admin").`] };
  }
  return { status: "todo", label: `Atlas: ${text}` };
}

/** `vercel link` leaves .vercel/project.json with the project and its owner. */
function linkedProject(root: string): { project: string; teamId?: string; via: string } | undefined {
  const file = join(root, ".vercel", "project.json");
  if (!existsSync(file)) return undefined;
  try {
    const { projectId, orgId } = JSON.parse(readFileSync(file, "utf8")) as { projectId?: string; orgId?: string };
    if (!projectId) return undefined;
    return { project: projectId, ...(orgId?.startsWith("team_") ? { teamId: orgId } : {}), via: ".vercel/project.json" };
  } catch { return undefined; }
}

/** Look through every project the token can see for one that deploys this repo. */
async function projectForRepo(token: string, gitRepo: string | undefined, folder: string, fetchImpl: Fetch):
  Promise<{ project: string; teamId?: string; via: string } | { names: string[] }> {
  const personal = new VercelClient(token, undefined, fetchImpl);
  const scopes: (string | undefined)[] = [undefined, ...(await personal.teams().catch(() => [])).map((t) => t.id)];
  const all: { p: VercelProject; teamId?: string }[] = [];
  for (const teamId of scopes) {
    const projects = await new VercelClient(token, teamId, fetchImpl).projects().catch(() => []);
    all.push(...projects.map((p) => ({ p, teamId })));
  }
  const pick = (hit: { p: VercelProject; teamId?: string } | undefined, via: string) =>
    hit && { project: hit.p.name, ...(hit.teamId ? { teamId: hit.teamId } : {}), via };

  const [org, repo] = (gitRepo ?? "").toLowerCase().split("/");
  const byRepo = repo ? all.filter(({ p }) => p.link?.repo?.toLowerCase() === repo && (!org || p.link?.org?.toLowerCase() === org)) : [];
  if (byRepo.length === 1) return pick(byRepo[0], `deploys ${gitRepo}`)!;
  const byName = all.filter(({ p }) => p.name.toLowerCase() === folder.toLowerCase());
  if (byName.length === 1) return pick(byName[0], "same name as this folder")!;
  return { names: all.map(({ p }) => p.name).slice(0, 15) };
}

async function probe(url: string, fetchImpl: Fetch): Promise<number | undefined> {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
    await res.body?.cancel();
    return res.status;
  } catch { return undefined; }
}

async function publicIp(fetchImpl: Fetch): Promise<string | undefined> {
  try { return (await request<{ ip: string }>(fetchImpl, "ipify", "https://api.ipify.org?format=json")).ip; } catch { return undefined; }
}

/** 113.212.108.26 → 113.212.108.0/24: home ISPs often move you within this range. */
const range = (ip: string) => `${ip.split(".").slice(0, 3).join(".")}.0/24`;

/** Reads a secret without echoing it or saving it in shell history (works in bash and zsh). */
const hiddenExport = (name: string) => `stty -echo; printf '${name}: '; read ${name}; stty echo; echo; export ${name}`;

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
