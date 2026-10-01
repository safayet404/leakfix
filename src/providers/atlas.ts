// MongoDB Atlas Administration API v2.
// Auth: a Service Account (OAuth 2.0 client credentials) with Project Owner
// (or a role that can manage database users) on the project.

import { request, type Fetch } from "./http.js";

const BASE = "https://cloud.mongodb.com";
const ACCEPT = "application/vnd.atlas.2023-01-01+json";

export interface DatabaseUser {
  username: string;
  databaseName: string;
  groupId: string;
  roles: { roleName: string; databaseName: string; collectionName?: string }[];
  scopes?: { name: string; type: string }[];
  labels?: { key: string; value: string }[];
  description?: string;
}

export interface AtlasCluster {
  name: string;
  connectionStrings?: { standardSrv?: string; standard?: string };
}

export class AtlasClient {
  private token?: { value: string; expires: number };

  constructor(
    private clientId: string,
    private clientSecret: string,
    private fetchImpl: Fetch = fetch,
  ) {}

  private async auth(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value;
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    const res = await request<{ access_token: string; expires_in: number }>(this.fetchImpl, "Atlas", `${BASE}/api/oauth/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: "grant_type=client_credentials",
    });
    this.token = { value: res.access_token, expires: Date.now() + res.expires_in * 1000 };
    return this.token.value;
  }

  private async call<T>(method: string, path: string, json?: unknown): Promise<T> {
    return request<T>(this.fetchImpl, "Atlas", `${BASE}/api/atlas/v2${path}`, {
      method,
      headers: { Authorization: `Bearer ${await this.auth()}`, Accept: ACCEPT, ...(json ? { "Content-Type": ACCEPT } : {}) },
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    });
  }

  /** Projects ("groups") the service account can see. */
  async listProjects(): Promise<{ id: string; name: string }[]> {
    return (await this.call<{ results: { id: string; name: string }[] }>("GET", "/groups?itemsPerPage=500")).results;
  }

  async listClusters(groupId: string): Promise<AtlasCluster[]> {
    return (await this.call<{ results: AtlasCluster[] }>("GET", `/groups/${groupId}/clusters?itemsPerPage=500`)).results;
  }

  getUser(groupId: string, username: string, databaseName = "admin") {
    return this.call<DatabaseUser>("GET", `/groups/${groupId}/databaseUsers/${databaseName}/${encodeURIComponent(username)}`);
  }

  createUser(user: DatabaseUser & { password: string }) {
    return this.call<DatabaseUser>("POST", `/groups/${user.groupId}/databaseUsers`, user);
  }

  deleteUser(groupId: string, username: string, databaseName = "admin") {
    return this.call<void>("DELETE", `/groups/${groupId}/databaseUsers/${databaseName}/${encodeURIComponent(username)}`);
  }
}

/** Split mongodb[+srv]://user:pass@host/... into its parts. */
export function parseMongoUri(uri: string) {
  const m = /^(mongodb(?:\+srv)?:\/\/)([^:]+):([^@]+)@(.+)$/.exec(uri);
  if (!m) throw new Error("Not a MongoDB connection string with credentials");
  return { scheme: m[1]!, username: decodeURIComponent(m[2]!), password: decodeURIComponent(m[3]!), rest: m[4]! };
}

export function buildMongoUri(parts: ReturnType<typeof parseMongoUri>, username: string, password: string) {
  return `${parts.scheme}${encodeURIComponent(username)}:${encodeURIComponent(password)}@${parts.rest}`;
}
