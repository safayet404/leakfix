// Vercel REST API: environment variables and redeploys.
// Auth: an access token with access to the project's team.

import { request, sleep, type Fetch } from "./http.js";

const BASE = "https://api.vercel.com";

export interface EnvVar {
  id: string;
  key: string;
  value?: string;
  target?: string[] | string;
  type: string;
}

export interface VercelProject {
  id: string;
  name: string;
  /** The Git repository the project deploys from, if any. */
  link?: { type?: string; org?: string; repo?: string };
}

interface Deployment {
  id: string;
  url?: string;
  readyState?: "QUEUED" | "BUILDING" | "ERROR" | "INITIALIZING" | "READY" | "CANCELED";
  errorCode?: string;
  errorMessage?: string;
  gitSource?: { type?: string; repoId?: number | string; ref?: string; sha?: string };
  target?: string | null;
}

export class VercelClient {
  constructor(
    private token: string,
    private teamId?: string,
    private fetchImpl: Fetch = fetch,
    private pollMs = 5000,
  ) {}

  private url(path: string, query: Record<string, string> = {}) {
    const q = new URLSearchParams({ ...query, ...(this.teamId ? { teamId: this.teamId } : {}) });
    const qs = q.toString();
    return `${BASE}${path}${qs ? `?${qs}` : ""}`;
  }

  private headers() {
    return { Authorization: `Bearer ${this.token}` };
  }

  /** Who the token belongs to: a cheap way to check that it works. */
  async user(): Promise<{ username: string }> {
    return (await request<{ user: { username: string } }>(this.fetchImpl, "Vercel", this.url("/v2/user"), { headers: this.headers() })).user;
  }

  async teams(): Promise<{ id: string; slug: string }[]> {
    return (await request<{ teams: { id: string; slug: string }[] }>(this.fetchImpl, "Vercel", this.url("/v2/teams"), { headers: this.headers() })).teams;
  }

  async projects(): Promise<VercelProject[]> {
    return (await request<{ projects: VercelProject[] }>(this.fetchImpl, "Vercel", this.url("/v9/projects", { limit: "100" }), { headers: this.headers() })).projects;
  }

  /** The project's own domains (not redirects), e.g. my-api.vercel.app. */
  async domains(project: string): Promise<string[]> {
    const res = await request<{ domains: { name: string; redirect?: string | null }[] }>(this.fetchImpl, "Vercel",
      this.url(`/v9/projects/${encodeURIComponent(project)}/domains`), { headers: this.headers() });
    return res.domains.filter((d) => !d.redirect).map((d) => d.name);
  }

  async listEnv(project: string): Promise<EnvVar[]> {
    const res = await request<{ envs: EnvVar[] }>(this.fetchImpl, "Vercel",
      this.url(`/v10/projects/${encodeURIComponent(project)}/env`, { decrypt: "true" }), { headers: this.headers() });
    return res.envs;
  }

  /** Production entries for a variable name (one key can have several targets). */
  async findEnv(project: string, key: string): Promise<EnvVar[]> {
    const all = await this.listEnv(project);
    return all.filter((e) => e.key === key && [e.target].flat().includes("production"));
  }

  async setEnv(project: string, envId: string, value: string): Promise<void> {
    await request(this.fetchImpl, "Vercel", this.url(`/v9/projects/${encodeURIComponent(project)}/env/${envId}`), {
      method: "PATCH", headers: this.headers(), json: { value },
    });
  }

  async latestProductionDeployment(project: string): Promise<Deployment> {
    const res = await request<{ deployments: (Deployment & { uid: string })[] }>(this.fetchImpl, "Vercel",
      this.url("/v7/deployments", { projectId: project, target: "production", state: "READY", limit: "1" }), { headers: this.headers() });
    const d = res.deployments[0];
    if (!d) throw new Error(`No ready production deployment found for ${project}`);
    return { id: d.uid, url: d.url };
  }

  /** Redeploy the current production deployment so it picks up new env values. */
  async redeploy(project: string): Promise<Deployment> {
    const latest = await this.latestProductionDeployment(project);
    const current = await request<Deployment>(this.fetchImpl, "Vercel", this.url(`/v13/deployments/${latest.id}`), { headers: this.headers() });
    // A deployment built from Git must be redeployed from the same commit: naming only the
    // old deployment makes Vercel fail with git_info_fail.
    const g = current.gitSource;
    const source = g?.type && g.repoId && g.sha
      ? { gitSource: { type: g.type, repoId: g.repoId, ref: g.ref, sha: g.sha } }
      : { deploymentId: latest.id };
    return request<Deployment>(this.fetchImpl, "Vercel", this.url("/v13/deployments", { forceNew: "1" }), {
      method: "POST", headers: this.headers(), json: { name: project, project, target: "production", ...source },
    });
  }

  async waitUntilReady(deploymentId: string, timeoutMs = 10 * 60_000): Promise<Deployment> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const d = await request<Deployment>(this.fetchImpl, "Vercel", this.url(`/v13/deployments/${deploymentId}`), { headers: this.headers() });
      if (d.readyState === "READY") return d;
      if (d.readyState === "ERROR" || d.readyState === "CANCELED") {
        const why = [d.errorCode, d.errorMessage].filter(Boolean).join(": ");
        throw new Error(`Deployment ${deploymentId} ended in ${d.readyState}${why ? ` (${why})` : ""}; build logs: https://vercel.com/deployments/${deploymentId}`);
      }
      await sleep(this.pollMs);
    }
    throw new Error(`Deployment ${deploymentId} was not ready after ${Math.round(timeoutMs / 60000)} min`);
  }
}
