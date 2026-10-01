/** Small fetch wrapper: JSON in/out, readable errors that never include secrets. */
export class HttpError extends Error {
  constructor(public status: number, public service: string, message: string) {
    super(`${service} ${status}: ${message}`);
  }
}

export type Fetch = typeof fetch;

export async function request<T>(
  fetchImpl: Fetch,
  service: string,
  url: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> {
  const { json, headers, ...rest } = init;
  const res = await fetchImpl(url, {
    ...rest,
    headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const body = JSON.parse(text);
      detail = body.detail ?? body.error?.message ?? body.message ?? body.errorCode ?? detail;
    } catch { /* not JSON */ }
    throw new HttpError(res.status, service, String(detail));
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
