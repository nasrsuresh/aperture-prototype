// Thin HTTP client for the Aperture API.
import type { Config } from './config';

export interface ApiResult<T = unknown> {
  status: number;
  body: T;
  ms: number;
}

export async function api<T = unknown>(
  cfg: Config,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const t0 = Date.now();
  const res = await fetch(`${cfg.apiUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.apiKey,
      'x-org-id': cfg.orgId,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* non-JSON error bodies from API Gateway stay as text */
  }
  return { status: res.status, body: parsed as T, ms: Date.now() - t0 };
}

export function print(label: string, r: ApiResult): void {
  console.log(`${label} -> ${r.status} (${r.ms} ms)`);
  console.log(typeof r.body === 'string' ? r.body : JSON.stringify(r.body, null, 2));
}
