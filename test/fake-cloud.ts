// In-memory MongoDB Atlas + Vercel, enough of both APIs for leakfix's calls.
// Lets the tests run whole rotations, including failures and rollbacks.

export interface FakeState {
  atlasUsers: Map<string, { roles: unknown[]; password: string }>;
  env: Map<string, { id: string; key: string; value: string; target: string[] }>;
  deployments: { id: string; state: string; errorCode?: string; gitSource?: GitSource }[];
  /** Body of every deploy request leakfix sent. */
  deployRequests: Record<string, unknown>[];
  /** Make the next N redeploys fail. */
  failDeploys: number;
  healthy: boolean;
  /** Variable names whose values the fake API hides (Vercel "sensitive" type). */
  sensitive: Set<string>;
  calls: string[];
  /** Atlas answers 403 "IP address … is not allowed" for this caller IP. */
  atlasBlockedIp?: string;
}

interface GitSource { type: string; repoId: number; ref: string; sha: string }
const GIT: GitSource = { type: "github", repoId: 4242, ref: "main", sha: "abc123" };

export function fakeCloud(init: { users: Record<string, string>; env: Record<string, string> }) {
  const state: FakeState = {
    atlasUsers: new Map(Object.entries(init.users).map(([u, p]) => [u, { roles: [{ roleName: "readWrite", databaseName: "app" }], password: p }])),
    env: new Map(Object.entries(init.env).map(([k, v], i) => [k, { id: `env${i}`, key: k, value: v, target: ["production"] }])),
    // Production was built from GitHub, like most Vercel projects.
    deployments: [{ id: "dpl_0", state: "READY", gitSource: GIT }],
    deployRequests: [],
    failDeploys: 0,
    healthy: true,
    sensitive: new Set(),
    calls: [],
  };

  const json = (body: unknown, status = 200) =>
    status === 204
      ? new Response(null, { status })
      : new Response(body === undefined ? "" : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body).startsWith("{") ? String(init.body) : "{}") : {};
    state.calls.push(`${method} ${url.hostname}${url.pathname}`);

    // ---- Atlas
    if (url.hostname === "cloud.mongodb.com") {
      if (url.pathname === "/api/oauth/token") return json({ access_token: "tok", expires_in: 3600 });
      if (state.atlasBlockedIp) return json({ detail: `IP address ${state.atlasBlockedIp} is not allowed to access this resource.` }, 403);
      if (url.pathname === "/api/atlas/v2/groups") return json({ results: [{ id: "g0", name: "playground" }, { id: "g1", name: "collabify" }] });
      const clusters = /\/groups\/([^/]+)\/clusters$/.exec(url.pathname);
      if (clusters) {
        const results = clusters[1] === "g1"
          ? [{ name: "Cluster0", connectionStrings: { standardSrv: "mongodb+srv://cluster0.ab12c.mongodb.net" } }]
          : [{ name: "Sandbox", connectionStrings: { standardSrv: "mongodb+srv://sandbox.zz99.mongodb.net" } }];
        return json({ results });
      }
      const one = /\/groups\/[^/]+\/databaseUsers\/admin\/([^/]+)$/.exec(url.pathname);
      if (one) {
        const name = decodeURIComponent(one[1]!);
        const user = state.atlasUsers.get(name);
        if (!user) return json({ detail: `user ${name} not found` }, 404);
        if (method === "GET") return json({ username: name, databaseName: "admin", groupId: "g1", roles: user.roles });
        if (method === "DELETE") { state.atlasUsers.delete(name); return json(undefined, 204); }
      }
      if (/\/groups\/[^/]+\/databaseUsers$/.test(url.pathname) && method === "POST") {
        if (state.atlasUsers.has(body.username)) return json({ detail: "user exists" }, 409);
        state.atlasUsers.set(body.username, { roles: body.roles, password: body.password });
        return json({ ...body, password: undefined }, 201);
      }
    }

    // ---- Vercel
    if (url.hostname === "api.vercel.com") {
      if (url.pathname === "/v2/user") return json({ user: { username: "safayet404" } });
      if (url.pathname === "/v2/teams") return json({ teams: [] });
      if (url.pathname === "/v9/projects") {
        return json({ projects: [
          { id: "prj_1", name: "portfolio", link: { type: "github", org: "safayet404", repo: "svelte-portfolio" } },
          { id: "prj_2", name: "collabify-backend", link: { type: "github", org: "safayet404", repo: "collabify-backend" } },
        ] });
      }
      if (/\/v9\/projects\/[^/]+\/domains$/.test(url.pathname)) {
        return json({ domains: [{ name: "www.app.example.com", redirect: "app.example.com" }, { name: "app.example.com", redirect: null }] });
      }
      if (/\/v10\/projects\/[^/]+\/env$/.test(url.pathname)) {
        // "sensitive" variables come back without their value, like the real API
        return json({ envs: [...state.env.values()].map((e) => (state.sensitive.has(e.key) ? { ...e, value: undefined, type: "sensitive" } : e)) });
      }
      const envOne = /\/v9\/projects\/[^/]+\/env\/([^/]+)$/.exec(url.pathname);
      if (envOne && method === "PATCH") {
        const e = [...state.env.values()].find((x) => x.id === envOne[1]);
        if (!e) return json({ error: { message: "env not found" } }, 404);
        e.value = body.value;
        return json(e);
      }
      if (url.pathname === "/v7/deployments") {
        const ready = [...state.deployments].reverse().find((d) => d.state === "READY");
        return json({ deployments: ready ? [{ uid: ready.id, url: "app.vercel.app" }] : [] });
      }
      if (url.pathname === "/v13/deployments" && method === "POST") {
        const id = `dpl_${state.deployments.length}`;
        state.deployRequests.push(body);
        // Like the real API: a redeploy of a git-built deployment that only names the old
        // deployment (no gitSource) fails with git_info_fail.
        const gitSource = body.gitSource as GitSource | undefined;
        if (!gitSource) {
          state.deployments.push({ id, state: "ERROR", errorCode: "git_info_fail" });
          return json({ id, readyState: "QUEUED" });
        }
        const fail = state.failDeploys > 0;
        if (fail) state.failDeploys--;
        state.deployments.push({ id, state: fail ? "ERROR" : "READY", gitSource });
        return json({ id, readyState: "QUEUED" });
      }
      const dep = /\/v13\/deployments\/([^/]+)$/.exec(url.pathname);
      if (dep) {
        const d = state.deployments.find((x) => x.id === dep[1]);
        return d ? json({ id: d.id, readyState: d.state, errorCode: d.errorCode, gitSource: d.gitSource }) : json({ error: { message: "not found" } }, 404);
      }
    }

    // ---- the app's health endpoint
    if (url.hostname === "api.ipify.org") return json({ ip: "203.0.113.7" });
    if (url.hostname === "app.example.com" && url.pathname !== "/api/health") return json({ error: "not found" }, 404);
    if (url.hostname === "app.example.com") return state.healthy ? json({ ok: true }) : json({ error: "db down" }, 503);

    return json({ error: `unmocked ${method} ${url}` }, 500);
  }) as typeof fetch;

  return { state, fetchImpl };
}
