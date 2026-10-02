// Render REST API: service environment variables and deploys.
// Auth: an API key from dashboard.render.com → Account Settings → API Keys.

import { request, sleep, type Fetch } from "./http.js";

const BASE = "https://api.render.com/v1";

export interface RenderService {
  id: string;
  name: string;
  /** e.g. https://github.com/owner/repo */
  repo?: string;
  serviceDetails?: { url?: string };
}

interface RenderDeploy {
  id: string;
  status: string;
}

const FAILED = ["build_failed", "update_failed", "canceled", "deactivated", "pre_deploy_failed"];

export class RenderClient {
  constructor(
    private apiKey: string,
    private fetchImpl: Fetch = fetch,
    private pollMs = 5000,
  ) {}

  private call<T>(path: string, init: RequestInit & { json?: unknown } = {}) {
    return request<T>(this.fetchImpl, "Render", `${BASE}${path}`, {
      ...init, headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" },
    });
  }

  async services(): Promise<RenderService[]> {
    const res = await this.call<{ service: RenderService }[]>("/services?limit=100");
    return res.map((r) => r.service);
  }

  async service(serviceId: string): Promise<RenderService> {
    return this.call<RenderService>(`/services/${serviceId}`);
  }

  /** The service's own variables (not ones inherited from environment groups). */
  async listEnv(serviceId: string): Promise<{ key: string; value: string }[]> {
    const res = await this.call<{ envVar: { key: string; value: string } }[]>(`/services/${serviceId}/env-vars?limit=100`);
    return res.map((r) => r.envVar);
  }

  async setEnv(serviceId: string, key: string, value: string): Promise<void> {
    await this.call(`/services/${serviceId}/env-vars/${encodeURIComponent(key)}`, { method: "PUT", json: { value } });
  }

  async deploy(serviceId: string): Promise<RenderDeploy> {
    return this.call<RenderDeploy>(`/services/${serviceId}/deploys`, { method: "POST", json: { clearCache: "do_not_clear" } });
  }

  async waitUntilLive(serviceId: string, deployId: string, timeoutMs = 15 * 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const d = await this.call<RenderDeploy>(`/services/${serviceId}/deploys/${deployId}`);
      if (d.status === "live") return;
      if (FAILED.includes(d.status)) {
        throw new Error(`Deploy ${deployId} ended as ${d.status}; logs: https://dashboard.render.com/web/${serviceId}/deploys/${deployId}`);
      }
      await sleep(this.pollMs);
    }
    throw new Error(`Deploy ${deployId} was not live after ${Math.round(timeoutMs / 60000)} min`);
  }
}
