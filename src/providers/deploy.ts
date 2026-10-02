// Where the app runs. A rotation needs three things from the platform: read the
// current value of a variable, set a new one, and redeploy once. Adding a
// platform means implementing DeployTarget (see CONTRIBUTING.md).

import type { Fetch } from "./http.js";
import { RenderClient } from "./render.js";
import { VercelClient } from "./vercel.js";

export interface EnvEntry {
  /** Platform id of this entry; one variable can have several (e.g. per environment). */
  id: string;
  /** Current value, if the platform reveals it. */
  value?: string;
}

export interface DeployTarget {
  /** Shown in plans, e.g. "Vercel project my-api". */
  name: string;
  /** The production entries for a variable name; empty if it isn't set. */
  findEnv(key: string): Promise<EnvEntry[]>;
  setEnv(key: string, entry: EnvEntry, value: string): Promise<void>;
  /** Redeploy production with the current variables and resolve once it serves traffic. */
  redeploy(): Promise<void>;
}

export function vercelTarget(token: string, project: string, teamId: string | undefined, fetchImpl: Fetch): DeployTarget {
  const vercel = new VercelClient(token, teamId, fetchImpl);
  return {
    name: `Vercel project ${project}`,
    findEnv: (key) => vercel.findEnv(project, key),
    setEnv: (_key, entry, value) => vercel.setEnv(project, entry.id, value),
    async redeploy() {
      const d = await vercel.redeploy(project);
      await vercel.waitUntilReady(d.id);
    },
  };
}

export function renderTarget(apiKey: string, serviceId: string, fetchImpl: Fetch): DeployTarget {
  const render = new RenderClient(apiKey, fetchImpl);
  return {
    name: `Render service ${serviceId}`,
    async findEnv(key) {
      const env = await render.listEnv(serviceId);
      return env.filter((e) => e.key === key).map((e) => ({ id: e.key, value: e.value }));
    },
    setEnv: (key, _entry, value) => render.setEnv(serviceId, key, value),
    async redeploy() {
      const d = await render.deploy(serviceId);
      await render.waitUntilLive(serviceId, d.id);
    },
  };
}
